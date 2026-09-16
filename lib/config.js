import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { check, UserError } from './error.js';

/**
 * Reads and validates a config file, but returns it as written, not normalized: sync()
 * normalizes whatever it is given, and normalizing twice would drop each source's `assets`.
 */
export async function loadConfig(file) {
  const abs = path.resolve(file);

  let raw;
  try {
    raw = await readFile(abs, 'utf8');
  } catch {
    throw new UserError(`Config file not found: ${abs}`);
  }

  try {
    const config = JSON.parse(raw);
    normalizeConfig(config); // report a bad config now, before the run starts
    return { ...config, file: abs };
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(`Config file is not valid JSON: ${abs}\n  ${error.message}`);
  }
}

export function normalizeConfig(config) {
  check(isObject(config), `Config must be a JSON object`);
  check(isText(config.outputDir), `Config must include an "outputDir" string`);
  check(
    Array.isArray(config.sources) && config.sources.length > 0,
    `Config must include a non-empty "sources" array`
  );

  const outputDir = path.resolve(expandHome(config.outputDir));
  const sources = config.sources.map((source, i) => normalizeSource(source, i, outputDir));
  checkSourcesDoNotCollide(sources);

  return { outputDir, sources };
}

/**
 * A source writes two things, and both sit directly inside the shared `outputDir`: a JSON file,
 * and, if the source has any, a folder of the assets that JSON points at. Keeping
 * `assets.outputFolder` a plain name — no separators, nothing that climbs out — is what lets it do
 * double duty: it is the folder on disk, and, being a sibling of the JSON file, it is also the
 * path written into the JSON. The two cannot disagree. `outputFile` is required (rather than
 * defaulted) because every source shares one `outputDir`, so nothing keeps two sources' JSON apart
 * unless each names its own. `assets` itself is optional — omit it for a source that is JSON only —
 * but once present it must name its own `outputFolder` for the same reason.
 */
function normalizeSource(source, i, outputDir) {
  const at = `sources[${i}]`;

  check(isObject(source), `${at} must be an object`);
  check(isText(source.url), `${at} must include a "url" string`);
  check(URL.canParse(source.url), `${at}.url is not a valid URL: ${source.url}`);

  check(isText(source.outputFile), `${at} must include an "outputFile" string`);
  check(isPlainName(source.outputFile), `${at}.outputFile must be a file name, e.g. "data.json"`);

  const assets = source.assets;
  check(assets === undefined || isObject(assets), `${at}.assets must be an object`);

  let assetsFolder;
  let assetFields = [];

  if (assets !== undefined) {
    check(isText(assets.outputFolder), `${at}.assets must include an "outputFolder" string`);
    check(isPlainName(assets.outputFolder), `${at}.assets.outputFolder must be a folder name, e.g. "assets"`);
    assetsFolder = assets.outputFolder;

    assetFields = assets.fields ?? [];
    check(
      Array.isArray(assetFields) && assetFields.every(isText),
      `${at}.assets.fields must be an array of field paths, e.g. ["stories.img"]`
    );
  }

  return {
    url: source.url,
    outputDir,
    outputFile: source.outputFile,
    assetsFolder,
    assetFields,
    outputPath: path.join(outputDir, source.outputFile),
    assetPath: assetsFolder ? path.join(outputDir, assetsFolder) : undefined
  };
}

/**
 * An asset folder is deleted and rewritten in full on every run, and two sources writing one JSON
 * file leave the loser pointing at assets that are no longer on disk. Either way a source quietly
 * destroys another's work, so both are caught here, before the first byte is fetched, rather than
 * halfway through a run that has already published one of them.
 */
function checkSourcesDoNotCollide(sources) {
  const outputPaths = new Set();
  const assetPaths = new Set();

  for (const { outputPath, assetPath, assetFields } of sources) {
    check(
      !outputPaths.has(outputPath),
      `Two sources both write ${outputPath} — give one of them its own "outputFile"`
    );
    outputPaths.add(outputPath);

    if (assetFields.length === 0) continue; // a source with no assets never touches an asset folder

    check(
      !assetPaths.has(assetPath),
      `Two sources both download assets into ${assetPath} — give one of them its own "assets.outputFolder"`
    );
    assetPaths.add(assetPath);
  }

  // A source's own JSON is always safe — it sits beside its asset folder, never inside it. But
  // another source's outputFile may well be nested in there, and would be deleted along with it.
  for (const assetPath of assetPaths) {
    for (const outputPath of outputPaths) {
      check(
        !contains(assetPath, outputPath),
        `The "assets.outputFolder" ${assetPath} is emptied on every run, and ${outputPath} sits inside it`
      );
    }
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

/** A file or folder sitting directly inside `outputDir`: no separators, and no climbing out of it. */
const isPlainName = (value) => isText(value) && !/[/\\]/.test(value) && !/^\.+$/.test(value);

const expandHome = (p) => (p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p);

/** True if `file` is `dir` itself, or sits anywhere beneath it. */
function contains(dir, file) {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
