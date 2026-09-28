/**
 * "Weiterhören" row on the start page: the latest unfinished music track
 * plus every in-progress audiobook, as a horizontal scroll-snap list of
 * cover cards linking into the audio pages (no playback on "/"). Injects its
 * own stylesheet plus `audio.css` (class-scoped, reused for `coverImg` and
 * its `.cover-img` anchor) — see docs/architecture.md "Start page" and key
 * flow 8.
 */
import { el } from './dom.js';
import { coverImg } from '../audio/cover-img.js';
import { getListening } from './home-api.js';
import { listenHref, listenFraction, listenProgressText, listenMeta } from './home-format.js';
import { injectStylesheet } from './stylesheet.js';
import { handleRowArrowKeys } from './row-keys.js';

/** @typedef {import('./home-api.js').ListeningItem} ListeningItem */

/**
 * The card's `data-kind`/id dataset, used by tooling and for a stable
 * per-item DOM identity.
 * @param {ListeningItem} item
 * @returns {Record<string, string>}
 */
function cardDataset(item) {
  return item.kind === 'music'
    ? { kind: 'music', trackId: String(item.trackId) }
    : { kind: 'audiobook', bookId: String(item.id) };
}

/**
 * Builds one "Weiterhören" card: cover with progress bar, title and meta line.
 * @param {ListeningItem} item
 * @returns {HTMLElement}
 */
function buildCard(item) {
  const cover = coverImg({ coverId: item.coverId, kind: item.kind === 'music' ? 'album' : 'book', alt: '' });
  const bar = el('div', { class: 'listen-row__bar' });
  bar.style.setProperty('--progress', String(listenFraction(item)));
  cover.append(bar, el('span', { class: 'visually-hidden' }, listenProgressText(item)));
  const link = el(
    'a',
    { class: 'listen-row__link', href: listenHref(item) },
    cover,
    el('p', { class: 'listen-row__title' }, item.title),
    el('p', { class: 'listen-row__meta' }, listenMeta(item)),
  );
  return el('li', { class: 'listen-row__card', dataset: cardDataset(item) }, link);
}

/**
 * Mounts the "Weiterhören" row into `container`. Fetches the current items;
 * mounts nothing and resolves `false` when the request fails or there is
 * nothing to show.
 * @param {HTMLElement} container
 * @returns {Promise<boolean>}
 */
export async function mountListenRow(container) {
  injectStylesheet('/css/listen-row.css');
  injectStylesheet('/css/audio.css');
  let items;
  try {
    items = await getListening();
  } catch {
    return false;
  }
  if (items.length === 0) return false;

  const list = el('ul', {
    class: 'listen-row__list',
    onKeydown: (/** @type {Event} */ event) =>
      handleRowArrowKeys(/** @type {KeyboardEvent} */ (event), [...list.querySelectorAll('.listen-row__link')]),
  });
  for (const item of items) list.append(buildCard(item));

  container.append(el('section', { class: 'listen-row', 'aria-label': 'Weiterhören' }, el('h2', {}, 'Weiterhören'), list));
  return true;
}
