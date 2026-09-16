#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { loadConfig } from './lib/config.js';
import { check, UserError } from './lib/error.js';
import * as log from './lib/log.js';
import { sync } from './lib/sync.js';

async function run(options) {
  const config = await loadConfig(options.config);
  log.intro(config, options);

  const { skipped } = await sync(config, { ...options, reporter: log });

  log.summary(config.sources.length, skipped.map(({ source }) => source), options);
  return skipped.length > 0 ? 1 : 0;
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
