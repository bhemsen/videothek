/**
 * Pure playback queue over one album or book: filters to playable items and
 * walks them in order. No DOM, no I/O — see spec-music-audiobooks.md "Queue".
 */

/**
 * @typedef {{ id: number, title: string, subtitle: string | null, groupTitle: string | null, coverId: number | null, duration: number | null, playable: boolean, start: number }} QueueItem
 */

const BACK_THRESHOLD_S = 3;

/**
 * Builds a queue over `items`, keeping only playable ones. `startIndex`
 * indexes the original (unfiltered) `items` array; when it names a
 * non-playable item the queue starts at the next playable one, searching
 * forward from `startIndex` and, failing that, wrapping to the start.
 * @param {QueueItem[]} items
 * @param {{ startIndex?: number }} [opts]
 * @returns {{
 *   current: () => QueueItem | null,
 *   index: () => number,
 *   advance: () => QueueItem | null,
 *   back: (currentTimeS: number) => { item: QueueItem | null, restart: boolean },
 *   jump: (itemId: number) => QueueItem | null
 * }}
 */
export function createQueue(items, { startIndex = 0 } = {}) {
  const filtered = items.filter((item) => item.playable);
  let pos = resolveStartPos(items, filtered, startIndex);

  /** @returns {QueueItem | null} */
  function current() {
    return pos >= 0 && pos < filtered.length ? filtered[pos] : null;
  }

  /** @returns {number} */
  function index() {
    return pos;
  }

  /** @returns {QueueItem | null} */
  function advance() {
    if (pos < 0 || pos + 1 >= filtered.length) return null;
    pos += 1;
    return filtered[pos];
  }

  /**
   * `currentTimeS > 3` or the first item restarts the current item; a lower
   * elapsed time on any later item moves to the previous one instead.
   * @param {number} currentTimeS
   * @returns {{ item: QueueItem | null, restart: boolean }}
   */
  function back(currentTimeS) {
    const item = current();
    if (pos <= 0 || currentTimeS > BACK_THRESHOLD_S) return { item, restart: true };
    pos -= 1;
    return { item: filtered[pos], restart: false };
  }

  /** @param {number} itemId @returns {QueueItem | null} */
  function jump(itemId) {
    const idx = filtered.findIndex((item) => item.id === itemId);
    if (idx < 0) return null;
    pos = idx;
    return filtered[idx];
  }

  return { current, index, advance, back, jump };
}

/**
 * @param {QueueItem[]} items @param {QueueItem[]} filtered @param {number} startIndex
 * @returns {number}
 */
function resolveStartPos(items, filtered, startIndex) {
  if (filtered.length === 0 || items.length === 0) return -1;
  const start = Math.min(Math.max(0, startIndex), items.length - 1);
  for (let offset = 0; offset < items.length; offset += 1) {
    const candidate = items[(start + offset) % items.length];
    if (candidate.playable) return filtered.indexOf(candidate);
  }
  return -1;
}
