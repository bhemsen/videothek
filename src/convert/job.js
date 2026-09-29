// @ts-check

/**
 * One claimed conversion's full pipeline (`docs/specs/spec-conversion-core.md`,
 * "Queue" > "Job", steps 1-7) and the single writer of that row's end state.
 * No queue claim and no kill-escalation timers - both are `queue.js`'s job.
 */

import path from 'node:path';
import { stat as fsStat, realpath as fsRealpath, rename as fsRename, rm } from 'node:fs/promises';
import { resolveMediaPath } from '../media/paths.js';
import { getItemByRelPath } from '../db/library-repo.js';
import { recordSourceStat, publishConversion, failConversion } from '../db/conversions.js';
import { runConverter } from './run-converter.js';
import { interpretRun, redactDetail } from './result.js';
import { verifyOutput } from './verify.js';
import { TARGETS } from './targets.js';
import { createJobDir, preparePublishDir } from './work-dir.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('../db/conversions.js').ConversionRow} ConversionRow */
/** @typedef {import('./run-converter.js').RunConverter} RunConverter */
/** @typedef {import('./work-dir.js').RemoveDir} RemoveDir */
/** @typedef {import('./result.js').RedactRoots} RedactRoots */
/** @typedef {{ status: 'playable' } | { status: 'failed', error: string }} JobOutcome */
/** @typedef {RunJobOptions & { run: typeof runConverter, removeDir: RemoveDir }} NormalizedOptions defaults applied */

const NOTE_MAX_LENGTH = 200;
const defaultRemoveDir = (/** @type {string} */ target) => rm(target, { recursive: true, force: true, maxRetries: 3 });

/**
 * @typedef {object} RunJobOptions
 * @property {DatabaseSync} db
 * @property {Config} config
 * @property {Logger} log
 * @property {() => number} now
 * @property {typeof runConverter} [run] - injectable; default the real runner.
 * @property {RemoveDir} [removeDir] - injectable seam for step 7's removal.
 * @property {string} convertDirReal - realpath kept by the queue's `start()`.
 * @property {ConversionRow} row - already claimed (`status = 'converting'`).
 * @property {() => boolean} isStopping - read synchronously right before the
 *   spawn and again once the run settles (Queue `stop()`).
 * @property {(handle: RunConverter) => void} [onHandle] - called
 *   synchronously with the run handle the moment it exists, in the same
 *   step as the `isStopping()` check, so `stop()` can find and kill it.
 */

/**
 * Runs one claimed conversion through steps 1-7 and records its end state.
 * Never rejects: any unexpected error ends the row `failed` `internal`; if
 * even that fallback DB write fails (e.g. `stop()`'s deadline passed and the
 * DB is closed) it only logs. Step 7's cleanup runs in `finally` either way,
 * and its failure only logs (the end state is already committed).
 * `conversion_started` carries the same `{ key, target, status, error, ms }`
 * shape as `conversion_finished` (status `converting`, `error: null`, `ms: 0`).
 * @param {RunJobOptions} options
 * @returns {Promise<void>}
 */
export async function runConversionJob(options) {
  const opts = { run: runConverter, removeDir: defaultRemoveDir, ...options };
  const { log, now, row } = opts;
  const startedAt = now();
  log.info('conversion_started', { key: row.storage_key, target: row.target, status: 'converting', error: null, ms: 0 });
  /** @type {{ jobDir: string | null }} */
  const ctx = { jobDir: null };

  /** @type {JobOutcome} */
  let outcome;
  try {
    outcome = await runPipeline(opts, ctx);
  } catch (err) {
    outcome = recordInternal(opts, err);
  } finally {
    await removeJobDir(opts, ctx.jobDir);
  }
  log.info('conversion_finished', {
    key: row.storage_key,
    target: row.target,
    status: outcome.status,
    error: outcome.status === 'failed' ? outcome.error : null,
    ms: now() - startedAt,
  });
}

/**
 * The `internal` fallback: logs `conversion_error { key, code }`, then tries
 * to record `failed` `internal`; a failure of that write only logs too.
 * @param {NormalizedOptions} opts
 * @param {unknown} err
 * @returns {JobOutcome}
 */
function recordInternal({ db, log, now, row }, err) {
  const code = errorCode(err);
  log.error('conversion_error', { key: row.storage_key, code });
  try {
    recordFailure(db, row, now, 'internal', code);
  } catch (writeErr) {
    log.error('conversion_error', { key: row.storage_key, code: errorCode(writeErr) });
  }
  return { status: 'failed', error: 'internal' };
}

/**
 * Step 7: removes the `mkdtemp` job dir, if one was created; a removal
 * error only logs `conversion_cleanup_failed { key, code }`.
 * @param {NormalizedOptions} opts
 * @param {string | null} jobDir
 * @returns {Promise<void>}
 */
async function removeJobDir({ log, row, removeDir }, jobDir) {
  if (jobDir === null) return;
  try {
    await removeDir(jobDir);
  } catch (err) {
    log.error('conversion_cleanup_failed', { key: row.storage_key, code: errorCode(err) });
  }
}

/**
 * Steps 1-6. Every return path has already written the row's end state via
 * `recordFailure`/`publishConversion`; the caller only cleans up and logs.
 * @param {NormalizedOptions} opts
 * @param {{ jobDir: string | null }} ctx
 * @returns {Promise<JobOutcome>}
 */
async function runPipeline(opts, ctx) {
  const { db, config, now, row, isStopping, run, onHandle } = opts;
  const source = await resolveSource(opts);
  if (!source.ok) return recordFailure(db, row, now, source.error, source.detail);

  const jobDir = await createJobDir({ convertDirReal: opts.convertDirReal, storageKey: row.storage_key });
  if (jobDir.jobDir !== undefined) ctx.jobDir = jobDir.jobDir;
  if (!jobDir.ok) return recordFailure(db, row, now, 'storage_failed', jobDir.code);

  if (isStopping()) return recordFailure(db, row, now, 'interrupted', null);
  const cmd = /** @type {readonly string[]} */ (config.converterCmd);
  const handle = run({
    cmd,
    env: { ...config.converterEnv, TMPDIR: jobDir.tmpDir, TEMP: jobDir.tmpDir, TMP: jobDir.tmpDir },
    target: row.target,
    source: source.path,
    outDir: jobDir.outDir,
    cwd: jobDir.jobDir,
  });
  onHandle?.(handle);
  const result = await handle.result;
  if (isStopping()) return recordFailure(db, row, now, 'interrupted', null);

  return interpretAndPublish(opts, { outDir: jobDir.outDir, result, source });
}

/**
 * Steps 1-2: the source's absolute path and its recorded stat at job start,
 * or a `source_missing` failure (an absent index row, an unresolvable path,
 * or a failed `stat` all count the same way).
 * @param {NormalizedOptions} opts
 * @returns {Promise<{ ok: true, path: string, size: number, mtimeMs: number }
 *   | { ok: false, error: 'source_missing', detail: string | null }>}
 */
async function resolveSource({ db, config, row }) {
  if (!getItemByRelPath(db, row.rel_path)) return { ok: false, error: 'source_missing', detail: null };
  const resolved = await resolveMediaPath(config.mediaRoot, row.rel_path);
  if (resolved === null) return { ok: false, error: 'source_missing', detail: null };
  try {
    const stat = await fsStat(resolved);
    const mtimeMs = Math.trunc(stat.mtimeMs);
    recordSourceStat(db, row.rel_path, stat.size, mtimeMs);
    return { ok: true, path: resolved, size: stat.size, mtimeMs };
  } catch (err) {
    return { ok: false, error: 'source_missing', detail: errorCode(err) };
  }
}

/**
 * Steps 5-6 once the run has settled and `stop()` has not intervened:
 * interpret, verify, re-stat the source, then publish.
 * @param {NormalizedOptions} opts
 * @param {{ outDir: string, result: import('./run-converter.js').RunResult, source: { path: string, size: number, mtimeMs: number } }} ctx
 * @returns {Promise<JobOutcome>}
 */
async function interpretAndPublish(opts, { outDir, result, source }) {
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

  return publish(opts, { verifiedPath: verified.path, notes: interpreted.notes, roots });
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
 * @param {{ verifiedPath: string, notes: string[], roots: RedactRoots }} ctx
 * @returns {Promise<JobOutcome>}
 */
async function publish({ db, now, row, convertDirReal }, { verifiedPath, notes, roots }) {
  const publishDir = await preparePublishDir({ convertDirReal, storageKey: row.storage_key });
  if (!publishDir.ok) return recordFailure(db, row, now, 'storage_failed', publishDir.code);

  const targetPath = path.join(publishDir.publishDirReal, TARGETS[row.target].file);
  let size;
  try {
    size = (await fsStat(verifiedPath)).size;
    await fsRename(verifiedPath, targetPath);
  } catch (err) {
    return recordFailure(db, row, now, 'storage_failed', errorCode(err));
  }

  const redactedNotes = notes.map((note) => redactDetail(note, roots).slice(0, NOTE_MAX_LENGTH));
  publishConversion(db, {
    relPath: row.rel_path,
    outputRel: `${row.storage_key}/${TARGETS[row.target].file}`,
    outputSize: size,
    notes: JSON.stringify(redactedNotes),
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
function recordFailure(db, row, now, error, detail) {
  failConversion(db, { relPath: row.rel_path, error, detail, now: now() });
  return { status: 'failed', error };
}

/**
 * @param {unknown} err
 * @returns {string} the errno `code`, else the error's `name`, else `'ERR_UNKNOWN'`.
 */
function errorCode(err) {
  const code = /** @type {{ code?: unknown }} */ (err)?.code;
  if (typeof code === 'string') return code;
  const name = /** @type {{ name?: unknown }} */ (err)?.name;
  return typeof name === 'string' ? name : 'ERR_UNKNOWN';
}
