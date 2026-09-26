/**
 * Pure keyboard-shortcut mapping for the video player page. Holds no DOM
 * access: `public/js/player.js` builds the descriptor from a `keydown`
 * event and decides whether to act on the returned action.
 */

/**
 * @typedef {object} PlayerKeyEvent
 * @property {string} key - `KeyboardEvent.key` of the pressed key.
 * @property {boolean} ctrlKey - `KeyboardEvent.ctrlKey`.
 * @property {boolean} altKey - `KeyboardEvent.altKey`.
 * @property {boolean} metaKey - `KeyboardEvent.metaKey`.
 * @property {string} tagName - Uppercased `tagName` of `event.target`.
 * @property {boolean} isContentEditable - `event.target.isContentEditable`.
 */

/** @typedef {'toggle' | 'back' | 'forward' | 'fullscreen' | 'mute'} PlayerKeyAction */

/** Target tags that keep their own keyboard behaviour instead of the player shortcut. */
const IGNORED_TARGET_TAGS = new Set(['VIDEO', 'BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']);

/**
 * Maps a keydown descriptor to a player action. Returns `null` when a
 * modifier key is held, the event target is one of the ignored tags or is
 * content-editable, or the key itself has no mapping.
 *
 * @param {PlayerKeyEvent} event - Descriptor derived from a `KeyboardEvent`.
 * @returns {PlayerKeyAction | null} The action for this key, or `null`.
 */
export function keyAction({ key, ctrlKey, altKey, metaKey, tagName, isContentEditable }) {
  if (ctrlKey || altKey || metaKey || isContentEditable) return null;
  if (IGNORED_TARGET_TAGS.has(tagName)) return null;

  switch (key) {
    case ' ':
    case 'k':
    case 'K':
      return 'toggle';
    case 'ArrowLeft':
      return 'back';
    case 'ArrowRight':
      return 'forward';
    case 'f':
    case 'F':
      return 'fullscreen';
    case 'm':
    case 'M':
      return 'mute';
    default:
      return null;
  }
}
