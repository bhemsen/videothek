// @ts-check

/**
 * One claimed conversion's full pipeline (`docs/specs/archive/spec-conversion-core.md`,
 * "Queue" > "Job", steps 1-7) and the single writer of that row's end state.
 * No queue claim and no kill-escalation timers - both are `queue.js`'s job.
 */

import { stat as fsStat, rm } from 'node:fs/promises';
import { resolveMediaPath } from '../media/paths.js';
import { getItemByRelPath } from '../db/library-repo.js';
import { recordSourceStat } from '../db/conversions.js';
import { runConverter } from './run-converter.js';
import { createJobDir } from './work-dir.js';
import { errorCode } from './error-code.js';
import { interpretAndPublish, recordFailure } from './publish.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('../db/conversions.js').ConversionRow} ConversionRow */
/** @typedef {import('./run-converter.js').RunConverter} RunConverter */
/** @typedef {import('./work-dir.js').RemoveDir} RemoveDir */
/** @typedef {import('./publish.js').JobOutcome} JobOutcome */
/** @typedef {RunJobOptions & { run: typeof runConverter, removeDir: RemoveDir }} NormalizedOptions defaults applied */

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
 * @property {() => boolean} [isCancelled] - Queue `cancel()`'s flag; checked
 *   at the same two points as `isStopping()` (cancel wins) and once more in
 *   `publish.js` right before the publish transaction. Default: never.
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
  const { db, config, now, row, run, onHandle } = opts;
  const source = await resolveSource(opts);
  if (!source.ok) return recordFailure(db, row, now, source.error, source.detail);

  const jobDir = await createJobDir({ convertDirReal: opts.convertDirReal, storageKey: row.storage_key });
  if (jobDir.jobDir !== undefined) ctx.jobDir = jobDir.jobDir;
  if (!jobDir.ok) return recordFailure(db, row, now, 'storage_failed', jobDir.code);

  const early = earlyExit(opts);
  if (early) return recordFailure(db, row, now, early, null);
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
  const late = earlyExit(opts);
  if (late) return recordFailure(db, row, now, late, null);

  return interpretAndPublish(opts, { outDir: jobDir.outDir, result, source });
}

/**
 * The end code a pending cancel (wins) or `stop()` requires, else `null`.
 * @param {NormalizedOptions} opts
 * @returns {'cancelled' | 'interrupted' | null}
 */
function earlyExit({ isCancelled, isStopping }) {
  if (isCancelled?.()) return 'cancelled';
  return isStopping() ? 'interrupted' : null;
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

