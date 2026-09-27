/**
 * Progress bar / "Gesehen" badge on P2's movie cards and episode rows.
 * Injects its own stylesheet (`progress-badges.css`) since no other phase's
 * HTML file is edited. See docs/specs/spec-progress-resume.md "Grid
 * decoration".
 */

import { el } from './dom.js';
import { createIcon } from './icons.js';
import { listProgress } from './progress.js';

/** @typedef {import('./progress.js').ProgressEntry} ProgressEntry */

const STYLESHEET_HREF = '/css/progress-badges.css';
/** P2's DOM contract: the host element a decoration is appended to. */
const HOST_SELECTOR = '.media-card__tile, .episode-row';
/** Marks every node this module appends, so `decorateProgress` can find and remove earlier decorations. */
const DECORATION_ATTR = 'data-progress-decoration';

/**
 * Appends the module's stylesheet to `<head>` once, idempotently.
 * @returns {void}
 */
function injectStylesheet() {
  if (document.head.querySelector(`link[href="${STYLESHEET_HREF}"]`)) return;
  document.head.append(el('link', { rel: 'stylesheet', href: STYLESHEET_HREF }));
}

/**
 * The check glyph for the "Gesehen" pill — beyond P1's icon set, so defined
 * here rather than editing `icons.js` or P2's `library-icons.js`.
 * @returns {SVGSVGElement}
 */
function checkIcon() {
  return createIcon(['M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z']);
}

/**
 * @param {ProgressEntry} entry
 * @returns {number}
 */
function fractionOf(entry) {
  return entry.duration ? Math.min(1, Math.max(0, entry.position / entry.duration)) : 0;
}

/**
 * Builds the 4 px "in progress" bar plus its visually hidden percentage text.
 * @param {ProgressEntry} entry
 * @returns {HTMLElement}
 */
function buildBar(entry) {
  const fraction = fractionOf(entry);
  const bar = el(
    'div',
    { class: 'progress-badge-bar', dataset: { progressDecoration: 'true' } },
    el('span', { class: 'visually-hidden' }, `Zu ${Math.round(fraction * 100)} % gesehen`),
  );
  bar.style.setProperty('--progress', String(fraction));
  return bar;
}

/**
 * Builds the "Gesehen" pill.
 * @returns {HTMLElement}
 */
function buildFinishedPill() {
  return el(
    'span',
    { class: 'progress-badge-pill', dataset: { progressDecoration: 'true' } },
    checkIcon(),
    'Gesehen',
  );
}

/**
 * Resolves the decoration host for a `[data-item-id]` node per P2's DOM
 * contract: the node itself if it already is a host, else its first matching
 * descendant, else `null` (caller skips it).
 * @param {Element} node
 * @returns {Element | null}
 */
function resolveHost(node) {
  if (node.matches(HOST_SELECTOR)) return node;
  return node.querySelector(HOST_SELECTOR);
}

/**
 * @param {Element} root
 * @returns {void}
 */
function clearDecorations(root) {
  for (const node of root.querySelectorAll(`[${DECORATION_ATTR}]`)) node.remove();
}

/**
 * Decorates every `[data-item-id]` element under `root` that has a matching
 * entry: idempotent (removes earlier decorations from this module first),
 * `in_progress` gets the bar, `finished` gets the pill, anything else (and
 * series cards, which carry no `data-item-id`) is left untouched.
 * @param {Element} root
 * @param {ProgressEntry[]} entries
 * @returns {void}
 */
export function decorateProgress(root, entries) {
  clearDecorations(root);
  if (entries.length === 0) return;
  const byItemId = new Map(entries.map((entry) => [String(entry.itemId), entry]));
  for (const node of root.querySelectorAll('[data-item-id]')) {
    const entry = byItemId.get(/** @type {HTMLElement} */ (node).dataset.itemId ?? '');
    if (entry === undefined) continue;
    const host = resolveHost(node);
    if (host === null) continue;
    if (entry.state === 'in_progress') host.append(buildBar(entry));
    else if (entry.state === 'finished') host.append(buildFinishedPill());
  }
}

/**
 * Fetches `category`'s grid-decoration entries and applies `decorateProgress`.
 * A failed fetch leaves the page undecorated (never throws).
 * @param {Element} root
 * @param {string} category
 * @returns {Promise<void>}
 */
export async function decorateProgressFor(root, category) {
  injectStylesheet();
  /** @type {ProgressEntry[]} */
  let entries;
  try {
    entries = await listProgress({ category, view: 'all' });
  } catch {
    return;
  }
  decorateProgress(root, entries);
}
