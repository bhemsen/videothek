/**
 * Series detail page (`/series-detail?id=<seriesId>`): back link, header
 * (poster tile + title + meta), season chips jumping to in-page sections,
 * and one section per season (Staffel N, then Specials, then Weitere Folgen)
 * with its episode rows. See docs/specs/spec-library-video.md "UI".
 */
import { el, createEmptyState } from './lib/dom.js';
import { mountShell } from './lib/shell.js';
import { ApiError } from './lib/api.js';
import { getSeries } from './lib/library-api.js';
import { createPosterTile, createEpisodeRow } from './lib/media-card.js';
import { pluralize } from './lib/library-format.js';
import { decorateProgressFor } from './lib/progress-badges.js';

/** @typedef {import('./lib/library-api.js').SeriesDetail} SeriesDetail */
/** @typedef {import('./lib/library-api.js').SeriesSeason} SeriesSeason */

const ID_PATTERN = /^[1-9][0-9]{0,15}$/;
const MIDDLE_DOT = '·';

const { main } = mountShell({ active: 'series' });
const id = parseIdParam();

load();

/**
 * Reads and validates `id` from the page URL against the same pattern the
 * server route requires; anything else (absent, malformed) -> `null`, which
 * skips the request entirely and shows the missing-series state directly.
 * @returns {string | null}
 */
function parseIdParam() {
  const raw = new URLSearchParams(location.search).get('id');
  return raw !== null && ID_PATTERN.test(raw) ? raw : null;
}

/**
 * @param {number | null} season
 * @returns {string}
 */
function seasonLabel(season) {
  if (season === 0) return 'Specials';
  if (season === null) return 'Weitere Folgen';
  return `Staffel ${season}`;
}

/**
 * @param {number | null} season
 * @returns {string}
 */
function seasonAnchorId(season) {
  if (season === 0) return 'specials';
  if (season === null) return 'weitere-folgen';
  return `staffel-${season}`;
}

/** @returns {HTMLElement} */
function buildBackLink() {
  return el('a', { class: 'back-link', href: '/series' }, '‹ Serien');
}

/**
 * @param {SeriesDetail} series
 * @returns {HTMLElement}
 */
function buildHeader(series) {
  const metaParts = [];
  if (series.year != null) metaParts.push(String(series.year));
  if (series.seasonCount > 0) metaParts.push(pluralize(series.seasonCount, 'Staffel', 'Staffeln'));
  metaParts.push(pluralize(series.episodeCount, 'Folge', 'Folgen'));
  const tile = createPosterTile({
    title: series.title,
    iconName: 'series',
    unplayable: series.playableCount === 0,
    className: 'series-detail-header__tile',
  });
  return el(
    'div',
    { class: 'series-detail-header' },
    tile,
    el(
      'div',
      { class: 'series-detail-header__info' },
      el('h1', { class: 'shell-title' }, series.title),
      el('p', { class: 'series-detail-header__meta' }, metaParts.join(` ${MIDDLE_DOT} `)),
    ),
  );
}

/**
 * @param {SeriesSeason[]} seasons
 * @returns {HTMLElement}
 */
function buildChips(seasons) {
  const chips = seasons.map((group) =>
    el('a', { class: 'season-chip', href: `#${seasonAnchorId(group.season)}` }, seasonLabel(group.season)),
  );
  return el('nav', { class: 'season-chips', 'aria-label': 'Staffeln' }, ...chips);
}

/**
 * @param {SeriesSeason} group
 * @returns {HTMLElement}
 */
function buildSeasonSection(group) {
  const heading = el(
    'div',
    { class: 'season-section__heading' },
    el('h2', {}, seasonLabel(group.season)),
    el('span', { class: 'season-section__count' }, pluralize(group.episodes.length, 'Folge', 'Folgen')),
  );
  const list = el('div', { class: 'episode-list' }, ...group.episodes.map(createEpisodeRow));
  return el('section', { class: 'season-section', id: seasonAnchorId(group.season) }, heading, list);
}

/**
 * Wraps the page's content in the centered, width-limited column (design.md
 * "series detail") and swaps it into `main` in one operation.
 * @param {...HTMLElement} children
 * @returns {void}
 */
function renderMain(...children) {
  main.replaceChildren(el('div', { class: 'series-detail' }, ...children));
}

/** @returns {HTMLElement} */
function buildMissingState() {
  const state = createEmptyState({ title: 'Diese Serie gibt es nicht mehr.', text: '' });
  state.append(el('a', { href: '/series' }, 'Zu den Serien'));
  return state;
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

/**
 * Fetches the series and renders it, or the missing-series state for a
 * malformed id / 404, or a retryable error state for any other failure.
 * @returns {Promise<void>}
 */
async function load() {
  if (id === null) {
    renderMain(buildBackLink(), buildMissingState());
    return;
  }
  renderMain(buildBackLink());
  /** @type {SeriesDetail} */
  let series;
  try {
    series = await getSeries(id);
  } catch (err) {
    const isMissing = err instanceof ApiError && err.status === 404;
    renderMain(buildBackLink(), isMissing ? buildMissingState() : buildErrorState(load));
    return;
  }
  document.title = `${series.title} ${MIDDLE_DOT} Videothek`;
  renderMain(
    buildBackLink(),
    buildHeader(series),
    buildChips(series.seasons),
    ...series.seasons.map(buildSeasonSection),
  );
  decorateProgressFor(main, 'series');
}
