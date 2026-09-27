/**
 * The inline SVG icons the video player page needs beyond P1's `icon(name)`
 * set: the back-button chevron, the "Nächste Folge" skip glyph, the
 * destructive film-off glyph shown atop every error panel, and the "Nicht
 * abspielbar" badge's ban glyph. Built with P1's `createIcon`, same 24x24
 * grid and `currentColor` fill. Kept separate from P2's `library-icons.js`
 * (own module per page, see docs/specs/spec-video-streaming.md Decision log
 * "Frontend split").
 */

import { createIcon } from './lib/icons.js';

/**
 * The back-button chevron (points left).
 * @returns {SVGSVGElement}
 */
export function chevronIcon() {
  return createIcon(['M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z']);
}

/**
 * The "Nächste Folge" skip-forward glyph.
 * @returns {SVGSVGElement}
 */
export function skipIcon() {
  return createIcon(['M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z']);
}

/**
 * The destructive film-strip-with-slash glyph shown at the top of every
 * error panel (48 px via CSS). The frame is an outlined (hollow) rounded
 * rectangle — two oppositely-wound rounded-rect subpaths in one `d`, so the
 * default nonzero fill rule punches out the interior — so the diagonal slash
 * stays visible instead of disappearing onto a solid fill.
 * @returns {SVGSVGElement}
 */
export function filmOffIcon() {
  return createIcon([
    'M5 4H19A2 2 0 0 1 21 6V18A2 2 0 0 1 19 20H5A2 2 0 0 1 3 18V6A2 2 0 0 1 5 4ZM5 6V18H19V6H5Z',
    'M6 7h2v2H6zM16 7h2v2h-2zM6 15h2v2H6zM16 15h2v2h-2z',
    'M4.7 3.29L3.29 4.7l16 16 1.41-1.41z',
  ]);
}

/**
 * The "Nicht abspielbar" badge's ban glyph (a circle with a diagonal slash).
 * @returns {SVGSVGElement}
 */
export function banIcon() {
  return createIcon([
    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9C4.63 15.55 4 13.85 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1C19.37 8.45 20 10.15 20 12c0 4.42-3.58 8-8 8z',
  ]);
}
