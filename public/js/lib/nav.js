/**
 * Category navigation: the five fixed entries, rendered as a single
 * `<nav>` that `shell.css` lays out as a bottom bar (< 768 px) or a top bar
 * (>= 768 px). Nobody but this module edits the entry list.
 */
import { el } from './dom.js';
import { icon } from './icons.js';

/** @typedef {import('./icons.js').IconName} IconName */

/**
 * @typedef {{ id: string, label: string, href: string }} NavEntry
 */

/** @type {readonly NavEntry[]} */
export const NAV_ENTRIES = Object.freeze(
  [
    ['movies', 'Filme'],
    ['series', 'Serien'],
    ['music', 'Musik'],
    ['audiobooks', 'Hörbücher'],
    ['images', 'Bilder'],
  ].map(([id, label]) => Object.freeze({ id, label, href: `/${id}` })),
);

/**
 * Renders the category nav. The active entry (if any) carries
 * `aria-current="page"`. Left/Right move focus between entries (wrapping),
 * Home/End jump to the first/last entry; all entries stay in the Tab order.
 * @param {string | null} [active]
 * @returns {HTMLElement}
 */
export function renderNav(active = null) {
  const links = NAV_ENTRIES.map((entry) => renderLink(entry, entry.id === active));
  return el(
    'nav',
    {
      class: 'app-nav',
      'aria-label': 'Kategorien',
      onKeydown: (/** @type {Event} */ event) => handleKeydown(/** @type {KeyboardEvent} */ (event), links),
    },
    ...links,
  );
}

/**
 * @param {NavEntry} entry
 * @param {boolean} isActive
 * @returns {HTMLElement}
 */
function renderLink(entry, isActive) {
  return el(
    'a',
    {
      class: 'nav-link',
      href: entry.href,
      dataset: { nav: entry.id },
      'aria-current': isActive ? 'page' : null,
    },
    icon(/** @type {IconName} */ (entry.id)),
    el('span', { class: 'nav-label' }, entry.label),
  );
}

/**
 * @param {KeyboardEvent} event
 * @param {HTMLElement[]} links
 * @returns {void}
 */
function handleKeydown(event, links) {
  const index = links.indexOf(/** @type {HTMLElement} */ (event.target));
  if (index === -1) return;
  const lastIndex = links.length - 1;
  const nextIndex = nextLinkIndex(event.key, index, lastIndex);
  if (nextIndex === null) return;
  event.preventDefault();
  links[nextIndex].focus();
}

/**
 * @param {string} key
 * @param {number} index
 * @param {number} lastIndex
 * @returns {number | null}
 */
function nextLinkIndex(key, index, lastIndex) {
  if (key === 'ArrowRight') return index === lastIndex ? 0 : index + 1;
  if (key === 'ArrowLeft') return index === 0 ? lastIndex : index - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return lastIndex;
  return null;
}
