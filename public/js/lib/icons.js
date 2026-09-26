/**
 * Inline SVG icon builder. No icon fonts, no external requests — every icon
 * is a `<path>` list drawn on a 24x24 grid, colored via `currentColor` so it
 * follows the surrounding text/button color.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @typedef {'logo' | 'movies' | 'series' | 'music' | 'audiobooks' | 'images' |
 *   'chevron-down' | 'users' | 'logout' | 'alert'} IconName
 */

/**
 * Builds an inline SVG icon from one or more path definitions.
 * @param {string[]} paths
 * @param {{ viewBox?: string }} [options]
 * @returns {SVGSVGElement}
 */
export function createIcon(paths, { viewBox = '0 0 24 24' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
  }
  return svg;
}

/** @type {Record<IconName, string[]>} */
const ICON_PATHS = {
  logo: [
    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
    'M10 8l6 4-6 4V8z',
  ],
  movies: [
    'M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4zM4 10h16v8H4v-8z',
  ],
  series: [
    'M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z',
  ],
  music: [
    'M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z',
  ],
  audiobooks: [
    'M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h4c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z',
  ],
  images: [
    'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z',
  ],
  'chevron-down': [
    'M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z',
  ],
  users: [
    'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
  ],
  logout: [
    'M17 7l-1.41 1.41L17.17 10H9v2h8.17l-1.58 1.58L17 15l4-4zM5 5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h7v-2H5V5z',
  ],
  alert: [
    'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-6h2v6z',
  ],
};

/**
 * Returns a named icon as a freshly built inline SVG element (`aria-hidden`,
 * `focusable="false"`).
 * @param {IconName} name
 * @returns {SVGSVGElement}
 */
export function icon(name) {
  return createIcon(ICON_PATHS[name]);
}
