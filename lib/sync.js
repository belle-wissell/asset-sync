import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { collectAssetRefs, groupByUrl } from './assets.js';
import { normalizeConfig } from './config.js';
import { check } from './error.js';
import { downloadAssets, fetchJson, resolveAssets } from './net.js';

// Every hook sync() can call on its reporter. The CLI passes its log module here; library
// callers get silence. Deliberately undocumented: onProgress is the public progress API.
const SILENT = {
  source() {},
  referenced() {},
  wouldWrite() {},
  progress() {},
  downloaded() {},
  skipped() {},
  written() {}
};

/**
 * Syncs every source in `config`, one after another. Resolves with the caller's own source
 * objects, split into those written and those skipped (with what went wrong). A skipped source
 * is left exactly as it was on disk; only a bad config or an unexpected error rejects.
 */
export async function sync(config, { concurrency = 8, jsonOnly = false, dryRun = false, onProgress, reporter } = {}) {
  const { sources } = normalizeConfig(config);
  check(Number.isInteger(concurrency) && concurrency > 0, `concurrency must be a positive integer, got: ${concurrency}`);

  const report = { ...SILENT, ...reporter };
  const options = { concurrency, jsonOnly, dryRun, onProgress, report, sourceCount: sources.length };

  const tempDir = await mkdtemp(path.join(tmpdir(), 'asset-sync-'));
  const updated = [];
  const skipped = [];

  try {
    for (const [index, source] of sources.entries()) {
      const failures = await syncSource(source, index, { tempDir, options });
      if (failures) {
        skipped.push({ source: config.sources[index], failures });
      } else {
        updated.push(config.sources[index]);
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  return { updated, skipped };
}

/**
 * Brings down one source's JSON and every asset it references, and writes them into the
 * project only once all of them have arrived intact. If any single thing fails, the source
 * is left exactly as it was on disk: old data that works beats new data that doesn't.
 * Returns the failures that stopped it, or null once it is written.
 */
async function syncSource(source, index, { tempDir, options }) {
  const { report, sourceCount } = options;
  const staging = path.join(tempDir, String(index));
  const hasAssets = !options.jsonOnly && source.assetFields.length > 0;

  report.source(index + 1, sourceCount, source.url);

  // 1. Read the JSON. Without it there is nothing to do for this source.
  let data;
  try {
    data = await fetchJson(source.url);
  } catch (error) {
    const failures = [{ url: source.url, error }];
    report.skipped(failures, source);
    return failures;
  }

  // 2. Find the assets the JSON references
  const refs = collectAssetRefs(data, source.assetFields);

  for (const ref of refs) {
    ref.tempDir = path.join(staging, 'assets');
    ref.pathDir = source.assetsFolder; // relative to outputDir, and so to the JSON file landing there
  }

  const jobs = groupByUrl(refs);
  report.referenced(jobs.length);

  if (options.dryRun) {
    report.wouldWrite(jobs, source, hasAssets, options);
    return null;
  }

  // 3. Fetch every asset. One failure is enough to call the whole source off, but we let
  //    the rest finish first, so a single run reports everything that is broken.
  if (jobs.length > 0 && options.jsonOnly) {
    await resolveAssets(jobs, options.concurrency);
  } else if (jobs.length > 0) {
    const progress = (done, total, bytes, url) => {
      report.progress(done, total, bytes);
      options.onProgress?.({ source: index + 1, sourceCount, url, done, total, bytes });
    };

    const { failures, bytes } = await downloadAssets(jobs, options.concurrency, progress);

    if (failures.length > 0) {
      report.skipped(failures, source);
      return failures;
    }

    report.downloaded(jobs.length, bytes);
  }

  // 4. Everything arrived, so it is safe to update the project
  await stage(staging, source, data, hasAssets);
  await publish(staging, source, hasAssets);
  report.written(source, hasAssets);

  return null;
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
