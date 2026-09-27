/**
 * Hörbücher grid: page heading + count, a "Weiterhören" row of in-progress
 * books and the full book grid. See spec-music-audiobooks.md "Views",
 * "Rows", "Grid (H3)" and "States and copy".
 */
import { el, createEmptyState } from '../../lib/dom.js';
import { getAudiobooks } from '../audio-api.js';
import { coverImg } from '../cover-img.js';
import { formatTotal, formatPercent } from '../format.js';

/** @typedef {import('../app.js').ViewParams} ViewParams */
/** @typedef {import('../audio-api.js').AudiobookSummary} AudiobookSummary */

const TITLE = 'Hörbücher';
const CONTINUE_LIMIT = 20;
const UNKNOWN_AUTHOR = 'Unbekannter Autor';
const MIDDLE_DOT = '·';

/**
 * @param {ViewParams} params
 * @returns {Promise<{ title: string }>}
 */
export async function render({ container }) {
  const heading = el('div', { class: 'book-grid-view__heading' }, el('h1', { class: 'shell-title' }, TITLE));
  container.append(heading);
  await load(container, heading);
  return { title: TITLE };
}

/**
 * Fetches the grid data and renders it below `heading`; a request failure
 * shows the retry state instead (retry re-runs this same function). Never
 * throws — the view contract requires `render` to resolve.
 * @param {HTMLElement} container @param {HTMLElement} heading
 * @returns {Promise<void>}
 */
async function load(container, heading) {
  /** @type {{ books: AudiobookSummary[] }} */
  let data;
  try {
    data = await getAudiobooks();
  } catch {
    container.append(buildError(() => reload(container)));
    return;
  }
  heading.append(el('span', { class: 'book-grid-view__count' }, pluralizeBooks(data.books.length)));
  container.append(buildContent(data.books));
}

/**
 * Clears everything but keeps rendering below a fresh heading, then reloads.
 * @param {HTMLElement} container
 * @returns {void}
 */
function reload(container) {
  const heading = el('div', { class: 'book-grid-view__heading' }, el('h1', { class: 'shell-title' }, TITLE));
  container.replaceChildren(heading);
  load(container, heading);
}

/**
 * @param {() => void} onRetry
 * @returns {HTMLElement}
 */
function buildError(onRetry) {
  const button = el('button', { type: 'button', class: 'btn btn-secondary' }, 'Erneut versuchen');
  button.addEventListener('click', onRetry);
  return el('div', { class: 'book-error' }, el('p', {}, 'Die Bibliothek konnte nicht geladen werden.'), button);
}

/**
 * @param {AudiobookSummary[]} books
 * @returns {HTMLElement}
 */
function buildContent(books) {
  if (books.length === 0) {
    return createEmptyState({
      title: 'Keine Hörbücher gefunden.',
      text: 'Lege Hörbücher im Ordner „Hörbücher“ ab, z. B. „Hörbücher/Autor/Titel/01.mp3“.',
    });
  }
  const fragment = el('div', { class: 'book-grid-view' });
  const continuing = booksToResume(books);
  if (continuing.length > 0) fragment.append(buildContinueRow(continuing));
  fragment.append(el('div', { class: 'book-grid' }, ...books.map(bookCard)));
  return fragment;
}

/**
 * In-progress books sorted by `lastPlayedAt` desc, capped at `CONTINUE_LIMIT`.
 * @param {AudiobookSummary[]} books
 * @returns {AudiobookSummary[]}
 */
function booksToResume(books) {
  return books
    .filter((book) => book.state === 'in_progress')
    .sort((a, b) => (b.lastPlayedAt ?? '').localeCompare(a.lastPlayedAt ?? ''))
    .slice(0, CONTINUE_LIMIT);
}

/**
 * @param {AudiobookSummary[]} books
 * @returns {HTMLElement}
 */
function buildContinueRow(books) {
  return el(
    'section',
    { class: 'book-row', 'aria-label': 'Weiterhören' },
    el('h2', {}, 'Weiterhören'),
    el(
      'ul',
      { class: 'book-row__list' },
      ...books.map((book) => el('li', { class: 'book-row__item' }, bookCard(book))),
    ),
  );
}

/** @param {number} count @returns {string} */
function pluralizeBooks(count) {
  return count === 1 ? '1 Hörbuch' : `${count} Hörbücher`;
}

/** @param {number} count @returns {string} */
function pluralizeFiles(count) {
  return count === 1 ? '1 Datei' : `${count} Dateien`;
}

/**
 * Builds one book card: cover (with a progress strip along its bottom edge
 * while in progress), title and one meta line combining the author with the
 * state-dependent status — a percentage when in progress, "Gehört" when
 * finished, else the file count and total duration.
 * @param {AudiobookSummary} book
 * @returns {HTMLElement}
 */
function bookCard(book) {
  const cover = coverImg({ coverId: book.coverId, kind: 'book', lazy: true });
  if (book.state === 'in_progress') cover.append(buildCoverBar(book.fraction));
  return el(
    'a',
    { class: 'book-card', href: `/audiobooks?book=${book.id}`, dataset: { bookId: String(book.id) } },
    cover,
    el('p', { class: 'book-card__title' }, book.title),
    el('p', { class: 'book-card__meta' }, bookCardStatus(book)),
  );
}

/** @param {number | null} fraction @returns {HTMLElement} */
function buildCoverBar(fraction) {
  const bar = el('div', { class: 'book-card__bar' });
  bar.style.setProperty('--progress', String(fraction ?? 0));
  return bar;
}

/**
 * @param {AudiobookSummary} book
 * @returns {string}
 */
function bookCardStatus(book) {
  const author = book.author ?? UNKNOWN_AUTHOR;
  if (book.state === 'in_progress') return `${author} ${MIDDLE_DOT} ${formatPercent(book.fraction)}`;
  if (book.state === 'finished') return `${author} ${MIDDLE_DOT} ✓ Gehört`;
  return `${author} ${MIDDLE_DOT} ${pluralizeFiles(book.fileCount)} ${MIDDLE_DOT} ${formatTotal(book.duration)}`;
}
