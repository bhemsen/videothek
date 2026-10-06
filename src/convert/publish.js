// @ts-check

/**
 * Steps 5-6 of a conversion job (`docs/specs/archive/spec-conversion-core.md`,
 * "Queue" > "Job"): interpret and verify the run, re-check the source, then
 * publish the output. Split out of `job.js`; also owns `recordFailure`.
 */

import path from 'node:path';
import { stat as fsStat, realpath as fsRealpath, rename as fsRename } from 'node:fs/promises';
import { resolveMediaPath } from '../media/paths.js';
import { publishConversion, failConversion } from '../db/conversions.js';
import { interpretRun, redactDetail } from './result.js';
import { verifyOutput } from './verify.js';
import { TARGETS } from './targets.js';
import { preparePublishDir } from './work-dir.js';
import { errorCode } from './error-code.js';
import { publishSidecars } from './sidecars.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('../db/conversions.js').ConversionRow} ConversionRow */
/** @typedef {import('./result.js').RedactRoots} RedactRoots */
/** @typedef {{ status: 'playable' } | { status: 'failed', error: string }} JobOutcome */
/** @typedef {import('./job.js').NormalizedOptions} NormalizedOptions */

const NOTE_MAX_LENGTH = 200;

/**
 * Steps 5-6 once the run has settled and `stop()` has not intervened:
 * interpret, verify, re-stat the source, then publish.
 * @param {NormalizedOptions} opts
 * @param {{ outDir: string, result: import('./run-converter.js').RunResult, source: { path: string, size: number, mtimeMs: number } }} ctx
 * @returns {Promise<JobOutcome>}
 */
export async function interpretAndPublish(opts, { outDir, result, source }) {
  const { db, now, row } = opts;
  const interpreted = interpretRun(result, { target: row.target });
  const roots = await buildRedactRoots(opts);
  if (!interpreted.ok) {
    const detail = interpreted.detail === null ? null : redactDetail(interpreted.detail, roots);
    return recordFailure(db, row, now, interpreted.error, detail);
  }

  const verified = await verifyOutput({ output: interpreted.output, outDir, target: row.target });
  if (!verified.ok) return recordFailure(db, row, now, verified.error, null);

  const reStat = await restatSource(opts, source.path);
  if (!reStat.ok) return recordFailure(db, row, now, reStat.error, reStat.detail);
  if (reStat.size !== source.size || reStat.mtimeMs !== source.mtimeMs) {
    return recordFailure(db, row, now, 'source_changed', null);
  }

  return publish(opts, { verifiedPath: verified.path, outDir, notes: interpreted.notes, sidecars: interpreted.sidecars, roots });
}

/**
 * Step 5's source re-check: re-resolves `rel_path` via `resolveMediaPath`
 * (catching a mid-run removal or symlink swap) and stats it; a path that now
 * resolves elsewhere counts as `source_changed`.
 * @param {NormalizedOptions} opts
 * @param {string} sourcePath - the step-1 resolved path.
 * @returns {Promise<{ ok: true, size: number, mtimeMs: number }
 *   | { ok: false, error: 'source_missing' | 'source_changed', detail: string | null }>}
 */
async function restatSource({ config, row }, sourcePath) {
  const resolved = await resolveMediaPath(config.mediaRoot, row.rel_path);
  if (resolved === null) return { ok: false, error: 'source_missing', detail: null };
  if (resolved !== sourcePath) return { ok: false, error: 'source_changed', detail: null };
  try {
    const stat = await fsStat(resolved);
    return { ok: true, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
  } catch (err) {
    return { ok: false, error: 'source_missing', detail: errorCode(err) };
  }
}

/**
 * Step 6: prepares and verifies the publish directory, renames the verified
 * output into it, then commits the publish transaction.
 * @param {NormalizedOptions} opts
 * @param {{ verifiedPath: string, outDir: string, notes: string[], sidecars: import('./jsonl.js').ConverterSidecar[], roots: RedactRoots }} ctx
 * @returns {Promise<JobOutcome>}
 */
async function publish({ db, now, row, convertDirReal }, { verifiedPath, outDir, notes, sidecars, roots }) {
  const publishDir = await preparePublishDir({ convertDirReal, storageKey: row.storage_key });
  if (!publishDir.ok) return recordFailure(db, row, now, 'storage_failed', publishDir.code);

  const side = await publishSidecars({ outDir: await fsRealpath(outDir).catch(() => outDir), publishDir: publishDir.publishDirReal, sidecars });
  const targetPath = path.join(publishDir.publishDirReal, TARGETS[row.target].file);
  let size;
  try {
    size = (await fsStat(verifiedPath)).size;
    await fsRename(verifiedPath, targetPath);
  } catch (err) {
    return recordFailure(db, row, now, 'storage_failed', errorCode(err));
  }

  const redactedNotes = [...notes.map((note) => redactDetail(note, roots).slice(0, NOTE_MAX_LENGTH)), ...side.notes];
  publishConversion(db, {
    relPath: row.rel_path,
    outputRel: `${row.storage_key}/${TARGETS[row.target].file}`,
    outputSize: size + side.bytes,
    notes: JSON.stringify(redactedNotes),
    sidecars: JSON.stringify(side.published),
    now: now(),
  });
  return { status: 'playable' };
}

/**
 * The root spellings `redactDetail` matches against: configured and
 * realpath'd `MEDIA_ROOT`/`CONVERT_DIR`, plus the converter's install
 * directory (spec-conversion-core.md "Interpretation"). `mediaRoot`'s
 * realpath is cheap to recompute per job and keeps this module independent
 * of what internal state the queue happens to keep from its own `start()`.
 * @param {NormalizedOptions} opts
 * @returns {Promise<RedactRoots>}
 */
async function buildRedactRoots({ config, convertDirReal }) {
  const mediaRootReal = await fsRealpath(config.mediaRoot).catch(() => config.mediaRoot);
  const converterDir = config.converterCmd ? path.dirname(config.converterCmd[0]) : null;
  return {
    mediaRoot: [config.mediaRoot, mediaRootReal],
    convertDir: [config.convertDir, convertDirReal],
    converterDir,
  };
}

/**
 * Records a terminal failure and returns the shape `runPipeline` propagates.
 * @param {DatabaseSync} db
 * @param {ConversionRow} row
 * @param {() => number} now
 * @param {string} error
 * @param {string | null} detail
 * @returns {{ status: 'failed', error: string }}
 */
export function recordFailure(db, row, now, error, detail) {
  failConversion(db, { relPath: row.rel_path, error, detail, now: now() });
  return { status: 'failed', error };
}
