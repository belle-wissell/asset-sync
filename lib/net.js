import { createWriteStream } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { extensionFor, localize, targetsFor } from './assets.js';

const RETRIES = 2;

export async function fetchJson(url) {
  const res = await fetchWithRetry(url, { headers: { accept: 'application/json' } });
  return res.json();
}

/**
 * Downloads every job's asset, `limit` at a time, and points the JSON at the local copies.
 * A failed asset is collected rather than thrown, so one dead URL can't sink the run.
 */
export async function downloadAssets(jobs, limit, onProgress) {
  const failures = [];
  let done = 0;
  let bytes = 0;

  await pool(jobs, limit, async (job) => {
    try {
      await downloadAsset(job, (n) => onProgress(done, jobs.length, (bytes += n), job.url));
    } catch (error) {
      failures.push({ url: job.url, error });
    }
    onProgress(++done, jobs.length, bytes, job.url);
  });

  return { failures, bytes };
}

/**
 * Points the JSON at local assets without downloading them, for --json-only.
 * A HEAD request resolves redirects and content type, so the filenames match what a
 * full run would have produced; if a server refuses HEAD, the URL alone has to do.
 */
export async function resolveAssets(jobs, limit) {
  await pool(jobs, limit, async (job) => {
    let ext;

    try {
      const res = await fetchWithRetry(job.url, { method: 'HEAD' });
      ext = extensionFor(res.url, res.headers.get('content-type'));
    } catch {
      ext = extensionFor(job.url);
    }

    localize(targetsFor(job, ext));
  });
}

/**
 * Fetches one asset and writes it to each of its refs' filenames. The extension comes
 * from the final URL after redirects, so no separate HEAD request is needed.
 */
async function downloadAsset(job, onBytes) {
  const res = await fetchWithRetry(job.url);
  const targets = targetsFor(job, extensionFor(res.url, res.headers.get('content-type')));

  const [primary, ...copies] = targets;
  const primaryPath = path.join(primary.ref.tempDir, primary.file);

  // A connection that dies mid-stream throws here, leaving a truncated file behind. That is
  // fine: its source will be skipped whole, so nothing in the temp folder is ever published.
  await mkdir(path.dirname(primaryPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), countBytes(onBytes), createWriteStream(primaryPath));

  for (const copy of copies) {
    const copyPath = path.join(copy.ref.tempDir, copy.file);
    await mkdir(path.dirname(copyPath), { recursive: true });
    await copyFile(primaryPath, copyPath);
  }

  localize(targets);
}

/** Passes chunks straight through, reporting how many bytes go by. */
const countBytes = (onBytes) =>
  async function* (chunks) {
    for await (const chunk of chunks) {
      onBytes(chunk.length);
      yield chunk;
    }
  };

/** Retries network errors and transient server errors, but not 4xx — those won't fix themselves. */
async function fetchWithRetry(url, init) {
  for (let attempt = 0; ; attempt++) {
    let retryable = true;

    try {
      const res = await fetch(url, init);
      if (res.ok) return res;

      retryable = res.status === 429 || res.status >= 500;
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    } catch (error) {
      if (!retryable || attempt >= RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 500));
    }
  }
}

/** Runs `worker` over `items`, `limit` at a time. */
async function pool(items, limit, worker) {
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      await worker(items[next++]);
    }
  });

  await Promise.all(workers);
}
