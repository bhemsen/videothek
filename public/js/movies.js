/**
 * Filme page (`/movies`): header (title + count + A–Z / "Neu hinzugefügt"
 * sort links), loading/first-scan/empty/error states and the movie card
 * grid. See docs/specs/spec-library-video.md "UI".
 */
import { el, createEmptyState } from './lib/dom.js';
import { mountShell } from './lib/shell.js';
import { getCategory } from './lib/library-api.js';
import { createMovieCard } from './lib/media-card.js';
import { pluralize } from './lib/library-format.js';

/** @typedef {import('./lib/library-api.js').CategoryItemsResponse} CategoryItemsResponse */

/** Re-fetch cadence while the library's first scan is still running. */
const FIRST_SCAN_POLL_MS = 5000;

const { main } = mountShell({ active: 'movies' });

/** The URL's `sort` param, normalised: anything other than `'added'` is `'title'` and is never sent to the API. */
const sort = new URLSearchParams(location.search).get('sort') === 'added' ? 'added' : 'title';

const heading = el('h1', { class: 'shell-title', tabindex: '-1' }, 'Filme');
const count = el('span', { class: 'library-header__count' });
const header = el(
  'div',
  { class: 'library-header' },
  el('div', { class: 'library-header__titles' }, heading, count),
  buildSortControl(sort),
);
const content = el('div', {});

main.append(header, content);

/** @type {ReturnType<typeof setTimeout> | null} */
let pollTimer = null;

load();

/**
 * @param {'title' | 'added'} active
 * @returns {HTMLElement}
 */
function buildSortControl(active) {
  return el(
    'nav',
    { class: 'sort-control', 'aria-label': 'Sortierung' },
    el(
      'a',
      { class: 'sort-control__link', href: '/movies', 'aria-current': active === 'title' ? 'true' : null },
      'A–Z',
    ),
    el(
      'a',
      { class: 'sort-control__link', href: '/movies?sort=added', 'aria-current': active === 'added' ? 'true' : null },
      'Neu hinzugefügt',
    ),
  );
}

/**
 * Fetches the movies list and renders the resulting state. A 401 is already
 * redirected to `/login` by `request()` itself (see admin.js for the same
 * pattern) — no special-casing needed here.
 * @returns {Promise<void>}
 */
async function load() {
  clearPoll();
  try {
    const response = /** @type {CategoryItemsResponse} */ (await getCategory('movies', sort));
    renderResult(response);
  } catch {
    renderError();
  }
}

/**
 * @param {CategoryItemsResponse} response
 * @returns {void}
 */
function renderResult(response) {
  count.textContent = pluralize(response.items.length, 'Titel', 'Titel');
  if (response.items.length > 0) {
    setContent(el('div', { class: 'library-grid' }, ...response.items.map(createMovieCard)));
    return;
  }
  if (response.scan.running) {
    setContent(
      createEmptyState({
        title: 'Bibliothek wird eingelesen …',
        text: 'Beim ersten Start kann das einige Minuten dauern.',
      }),
    );
    pollTimer = setTimeout(load, FIRST_SCAN_POLL_MS);
    return;
  }
  setContent(
    createEmptyState({
      title: 'Noch keine Filme',
      text: 'Lege Videodateien im Ordner „Filme“ ab – neue Dateien erscheinen nach wenigen Sekunden automatisch.',
    }),
  );
}

/** @returns {void} */
function renderError() {
  const state = el(
    'div',
    { class: 'empty-state' },
    el('p', { class: 'empty-state-title' }, 'Die Bibliothek konnte nicht geladen werden.'),
    el('button', { type: 'button', class: 'btn btn-secondary', onClick: load }, 'Erneut versuchen'),
  );
  setContent(state);
}

/**
 * @param {HTMLElement} node
 * @returns {void}
 */
function setContent(node) {
  content.replaceChildren(node);
}

/** @returns {void} */
function clearPoll() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}
