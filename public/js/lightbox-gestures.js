/**
 * Pure, DOM-free swipe/key classification and nav-focus fallback for the
 * image lightbox. No DOM
 * access, no imports from `src/` — see docs/specs/spec-image-gallery.md,
 * unit-tested from `test/public/`.
 */

const SWIPE_MIN_DISTANCE_PX = 50;
const SWIPE_MIN_RATIO = 1.5;

/**
 * Classifies a horizontal pointer drag as a lightbox navigation.
 * @param {number} dx - Horizontal delta in px (pointerup x - pointerdown x).
 * @param {number} dy - Vertical delta in px (pointerup y - pointerdown y).
 * @returns {'prev' | 'next' | null} `'next'` for a leftward swipe, `'prev'`
 *   for a rightward swipe, both only once `|dx|` clears the minimum distance
 *   and stays clearly horizontal (`|dx| > 1.5 * |dy|`); `null` otherwise.
 */
export function classifySwipe(dx, dy) {
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE_PX) return null;
  if (Math.abs(dx) <= SWIPE_MIN_RATIO * Math.abs(dy)) return null;
  return dx < 0 ? 'next' : 'prev';
}

/**
 * Maps a lightbox keydown to a navigation action.
 * @param {{ key: string, targetTag: string, altKey: boolean,
 *   ctrlKey: boolean, metaKey: boolean }} event - Plain fields lifted from
 *   the `KeyboardEvent` (no DOM object required).
 * @returns {'prev' | 'next' | null} `'prev'`/`'next'` for a plain
 *   ArrowLeft/ArrowRight; `null` when a modifier is held, the key is
 *   anything else, or the event target is the `<video>` (which handles
 *   arrow keys itself for native seeking).
 */
export function keyAction({ key, targetTag, altKey, ctrlKey, metaKey }) {
  if (targetTag === 'VIDEO') return null;
  if (altKey || ctrlKey || metaKey) return null;
  if (key === 'ArrowLeft') return 'prev';
  if (key === 'ArrowRight') return 'next';
  return null;
}

/**
 * Decides where focus must move before the prev/next buttons are
 * (re-)disabled, so a focused button that becomes `disabled` never drops
 * focus to `<body>` (outside the dialog, where its arrow-key listener no
 * longer fires).
 * @param {{ focused: 'prev' | 'next' | 'other', atStart: boolean, atEnd: boolean }} state
 * @returns {'prev' | 'next' | 'close' | null} The control to focus, or
 *   `null` when the focused control stays enabled.
 */
export function navFocusTarget({ focused, atStart, atEnd }) {
  if (focused === 'prev' && atStart) return atEnd ? 'close' : 'next';
  if (focused === 'next' && atEnd) return atStart ? 'close' : 'prev';
  return null;
}
