/**
 * Inline SVG icons for the audio player-bar controls — no icon fonts, no
 * external requests. Cover placeholders reuse the shared category glyphs
 * from `../lib/icons.js` instead of duplicating paths here.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** @typedef {'play' | 'pause' | 'previous' | 'next' | 'rewind' | 'forward'} AudioIconName */

/**
 * The "forward" control mirrors "rewind" via CSS (`.icon-mirror`, applied by
 * the caller), so only one path is needed for the pair.
 * @type {Record<AudioIconName, string[]>}
 */
const ICON_PATHS = {
  play: ['M8 5v14l11-7z'],
  pause: ['M6 19h4V5H6v14zM14 5v14h4V5h-4z'],
  previous: ['M6 6h2v12H6zm3.5 6l8.5 6V6z'],
  next: ['M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z'],
  rewind: [
    'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z',
  ],
  forward: [
    'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z',
  ],
};

/**
 * Returns a named audio-bar icon as a freshly built inline SVG element
 * (`aria-hidden`, `focusable="false"`); `forward` carries `.icon-mirror` so
 * `audio.css` can flip the shared rewind glyph horizontally.
 * @param {AudioIconName} name
 * @returns {SVGSVGElement}
 */
export function audioIcon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (name === 'forward') svg.setAttribute('class', 'icon-mirror');
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
  }
  return svg;
}
