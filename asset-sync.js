#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { collectAssetRefs, groupByUrl } from './lib/assets.js';
import { loadConfig } from './lib/config.js';
import { check, UserError } from './lib/error.js';
import * as log from './lib/log.js';
import { downloadAssets, fetchJson, resolveAssets } from './lib/net.js';

async function run(options) {
  const config = await loadConfig(options.config);
  log.intro(config, options);

  const tempDir = await mkdtemp(path.join(tmpdir(), 'asset-sync-'));
  const skipped = [];

  try {
    for (const [index, source] of config.sources.entries()) {
      const updated = await syncSource(source, index, { config, tempDir, options });
      if (!updated) skipped.push(source);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  log.summary(config.sources.length, skipped, options);
  return skipped.length > 0 ? 1 : 0;
}

/**
 * Brings down one source's JSON and every asset it references, and writes them into the
 * project only once all of them have arrived intact. If any single thing fails, the source
 * is left exactly as it was on disk: old data that works beats new data that doesn't.
 */
async function syncSource(source, index, { config, tempDir, options }) {
  const staging = path.join(tempDir, String(index));
  const hasAssets = !options.jsonOnly && source.assetFields.length > 0;

  log.source(index + 1, config.sources.length, source.url);

  // 1. Read the JSON. Without it there is nothing to do for this source.
  let data;
  try {
    data = await fetchJson(source.url);
  } catch (error) {
    log.skipped([{ url: source.url, error }], source);
    return false;
  }

  // 2. Find the assets the JSON references
  const refs = collectAssetRefs(data, source.assetFields);

  for (const ref of refs) {
    ref.tempDir = path.join(staging, 'assets');
    ref.pathDir = source.assetsFolder; // relative to outputDir, and so to the JSON file landing there
  }

  const jobs = groupByUrl(refs);
  log.referenced(jobs.length);

  if (options.dryRun) {
    log.wouldWrite(jobs, source, hasAssets, options);
    return true;
  }

  // 3. Fetch every asset. One failure is enough to call the whole source off, but we let
  //    the rest finish first, so a single run reports everything that is broken.
  if (jobs.length > 0 && options.jsonOnly) {
    await resolveAssets(jobs, options.concurrency);
  } else if (jobs.length > 0) {
    const { failures, bytes } = await downloadAssets(jobs, options.concurrency, log.progress);

    if (failures.length > 0) {
      log.skipped(failures, source);
      return false;
    }

    log.downloaded(jobs.length, bytes);
  }

  // 4. Everything arrived, so it is safe to update the project
  await stage(staging, source, data, hasAssets);
  await publish(staging, source, hasAssets);
  log.written(source, hasAssets);

  return true;
}

/** Writes the rewritten JSON into the temp folder, beside the assets it now points at. */
async function stage(staging, source, data, hasAssets) {
  await mkdir(staging, { recursive: true });
  if (hasAssets) await mkdir(path.join(staging, 'assets'), { recursive: true });

  await writeFile(path.join(staging, source.outputFile), JSON.stringify(data, null, 2));
}

/** Moves a fully downloaded source into the project. */
async function publish(staging, source, hasAssets) {
  await mkdir(source.outputDir, { recursive: true });

  if (hasAssets) {
    // Replace the asset folder wholesale; leave everything else in outputDir alone
    await rm(source.assetPath, { recursive: true, force: true });
    await cp(path.join(staging, 'assets'), source.assetPath, { recursive: true });
  }

  await copyFile(path.join(staging, source.outputFile), source.outputPath);
}

// CLI

// The default config lives in process.cwd(), not next to this script — npm always runs
// scripts with cwd set to the invoking project's root, so this is what lets each project
// keep its own config under a plain `npm run` convention. A scheduler-invoked process (cron,
// Task Scheduler) has to either set its job's working directory explicitly or pass
// --config <absolute-path>, since its cwd otherwise can't be relied on.
const CONFIG_FILE = path.join(process.cwd(), 'asset-sync.config.json');

const USAGE = `
  Usage: asset-sync [options]

  Downloads JSON data sources and the assets they reference, rewriting the
  asset URLs in the JSON to point at the local copies.

  A source is only written to its output folder if every one of its assets
  downloads cleanly. If any fails, that source is left untouched and the run exits 1.

  The first run finds no config, so it writes a starter ${CONFIG_FILE}
  and stops, so you can point it at your data sources.

  Options:
    -c, --config <file>   Config file to read       (default: ${CONFIG_FILE})
    -j, --json-only       Skip assets, JSON only
    -n, --concurrency <n> Parallel downloads        (default: 8)
        --dry-run         Report without writing
    -h, --help            Show this message
    -v, --version         Show version
`;

const TEMPLATE = `{
  "outputDir": "c:/kiosk/content",
  "sources": [
    {
      "url": "https://example.com/api/content",
      "outputFile": "data.json",
      "assets": {
        "outputFolder": "assets",
        "fields": ["items.imagePath"]
      }
    }
  ]
}
`;

/**
 * The first run in a project has nothing to sync, so it leaves behind a config to fill in. Writing
 * exclusively is what makes that safe to attempt on every run: an existing config is never opened
 * for writing at all, so it cannot be clobbered by a race, a crash, or a full disk.
 */
async function scaffoldConfig(file) {
  try {
    await writeFile(file, TEMPLATE, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') return false; // already configured — get on with the sync
    throw error;
  }

  log.created(file);
  return true;
}

async function main() {
  let args;

  try {
    ({ values: args } = parseArgs({
      options: {
        config: { type: 'string', short: 'c', default: CONFIG_FILE },
        'json-only': { type: 'boolean', short: 'j', default: false },
        concurrency: { type: 'string', short: 'n', default: '8' },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false }
      }
    }));
  } catch (error) {
    throw new UserError(error.message);
  }

  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  if (args.version) {
    const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
    console.log(pkg.version);
    return 0;
  }

  const concurrency = Number(args.concurrency);
  check(
    Number.isInteger(concurrency) && concurrency > 0,
    `--concurrency must be a positive integer, got: ${args.concurrency}`
  );

  // Only the default config is scaffolded. A --config that names a missing file is a typo, and
  // deserves to be reported as one rather than answered with a starter config the user didn't ask for.
  const usingDefaultConfig = args.config === CONFIG_FILE;
  if (usingDefaultConfig && (await scaffoldConfig(path.resolve(CONFIG_FILE)))) return 0;

  return run({
    config: args.config,
    jsonOnly: args['json-only'],
    dryRun: args['dry-run'],
    concurrency
  });
}

// Run only when invoked directly, not when imported. argv[1] is resolved because npm installs
// this bin as a symlink, and the symlink path would never match this module's real path.
const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    process.exitCode = await main();
  } catch (error) {
    log.fatal(error, { verbose: !(error instanceof UserError) });
    process.exitCode = 1;
  }
}
