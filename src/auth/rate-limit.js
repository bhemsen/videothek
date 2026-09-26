/**
 * @typedef {{ allowed: boolean, retryAfterSec: number | null }} LimitCheck
 */

/**
 * Creates an in-memory, per-key sliding-window login rate limiter (e.g.
 * keyed by normalized username). State is process-local and lost on
 * restart; a least-recently-failed key is evicted once `maxKeys` is
 * exceeded.
 * @param {{ maxFailures?: number, windowMs?: number, maxKeys?: number, now?: () => number }} [options]
 * @returns {{
 *   check: (key: string) => LimitCheck,
 *   fail: (key: string) => void,
 *   reset: (key: string) => void
 * }}
 */
export function createLoginLimiter({
  maxFailures = 5,
  windowMs = 900000,
  maxKeys = 1000,
  now = Date.now,
} = {}) {
  /** @type {Map<string, number[]>} */
  const failures = new Map();

  /**
   * Drops timestamps that fell out of the window and returns the rest.
   * Does not reorder `key` in `failures` (only `fail` affects recency).
   * @param {string} key
   * @returns {number[]}
   */
  function liveFailures(key) {
    const timestamps = failures.get(key);
    if (!timestamps) return [];
    const cutoff = now() - windowMs;
    const kept = timestamps.filter((t) => t > cutoff);
    if (kept.length === 0) {
      failures.delete(key);
    } else if (kept.length !== timestamps.length) {
      failures.set(key, kept);
    }
    return kept;
  }

  return {
    check(key) {
      const timestamps = liveFailures(key);
      if (timestamps.length < maxFailures) {
        return { allowed: true, retryAfterSec: null };
      }
      const oldest = timestamps[0];
      const retryAfterSec = Math.ceil((oldest + windowMs - now()) / 1000);
      return { allowed: false, retryAfterSec };
    },
    fail(key) {
      const timestamps = liveFailures(key);
      timestamps.push(now());
      // Delete + re-set moves `key` to the end of the Map's iteration
      // order, marking it most-recently-failed for the LRU cap below.
      failures.delete(key);
      failures.set(key, timestamps);
      if (failures.size > maxKeys) {
        const oldestKey = failures.keys().next().value;
        if (oldestKey !== undefined) failures.delete(oldestKey);
      }
    },
    reset(key) {
      failures.delete(key);
    },
  };
}
