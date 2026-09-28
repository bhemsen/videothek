/**
 * Shared Left/Right card-row navigation for the new home rows.
 * `continue-row.js` keeps its own byte-identical copy of this logic instead
 * of importing it.
 */

/**
 * @param {string} key
 * @param {number} index focused link index (-1 = focus not on a link)
 * @param {number} count
 * @returns {number} target index, or -1 when the key is not handled (not
 *   ArrowLeft/ArrowRight, index -1, or an end of the row — no wrap)
 */
export function nextRowIndex(key, index, count) {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return -1;
  if (index === -1) return -1;
  const next = index + (key === 'ArrowRight' ? 1 : -1);
  return next < 0 || next >= count ? -1 : next;
}

/**
 * Moves focus between card links on Left/Right (no wrap) and scrolls the
 * newly focused card into view; a no-op when the key is not handled or focus
 * is not on one of `links` (e.g. a "×" button) — identical to
 * continue-row's handleArrowKeys.
 * @param {KeyboardEvent} event
 * @param {Element[]} links
 * @returns {void}
 */
export function handleRowArrowKeys(event, links) {
  const index = links.indexOf(/** @type {Element} */ (event.target));
  const next = nextRowIndex(event.key, index, links.length);
  if (next === -1) return;
  event.preventDefault();
  const target = /** @type {HTMLElement} */ (links[next]);
  target.focus();
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
