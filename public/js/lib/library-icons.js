/**
 * The two inline SVG icons the library UI needs beyond P1's `icon(name)`
 * set (movies/series/… stay in `public/js/lib/icons.js`, never edited here):
 * the "not playable" ban glyph and the episode-row play glyph. Built with
 * P1's `createIcon`, same 24x24 grid and `currentColor` fill.
 */

import { createIcon } from './icons.js';

/**
 * The "Nicht abspielbar" ban glyph (a circle with a diagonal slash).
 * @returns {SVGSVGElement}
 */
export function banIcon() {
  return createIcon([
    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9C4.63 15.55 4 13.85 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1C19.37 8.45 20 10.15 20 12c0 4.42-3.58 8-8 8z',
  ]);
}

/**
 * The episode-row play glyph (a filled triangle).
 * @returns {SVGSVGElement}
 */
export function playIcon() {
  return createIcon(['M8 5v14l11-7z']);
}
