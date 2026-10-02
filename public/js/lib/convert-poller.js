// @ts-check

/**
 * Generic per-root polling for `convert-control.js`: a single 5 s
 * `setInterval`, deduplicated through a module-level `WeakMap<root, timer>`
 * so decorating the same root again first cancels its previous poller. Holds
 * no conversion-domain knowledge — the caller's `tick` decides what to fetch,
 * how to re-render and whether to keep going. See
 * docs/specs/archive/spec-conversion-core.md "UI behaviour".
 */

const POLL_INTERVAL_MS = 5000;

/** @type {WeakMap<Element, ReturnType<typeof setInterval>>} */
const timers = new WeakMap();

/**
 * One poll round: fetches the latest state, re-renders it and reports
 * whether polling should continue (e.g. some entry is still
 * `queued`/`converting`). A rejection is treated by {@link startPolling} as a
 * transient error — the interval keeps running for the next tick; resolving
 * `false` (nothing left active, or a fatal `401`/`403`) stops it for good.
 * @typedef {() => Promise<boolean>} PollTick
 */

/**
 * Starts a 5 s poller for `root`, cancelling any previous one for the same
 * root first (idempotent — safe to call on every re-decoration). Each round
 * is skipped while `document.hidden` (paused, not stopped, so it resumes on
 * its own once the tab is visible again) and the poller is torn down once
 * `root.isConnected` is false or `tick` resolves `false`.
 * @param {Element} root
 * @param {PollTick} tick
 * @returns {void}
 */
export function startPolling(root, tick) {
  stopPolling(root);
  const id = setInterval(() => {
    void runTick(root, id, tick);
  }, POLL_INTERVAL_MS);
  timers.set(root, id);
}

/**
 * Cancels `root`'s poller, if any (a no-op otherwise).
 * @param {Element} root
 * @returns {void}
 */
export function stopPolling(root) {
  const id = timers.get(root);
  if (id !== undefined) clearInterval(id);
  timers.delete(root);
}

/**
 * Cancels `root`'s poller only while it is still the interval `id` — a tick
 * that settles after `root` was re-decorated must never stop the newer
 * poller that replaced its own.
 * @param {Element} root
 * @param {ReturnType<typeof setInterval>} id
 * @returns {void}
 */
function stopOwn(root, id) {
  if (timers.get(root) === id) stopPolling(root);
  else clearInterval(id);
}

/**
 * @param {Element} root
 * @param {ReturnType<typeof setInterval>} id
 * @param {PollTick} tick
 * @returns {Promise<void>}
 */
async function runTick(root, id, tick) {
  if (!root.isConnected) {
    stopOwn(root, id);
    return;
  }
  if (document.hidden) return;
  let keepGoing = true;
  try {
    keepGoing = await tick();
  } catch {
    keepGoing = true;
  }
  if (!keepGoing || !root.isConnected) stopOwn(root, id);
}
