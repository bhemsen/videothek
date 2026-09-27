/**
 * Page-private inline-SVG icons for the image gallery and its lightbox:
 * folder, play, image-off, chevron-left/right, close. Built with P1's
 * `createIcon` on the same 24x24 grid and `currentColor` fill — P1's
 * `public/js/lib/icons.js` is never edited (its own `icon('images')` set
 * covers only the five category glyphs). `chevronLeftIcon`/`chevronRightIcon`/
 * `closeIcon` are consumed by the lightbox issue (#84), not by this page.
 */
import { createIcon } from './lib/icons.js';

/**
 * The small folder badge shown on every folder tile and, larger, as a
 * fallback when a folder has no cover image.
 * @returns {SVGSVGElement}
 */
export function folderIcon() {
  return createIcon(['M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z']);
}

/**
 * The play glyph shown on a playable video tile's placeholder surface.
 * @returns {SVGSVGElement}
 */
export function playIcon() {
  return createIcon(['M8 5v14l11-7z']);
}

/**
 * The crossed-out picture glyph shown on a non-playable image or video tile.
 * @returns {SVGSVGElement}
 */
export function imageOffIcon() {
  return createIcon([
    'M21 5c0-1.1-.9-2-2-2H8.2l2 2H19v12.2l1.6 1.6c.2-.3.4-.7.4-1.1V5zM3.4 2 2 3.4 3.6 5H5v.6L3 7.6V19c0 1.1.9 2 2 2h13.4l1.6 1.6 1.4-1.4L3.4 2zM7 17l2.5-3.2 1.8 2.17L13.8 13 17 17H7z',
  ]);
}

/**
 * The lightbox's "previous" chevron.
 * @returns {SVGSVGElement}
 */
export function chevronLeftIcon() {
  return createIcon(['M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z']);
}

/**
 * The lightbox's "next" chevron.
 * @returns {SVGSVGElement}
 */
export function chevronRightIcon() {
  return createIcon(['M8.59 16.59 10 18l6-6-6-6-1.41 1.41L13.17 12z']);
}

/**
 * The lightbox's close glyph.
 * @returns {SVGSVGElement}
 */
export function closeIcon() {
  return createIcon([
    'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  ]);
}
