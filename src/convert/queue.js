// @ts-check

/**
 * The one-at-a-time conversion queue
 * (`docs/specs/archive/spec-conversion-core.md`, "Queue"): claims `queued` rows one
 * at a time via `job.js`'s `runConversionJob`, chains the next claim after
 * each job settles, and stops gracefully with a `SIGTERM`/`SIGKILL`
 * escalation and a hard deadline. State lives in one plain `QueueState`
 * object (matching this codebase's explicit-context style, e.g. job.js's
 * `ctx`) rather than a large closure, so every function stays small.
 */

import { rm } from 'node:fs/promises';
import { APP_PUBLIC_DIR } from '../config-converter.js';
import { claimNextConversion } from '../db/conversions.js';
import { runConversionJob } from './job.js';
import { runConverter } from './run-converter.js';
import { errorCode } from './error-code.js';
import { setupConvertDir } from './work-dir.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('./work-dir.js').RemoveDir} RemoveDir */
/** @typedef {import('./run-converter.js').RunConverter} RunConverter */

/**
 * @typedef {object} ConversionQueue
 * @property {() => Promise<boolean>} start - sets up `CONVERT_DIR` and wipes
 *   the crash work area (`work-dir.js`'s `setupConvertDir`); resolves
 *   `false` and logs `conversion_dir_unavailable { code }` on any failure,
 *   without kicking.
 * @property {() => void} kick - claims and runs the next `queued` row, if
 *   any; a no-op before `start()` resolved `true`, while a job is running,
 *   or once `stop()` was called.
 * @property {() => Promise<void>} stop - prevents further claims and waits
 *   for the currently running job to finish (its DB write and cleanup), or
 *   at the latest `stopDeadlineMs` after this call; memoised, never rejects.
 */

/**
 * @typedef {object} CreateConversionQueueOptions
 * @property {DatabaseSync} db
 * @property {Config} config
 * @property {Logger} log
 * @property {() => number} now
 * @property {typeof runConverter} [run] - injectable; default the real runner.
 * @property {number} [killGraceMs] - delay before a `stop()`'s `SIGTERM`
 *   escalates to `SIGKILL`. Default `5000`.
 * @property {number} [stopDeadlineMs] - hard bound on `stop()`, measured
 *   from its own call. Default `killGraceMs + 10000`.
 * @property {string} [publicDir] - the app's static directory, rejected as a
 *   `CONVERT_DIR` overlap. Default `APP_PUBLIC_DIR`.
 * @property {RemoveDir} [removeDir] - injectable seam for both `start()`'s
 *   work-area wipe and each job's step-7 removal.
 */

/**
 * @typedef {object} QueueState - mutable state shared by the functions below.
 * @property {DatabaseSync} db
 * @property {Config} config
 * @property {Logger} log
 * @property {() => number} now
 * @property {typeof runConverter} run
 * @property {number} killGraceMs
 * @property {number} stopDeadlineMs
 * @property {string} publicDir
 * @property {RemoveDir} removeDir
 * @property {boolean} ready - `true` once `start()` resolved `true`.
 * @property {string} convertDirReal - realpath from `start()`; only valid once `ready`.
 * @property {boolean} stopping - set synchronously by `stop()`.
 * @property {Promise<void> | null} stopPromise - memoises `stop()`.
 * @property {Promise<void> | null} currentJobPromise - the claimed job still running, if any.
 * @property {RunConverter | null} currentHandle - the running job's run handle, once step 4 is reached.
 * @property {NodeJS.Timeout | null} killTimer - the armed `SIGKILL` escalation, if any.
 */

const defaultRemoveDir = (/** @type {string} */ target) =>
  rm(target, { recursive: true, force: true, maxRetries: 3 });

/**
 * Creates the one-at-a-time conversion queue.
 * @param {CreateConversionQueueOptions} options
 * @returns {ConversionQueue}
 */
export function createConversionQueue(options) {
  const killGraceMs = options.killGraceMs ?? 5000;
  /** @type {QueueState} */
  const state = {
    db: options.db,
    config: options.config,
    log: options.log,
    now: options.now,
    run: options.run ?? runConverter,
    killGraceMs,
    stopDeadlineMs: options.stopDeadlineMs ?? killGraceMs + 10000,
    publicDir: options.publicDir ?? APP_PUBLIC_DIR,
    removeDir: options.removeDir ?? defaultRemoveDir,
    ready: false,
    convertDirReal: '',
    stopping: false,
    stopPromise: null,
    currentJobPromise: null,
    currentHandle: null,
    killTimer: null,
  };
  return { start: () => start(state), kick: () => kick(state), stop: () => stop(state) };
}

/**
 * `start()`: sets up `CONVERT_DIR` (realpath overlap checks, `mkdir -p`,
 * crash work-area wipe — all in `setupConvertDir`) before marking the queue
 * ready. Never kicks; the caller starts the queue with its own `kick()`.
 * @param {QueueState} state
 * @returns {Promise<boolean>}
 */
async function start(state) {
  /** @type {import('./work-dir.js').SetupResult} */
  let result;
  try {
    result = await setupConvertDir({
      mediaRoot: state.config.mediaRoot,
      convertDir: state.config.convertDir,
      publicDir: state.publicDir,
      removeDir: state.removeDir,
    });
  } catch (err) {
    // setupConvertDir documents a result, never a throw; "any failure" still
    // means false here, not a rejected start().
    result = { ok: false, code: errorCode(err) };
  }
  if (!result.ok) {
    state.log.error('conversion_dir_unavailable', { code: result.code });
    return false;
  }
  state.convertDirReal = result.convertDirReal;
  state.ready = true;
  return true;
}

/**
 * The job's `onHandle` callback: records the run handle so `stop()` can kill
 * it, and clears it (and any armed `SIGKILL` timer) once `result` settles -
 * independently of the rest of the job's own steps 5-7, so a timer never
 * outlives the run it was armed for.
 * @param {QueueState} state
 * @param {RunConverter} handle
 */
function onHandle(state, handle) {
  state.currentHandle = handle;
  const clear = () => {
    state.currentHandle = null;
    if (state.killTimer !== null) {
      clearTimeout(state.killTimer);
      state.killTimer = null;
    }
  };
  // then(clear, clear), not finally(): the derived promise must never reject.
  handle.result.then(clear, clear);
}

/**
 * Claims and runs the next `queued` row, if any, then chains itself once
 * that job settles - so exactly one job runs at a time. Never throws: a
 * failed claim (e.g. `database is locked`) only logs `conversion_error
 * { code }` and leaves the row `queued` for the next `kick()` (from a POST,
 * a later job or the next start), since this also runs inside the previous
 * job's `finally` where a throw would be an unhandled rejection. Also
 * defensively catches a rejection of `runConversionJob` itself (documented
 * to never reject).
 * @param {QueueState} state
 */
function kick(state) {
  if (!state.ready || state.stopping || state.currentJobPromise !== null) return;
  let row;
  try {
    row = claimNextConversion(state.db, state.now());
  } catch (err) {
    state.log.error('conversion_error', { code: errorCode(err) });
    return;
  }
  if (!row) return;
  const jobPromise = runConversionJob({
    db: state.db,
    config: state.config,
    log: state.log,
    now: state.now,
    run: state.run,
    removeDir: state.removeDir,
    convertDirReal: state.convertDirReal,
    row,
    isStopping: () => state.stopping,
    onHandle: (handle) => onHandle(state, handle),
  }).catch((err) => {
    state.log.error('conversion_error', { key: row.storage_key, code: errorCode(err) });
  });
  state.currentJobPromise = jobPromise.finally(() => {
    state.currentJobPromise = null;
    if (!state.stopping) kick(state);
  });
}

/**
 * Waits for the currently running job to settle, at the latest after
 * `stopDeadlineMs`, logging `conversion_stop_timeout` on that path. Resolves
 * at once when no job is running.
 * @param {QueueState} state
 * @returns {Promise<void>}
 */
function waitForJobOrDeadline(state) {
  const jobDone = state.currentJobPromise;
  if (jobDone === null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const deadlineTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      state.log.error('conversion_stop_timeout', {});
      resolve();
    }, state.stopDeadlineMs);
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      resolve();
    };
    jobDone.then(done, done);
  });
}

/**
 * `stop()`: prevents further claims at once and, if the running job already
 * has a handle, kills it (`SIGTERM` now, `SIGKILL` after `killGraceMs`). The
 * job itself is the single writer of its end state once `stopping` is set
 * (job.js's own `isStopping()` check); this only waits for that write and
 * the job's cleanup, or the hard deadline. Memoised, never rejects.
 * @param {QueueState} state
 * @returns {Promise<void>}
 */
function stop(state) {
  if (state.stopPromise) return state.stopPromise;
  state.stopping = true;
  if (state.currentHandle) {
    const handle = state.currentHandle;
    safeKill(state, handle, 'SIGTERM');
    state.killTimer = setTimeout(() => {
      state.killTimer = null;
      safeKill(state, handle, 'SIGKILL');
    }, state.killGraceMs);
  }
  state.stopPromise = waitForJobOrDeadline(state);
  return state.stopPromise;
}

/**
 * Sends `signal` via the run handle; a throw (never expected from
 * `runConverter`'s `kill`) only logs, so `stop()` still returns its promise
 * and the deadline still bounds it.
 * @param {QueueState} state
 * @param {RunConverter} handle
 * @param {NodeJS.Signals} signal
 */
function safeKill(state, handle, signal) {
  try {
    handle.kill(signal);
  } catch (err) {
    state.log.error('conversion_error', { code: errorCode(err) });
  }
}
