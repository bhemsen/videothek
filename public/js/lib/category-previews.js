/**
 * Category previews on the start page: one section per library category
 * (movies, series, music, audiobooks, images), each a horizontal row of the
 * category's most recently added items plus an "Alle anzeigen" link. Reuses
 * the category pages' own card builders and their (class-scoped) stylesheets
 * instead of duplicating card CSS — see docs/architecture.md "Start page"
 * and key flow 8.
 */
import { el } from './dom.js';
import { coverImg } from '../audio/cover-img.js';
import { createMovieCard, createSeriesCard } from './media-card.js';
import { createFolderTile } from '../image-tiles.js';
import { getPreviews } from './home-api.js';
import { PREVIEW_SECTIONS, previewCountLabel, albumCardText, bookCardText } from './home-format.js';
import { injectStylesheet } from './stylesheet.js';
import { handleRowArrowKeys } from './row-keys.js';

/** @typedef {import('./home-api.js').HomePreviews} HomePreviews */
/** @typedef {import('./home-format.js').PreviewCategory} PreviewCategory */
/** @typedef {import('./home-format.js').PreviewSection} PreviewSection */

/**
 * The `id` shared by a section's heading and its `aria-labelledby`.
 * @param {PreviewCategory} category
 * @returns {string}
 */
function headingId(category) {
  return `home-preview-${category}`;
}

/**
 * Builds one preview card around a cover image, for the two categories
 * (music, audiobooks) that have no private card builder of their own.
 * @param {{ href: string, title: string, meta: string }} text
 * @param {number} coverId
 * @param {'album' | 'book'} kind
 * @param {Record<string, string>} dataset
 * @returns {HTMLElement}
 */
function buildAudioCard(text, coverId, kind, dataset) {
  return el(
    'a',
    { class: 'category-preview__card', href: text.href, dataset },
    coverImg({ coverId, kind, alt: '', lazy: true }),
    el('p', { class: 'category-preview__title' }, text.title),
    el('p', { class: 'category-preview__meta' }, text.meta),
  );
}

/**
 * Builds one category's item cards, dispatching on the category so each
 * item type narrows from a literal-keyed read (no cast needed).
 * @param {PreviewCategory} category
 * @param {HomePreviews} data
 * @returns {HTMLElement[]}
 */
function cardsFor(category, data) {
  switch (category) {
    case 'movies':
      return data.movies.items.map(createMovieCard);
    case 'series':
      return data.series.items.map(createSeriesCard);
    case 'music':
      return data.music.items.map((a) => buildAudioCard(albumCardText(a), a.coverId, 'album', { albumId: String(a.id) }));
    case 'audiobooks':
      return data.audiobooks.items.map((b) => buildAudioCard(bookCardText(b), b.coverId, 'book', { bookId: String(b.id) }));
    case 'images':
      return data.images.items.map(createFolderTile);
  }
}

/**
 * Builds a section's header: heading, count and the "Alle anzeigen" link.
 * @param {PreviewSection} section
 * @param {number} count
 * @returns {HTMLElement}
 */
function buildHeader(section, count) {
  return el(
    'div',
    { class: 'category-preview__header' },
    el('h2', { class: 'category-preview__heading', id: headingId(section.category) }, section.label),
    el('span', { class: 'category-preview__count' }, previewCountLabel(section.category, count)),
    el(
      'a',
      { class: 'category-preview__all', href: section.allHref, 'aria-label': `Alle anzeigen: ${section.label}` },
      'Alle anzeigen',
    ),
  );
}

/**
 * Builds a section's card list, wired for Left/Right card navigation.
 * `null` when there are nothing to show (e.g. images with only root-level
 * loose files, which raise the count but yield no folder tile).
 * @param {HTMLElement[]} cards
 * @returns {HTMLElement | null}
 */
function buildList(cards) {
  if (cards.length === 0) return null;
  const list = el('ul', {
    class: 'category-preview__list',
    onKeydown: (/** @type {Event} */ event) =>
      handleRowArrowKeys(/** @type {KeyboardEvent} */ (event), [...list.querySelectorAll('.category-preview__item > a')]),
  });
  for (const card of cards) list.append(el('li', { class: 'category-preview__item' }, card));
  return list;
}

/**
 * Builds one category's full `<section>`: header plus the card list.
 * @param {PreviewSection} section
 * @param {HomePreviews} data
 * @returns {HTMLElement}
 */
function buildSection(section, data) {
  const { count } = data[section.category];
  return el(
    'section',
    { class: 'category-preview', 'aria-labelledby': headingId(section.category), dataset: { category: section.category } },
    buildHeader(section, count),
    buildList(cardsFor(section.category, data)),
  );
}

/**
 * Mounts the category previews into `container`: one section per category
 * with at least one item overall (`count > 0`), in nav order. Mounts nothing
 * and resolves `false` when the request fails or every category is empty.
 * @param {HTMLElement} container
 * @returns {Promise<boolean>}
 */
export async function mountCategoryPreviews(container) {
  injectStylesheet('/css/category-previews.css');
  injectStylesheet('/css/library.css');
  injectStylesheet('/css/images.css');
  injectStylesheet('/css/audio.css');
  let data;
  try {
    data = await getPreviews();
  } catch {
    return false;
  }
  const sections = PREVIEW_SECTIONS.filter((s) => data[s.category].count > 0).map((s) => buildSection(s, data));
  if (sections.length === 0) return false;

  container.append(el('div', { class: 'category-previews' }, ...sections));
  return true;
}
