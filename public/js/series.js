/**
 * Serien page (`/series`): series cards in a responsive grid, sorted A–Z or
 * by "Neu hinzugefügt", with an empty state, a first-scan polling state and a
 * request-error retry state. See docs/specs/spec-library-video.md "UI".
 */
import { el, createEmptyState } from './lib/dom.js';
import { mountShell } from './lib/shell.js';
import { getCategory } from './lib/library-api.js';
import { createSeriesCard } from './lib/media-card.js';
import { pluralize } from './lib/library-format.js';

/** @typedef {import('./lib/library-api.js').LibrarySort} LibrarySort */
/** @typedef {import('./lib/library-api.js').SeriesSummary} SeriesSummary */

const FIRST_SCAN_POLL_MS = 5000;

const { main } = mountShell({ active: 'series' });
const sort = parseSortParam();

/** @type {ReturnType<typeof setTimeout> | null} */
let pollTimer = null;

load();

/**
 * Reads `sort` from the page URL: `'added'` -> `'added'`, anything else
 * (incl. absent) -> `'title'` — the page never sends an invalid value.
 * @returns {LibrarySort}
 */
function parseSortParam() {
  return new URLSearchParams(location.search).get('sort') === 'added' ? 'added' : 'title';
}

/**
 * Builds the "Serien" heading alone (loading/error state).
 * @returns {HTMLElement}
 */
function buildHeading() {
  return el('h1', { class: 'shell-title' }, 'Serien');
}

/**
 * Builds the two-link sort control, `aria-current="true"` on the active one.
 * @returns {HTMLElement}
 */
function buildSortNav() {
  return el(
    'nav',
    { class: 'sort-control', 'aria-label': 'Sortierung' },
    el('a', { class: 'sort-control__link', href: '/series', 'aria-current': sort === 'title' ? 'true' : null }, 'A–Z'),
    el(
      'a',
      { class: 'sort-control__link', href: '/series?sort=added', 'aria-current': sort === 'added' ? 'true' : null },
      'Neu hinzugefügt',
    ),
  );
}

/**
 * Builds the full header (heading + count + sort control) once the series
 * count is known.
 * @param {number} count
 * @returns {HTMLElement}
 */
function buildHeader(count) {
  return el(
    'div',
    { class: 'library-header' },
    el(
      'div',
      { class: 'library-header__heading' },
      buildHeading(),
      el('span', { class: 'library-header__count' }, pluralize(count, 'Serie', 'Serien')),
    ),
    buildSortNav(),
  );
}

/**
 * @param {SeriesSummary[]} series
 * @returns {HTMLElement}
 */
function buildGrid(series) {
  return el('section', { class: 'library-grid', 'aria-label': 'Serienübersicht' }, ...series.map(createSeriesCard));
}

/** @returns {HTMLElement} */
function buildFirstScanState() {
  return createEmptyState({
    title: 'Bibliothek wird eingelesen …',
    text: 'Beim ersten Start kann das einige Minuten dauern.',
  });
}

/** @returns {HTMLElement} */
function buildEmptyState() {
  return createEmptyState({
    title: 'Noch keine Serien',
    text: 'Lege Serien im Ordner „Serien“ ab, z. B. „Serien/Dark/Staffel 1/Dark S01E01.mp4“.',
  });
}

/**
 * @param {() => void} onRetry
 * @returns {HTMLElement}
 */
function buildErrorState(onRetry) {
  const state = createEmptyState({ title: 'Die Bibliothek konnte nicht geladen werden.', text: '' });
  state.append(el('button', { type: 'button', class: 'btn btn-secondary', onClick: onRetry }, 'Erneut versuchen'));
  return state;
}

/** @returns {void} */
function clearPoll() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

/**
 * Fetches the series list and re-renders `main`; empty + a running scan
 * schedules a re-fetch every 5 s until the list is non-empty or the scan
 * ended (each call clears any previous poll first, so calls never overlap).
 * @returns {Promise<void>}
 */
async function load() {
  clearPoll();
  main.replaceChildren(buildHeading());
  let response;
  try {
    response = /** @type {import('./lib/library-api.js').CategorySeriesResponse} */ (await getCategory('series', sort));
  } catch {
    main.replaceChildren(buildHeading(), buildErrorState(load));
    return;
  }
  const { series, scan } = response;
  const header = buildHeader(series.length);
  if (series.length === 0) {
    main.replaceChildren(header, scan.running ? buildFirstScanState() : buildEmptyState());
    if (scan.running) pollTimer = setTimeout(load, FIRST_SCAN_POLL_MS);
    return;
  }
  main.replaceChildren(header, buildGrid(series));
}
