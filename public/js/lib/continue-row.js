/**
 * "Weiterschauen" row on the start page: the user's in-progress movies and
 * episodes plus "Nächste Folge" cards, in a horizontal scroll-snap list.
 * Injects its own stylesheet (`continue-row.css`) since no other phase's
 * HTML file is edited. See docs/specs/spec-progress-resume.md "UI behaviour".
 */

import { el } from './dom.js';
import { icon } from './icons.js';
import { formatRemaining, listProgress, removeProgress } from './progress.js';

/** @typedef {import('./progress.js').ProgressEntry} ProgressEntry */

/**
 * The shape of `ProgressEntry.item` this row reads (a subset of P2's
 * `ItemJson` re-declared locally so this module never imports across the
 * server/frontend boundary).
 * @typedef {{ seriesId: number | null, seriesTitle: string | null, title: string, season: number | null, episode: number | null }} ContinueItem
 */

const STYLESHEET_HREF = '/css/continue-row.css';
const MIDDLE_DOT = '·';
const REMOVE_FAILED_TEXT = 'Entfernen fehlgeschlagen. Bitte erneut versuchen.';

/**
 * Appends the row's stylesheet to `<head>` once, idempotently.
 * @returns {void}
 */
function injectStylesheet() {
  if (document.head.querySelector(`link[href="${STYLESHEET_HREF}"]`)) return;
  document.head.append(el('link', { rel: 'stylesheet', href: STYLESHEET_HREF }));
}

/**
 * The "S1 · F3" / "Special · F3" part of a card's meta line, or `null` when
 * the season or episode is unknown (the part is then omitted entirely).
 * @param {number | null} season
 * @param {number | null} episode
 * @returns {string | null}
 */
function seasonEpisodePart(season, episode) {
  if (season === null || episode === null) return null;
  return season === 0 ? `Special ${MIDDLE_DOT} F${episode}` : `S${season} ${MIDDLE_DOT} F${episode}`;
}

/**
 * Builds a card's meta line: an episode prefixes its season/episode part
 * (omitted when either is unknown); every card but a `next_up` one appends
 * the remaining time; a `next_up` card shows only the season/episode part.
 * @param {ProgressEntry} entry
 * @returns {string}
 */
export function cardMeta(entry) {
  const item = /** @type {ContinueItem} */ (entry.item);
  const parts = [];
  if (item.seriesId !== null) {
    const seasonEpisode = seasonEpisodePart(item.season, item.episode);
    if (seasonEpisode !== null) parts.push(seasonEpisode);
  }
  if (entry.state !== 'next_up' && entry.duration !== null) parts.push(formatRemaining(entry.duration - entry.position));
  return parts.join(` ${MIDDLE_DOT} `);
}

/**
 * The remaining card's focus target after removing the card at
 * `removedIndex` out of `count` original cards: the same index (now holding
 * the next card), the previous index when the last card was removed, or
 * `-1` when it was the only card.
 * @param {number} count
 * @param {number} removedIndex
 * @returns {number}
 */
export function nextFocusIndex(count, removedIndex) {
  if (count <= 1) return -1;
  return removedIndex < count - 1 ? removedIndex : removedIndex - 1;
}

/**
 * Builds the tile's content: the film icon plus, for an in-progress entry,
 * the progress bar and its hidden percentage text, or, for a `next_up`
 * entry, the "Nächste Folge" pill instead.
 * @param {ProgressEntry} entry
 * @returns {HTMLElement}
 */
function buildTile(entry) {
  const children = [el('span', { class: 'continue-row__icon' }, icon('movies'))];
  if (entry.state === 'next_up') {
    children.push(el('span', { class: 'continue-row__pill' }, 'Nächste Folge'));
    return el('div', { class: 'continue-row__tile' }, ...children);
  }
  const fraction = entry.duration ? Math.min(1, Math.max(0, entry.position / entry.duration)) : 0;
  const bar = el('div', { class: 'continue-row__bar' });
  bar.style.setProperty('--progress', String(fraction));
  children.push(bar, el('span', { class: 'visually-hidden' }, `Zu ${Math.round(fraction * 100)} % gesehen`));
  return el('div', { class: 'continue-row__tile' }, ...children);
}

/**
 * Removes `li` from `list` and moves focus per the exported focus rule;
 * empties the row (removes `section`, hands focus to the page's H1) when it
 * was the last card, else focuses the neighbouring card's link.
 * @param {HTMLElement} section
 * @param {HTMLElement} list
 * @param {HTMLElement} li
 * @returns {void}
 */
function removeCard(section, list, li) {
  const cards = [...list.children];
  const target = nextFocusIndex(cards.length, cards.indexOf(li));
  li.remove();
  if (target === -1) {
    section.remove();
    /** @type {HTMLElement | null} */ (document.querySelector('h1'))?.focus();
    return;
  }
  const focusLink = list.children[target]?.querySelector('.continue-row__link');
  /** @type {HTMLElement | null} */ (focusLink)?.focus();
}

/**
 * Wires a card's "×" button: on success it is removed per `removeCard`; on
 * failure it stays and `status` reports the German error line.
 * @param {ProgressEntry} entry
 * @param {HTMLElement} section
 * @param {HTMLElement} list
 * @param {HTMLElement} li
 * @param {HTMLElement} status
 * @returns {() => Promise<void>}
 */
function handleRemove(entry, section, list, li, status) {
  return async () => {
    try {
      await removeProgress(entry.itemId);
    } catch {
      status.hidden = false;
      status.textContent = REMOVE_FAILED_TEXT;
      return;
    }
    removeCard(section, list, li);
  };
}

/**
 * Builds one card `<li>`: the tile/title/meta link, plus a "×" button for an
 * in-progress entry (never for `next_up`).
 * @param {ProgressEntry} entry
 * @param {HTMLElement} section
 * @param {HTMLElement} list
 * @param {HTMLElement} status
 * @returns {HTMLElement}
 */
function buildCard(entry, section, list, status) {
  const item = /** @type {ContinueItem} */ (entry.item);
  const title = item.seriesId !== null ? (item.seriesTitle ?? item.title) : item.title;
  const link = el(
    'a',
    { class: 'continue-row__link', href: `/player?id=${entry.itemId}` },
    buildTile(entry),
    el('p', { class: 'continue-row__title' }, title),
    el('p', { class: 'continue-row__meta' }, cardMeta(entry)),
  );
  const li = el('li', { class: 'continue-row__card', dataset: { itemId: String(entry.itemId) } }, link);
  if (entry.state === 'in_progress') {
    const button = /** @type {HTMLButtonElement} */ (
      el('button', { type: 'button', class: 'continue-row__remove', 'aria-label': 'Aus Weiterschauen entfernen' }, '×')
    );
    button.addEventListener('click', handleRemove(entry, section, list, li, status));
    li.append(button);
  }
  return li;
}

/**
 * Moves focus between card links on Left/Right (no wrap) and scrolls the
 * newly focused card into view; a no-op when focus is elsewhere (e.g. a "×"
 * button) or at either end of the row.
 * @param {KeyboardEvent} event
 * @param {HTMLElement} list
 * @returns {void}
 */
function handleArrowKeys(event, list) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const links = [...list.querySelectorAll('.continue-row__link')];
  const index = links.indexOf(/** @type {Element} */ (event.target));
  if (index === -1) return;
  const nextIndex = index + (event.key === 'ArrowRight' ? 1 : -1);
  if (nextIndex < 0 || nextIndex >= links.length) return;
  event.preventDefault();
  const target = /** @type {HTMLElement} */ (links[nextIndex]);
  target.focus();
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/**
 * Mounts the "Weiterschauen" row into `container`. Fetches the user's
 * in-progress movies/episodes plus "Nächste Folge" entries; mounts nothing
 * and resolves `false` when the request fails or there is nothing to show.
 * A caller owns the surrounding empty-state toggle (see `home.js`), reacting
 * to `container`'s children rather than this return value, since a later
 * card removal can also empty the row.
 * @param {HTMLElement} container
 * @returns {Promise<boolean>}
 */
export async function mountContinueRow(container) {
  injectStylesheet();
  let entries;
  try {
    entries = await listProgress({ category: ['movies', 'series'], view: 'continue' });
  } catch {
    return false;
  }
  if (entries.length === 0) return false;

  const status = el('p', { class: 'continue-row__status', role: 'status', hidden: true });
  const list = el('ul', {
    class: 'continue-row__list',
    onKeydown: (/** @type {Event} */ event) => handleArrowKeys(/** @type {KeyboardEvent} */ (event), list),
  });
  const section = el(
    'section',
    { class: 'continue-row', 'aria-label': 'Weiterschauen' },
    el('h2', {}, 'Weiterschauen'),
    status,
    list,
  );

  for (const entry of entries) list.append(buildCard(entry, section, list, status));

  container.append(section);
  return true;
}
