// @ts-check

/**
 * Scheduling of the queue-owned cleanup pass
 * (`docs/specs/spec-converter-adapter.md`, "Cleanup is owned by the queue"),
 * split out of `queue.js` to keep it small. Single writer under `CONVERT_DIR`:
 * a cleanup never overlaps a job, so it cannot race a publish rename or touch
 * a closed DB. Its only trigger is `requestCleanup()`.
 */

import { runCleanup } from './cleanup.js';

/**
 * The slice of the queue's `QueueState` the scheduler reads and writes.
 * @typedef {object} CleanupScheduleState
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {import('../config.js').Config} config
 * @property {import('../log.js').Logger} log
 * @property {() => number} now
 * @property {import('./work-dir.js').RemoveDir} removeDir
 * @property {boolean} ready
 * @property {string} convertDirReal
 * @property {boolean} stopping
 * @property {Promise<void> | null} currentJobPromise
 * @property {Promise<void> | null} cleanupPromise - the in-flight cleanup pass, if any.
 * @property {boolean} cleanupPending - a request arrived while a job or a cleanup was running.
 */

/**
 * `requestCleanup()`: a no-op before `ready` and after `stop()`; while a job
 * or a cleanup runs it only sets the pending flag (coalesced, single-flight);
 * otherwise the cleanup starts now.
 * @param {CleanupScheduleState} state
 * @param {() => void} kick - called at the end of a cleanup.
 * @returns {void}
 */
export function requestCleanup(state, kick) {
  if (!state.ready || state.stopping) return;
  if (state.currentJobPromise !== null || state.cleanupPromise !== null) {
    state.cleanupPending = true;
    return;
  }
  startCleanup(state, kick);
}

/**
 * Called when a job settled: runs a pending cleanup before the next claim,
 * else claims the next job. Does nothing once `stop()` was called.
 * @param {CleanupScheduleState} state
 * @param {() => void} kick
 * @returns {void}
 */
export function afterJob(state, kick) {
  if (state.stopping) return;
  if (state.cleanupPending) startCleanup(state, kick);
  else kick();
}

/**
 * Starts one cleanup pass (never rejects). At its end a coalesced pending
 * request runs once more; otherwise `kick()` resumes the queue.
 * @param {CleanupScheduleState} state
 * @param {() => void} kick
 */
function startCleanup(state, kick) {
  state.cleanupPending = false;
  state.cleanupPromise = runCleanup({
    db: state.db,
    mediaRoot: state.config.mediaRoot,
    convertDirReal: state.convertDirReal,
    removeDir: state.removeDir,
    log: state.log,
    now: state.now,
    isStopping: () => state.stopping,
  })
    .then(
      () => {},
      () => {}
    )
    .finally(() => {
      state.cleanupPromise = null;
      if (state.stopping) return;
      if (state.cleanupPending) startCleanup(state, kick);
      else kick();
    });
}
