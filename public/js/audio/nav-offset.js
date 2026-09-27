/**
 * Measures Phase 1's fixed mobile bottom nav so the persistent audio bar can
 * sit flush on top of it (issue 193). The spec's original "Bar layout"
 * assumed the nav is `--bar-height-mobile` tall; its real height comes from
 * `.nav-link`'s min-height plus border plus its own safe-area padding, so
 * the audio section measures it instead of assuming a length.
 */

/**
 * Keeps `--audio-bar-nav-offset` on `bar` equal to the live border-box
 * height of `.app-nav` (incl. its `padding-bottom:
 * env(safe-area-inset-bottom)`). The `ResizeObserver` watches the nav's
 * border box, so a change of the safe-area inset alone (padding only) also
 * updates the offset. `audio.css` reads the property for `.audio-bar`'s
 * `bottom` below 768 px; the >= 768 px rule overrides `bottom` to 0. No-op
 * (returns `null`) without a `.app-nav` or without `ResizeObserver`.
 * @param {HTMLElement} bar
 * @param {Pick<Document, 'querySelector'>} [doc]
 * @returns {ResizeObserver | null} the observer, for tests and teardown
 */
export function trackNavOffset(bar, doc = document) {
  const nav = doc.querySelector('.app-nav');
  if (nav === null || typeof ResizeObserver === 'undefined') return null;
  const update = () => bar.style.setProperty('--audio-bar-nav-offset', `${nav.getBoundingClientRect().height}px`);
  update();
  const observer = new ResizeObserver(update);
  observer.observe(nav, { box: 'border-box' });
  return observer;
}
