/**
 * Cover image with a placeholder fallback: never leaves a broken-image icon
 * on screen. Used by album/book cards, the album/book detail header, the
 * Musik "Weiterhören" card and the bar cover. See
 * spec-music-audiobooks.md "Cover images".
 */
import { el } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

/** @typedef {'album' | 'book'} CoverKind */

/**
 * Builds a square cover wrapper. `coverId` null shows the placeholder
 * immediately; otherwise an `<img>` is inserted and, on its `error` event
 * (a 404 or any load failure), removed and replaced by the same
 * placeholder — the wrapper never keeps a src-less `<img>` around.
 * @param {{ coverId: number | null, kind: CoverKind, alt?: string, lazy?: boolean }} params
 * @returns {HTMLElement}
 */
export function coverImg({ coverId, kind, alt = '', lazy = false }) {
  const wrapper = el('div', { class: 'cover-img' });
  if (coverId === null) {
    wrapper.append(buildPlaceholder(kind));
    return wrapper;
  }
  const img = /** @type {HTMLImageElement} */ (
    el('img', { src: `/media/${coverId}/cover`, alt, decoding: 'async', loading: lazy ? 'lazy' : null })
  );
  img.addEventListener('error', () => {
    img.remove();
    wrapper.append(buildPlaceholder(kind));
  });
  wrapper.append(img);
  return wrapper;
}

/**
 * @param {CoverKind} kind
 * @returns {HTMLElement}
 */
function buildPlaceholder(kind) {
  return el(
    'span',
    { class: 'cover-img__placeholder', 'aria-hidden': 'true' },
    icon(kind === 'album' ? 'music' : 'audiobooks'),
  );
}
