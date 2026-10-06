// @ts-check

/**
 * Kill helpers shared by the queue's `stop()` and `cancel()`
 * (`docs/specs/spec-converter-adapter.md`, Prior decisions "Queue `cancel`"):
 * `SIGTERM` to the run handle plus ONE `SIGKILL` escalation timer, so a
 * cancel followed by a stop never arms a second timer (a late group signal
 * could otherwise hit a reused pgid). The timer is cleared by queue.js's
 * `onHandle` once the run settles.
 */

import { errorCode } from './error-code.js';

/** @typedef {import('./run-converter.js').RunConverter} RunConverter */

/**
 * @typedef {object} KillState - the slice of `QueueState` these helpers use.
 * @property {import('../log.js').Logger} log
 * @property {number} killGraceMs
 * @property {RunConverter | null} currentHandle
 * @property {NodeJS.Timeout | null} killTimer
 */

/**
 * Sends `signal` via the run handle; a throw (never expected from
 * `runConverter`'s `kill`) only logs, so callers still return and the
 * stop deadline still bounds them.
 * @param {KillState} state
 * @param {RunConverter} handle
 * @param {NodeJS.Signals} signal
 */
export function safeKill(state, handle, signal) {
  try {
    handle.kill(signal);
  } catch (err) {
    state.log.error('conversion_error', { code: errorCode(err) });
  }
}

/**
 * Terminates the running job's process: `SIGTERM` now and `SIGKILL` after
 * `killGraceMs`. A no-op without a run handle, and when the escalation is
 * already armed (an earlier cancel/stop already sent `SIGTERM`; nothing is
 * re-armed or overwritten).
 * @param {KillState} state
 */
export function terminateRun(state) {
  const handle = state.currentHandle;
  if (handle === null || state.killTimer !== null) return;
  safeKill(state, handle, 'SIGTERM');
  state.killTimer = setTimeout(() => {
    state.killTimer = null;
    safeKill(state, handle, 'SIGKILL');
  }, state.killGraceMs);
}
