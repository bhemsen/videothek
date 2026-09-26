/**
 * Shared card/row builders for the library video UI (`/movies`, `/series`,
 * `/series-detail`): the 2:3 initials poster tile, the "Nicht abspielbar"
 * badge, the movie/series media card and the series-detail episode row. DOM
 * only via P1's `el()`/`createElementNS` — never `innerHTML`. See
 * docs/specs/spec-library-video.md "UI".
 */

import { el } from './dom.js';
import { icon } from './icons.js';
import { banIcon, playIcon } from './library-icons.js';
import { initials, pluralize, formatFileSize, episodeNumber, episodeLabel, UNPLAYABLE_TITLE } from './library-format.js';

/** @typedef {import('./library-api.js').LibraryItem} LibraryItem */
/** @typedef {import('./library-api.js').SeriesSummary} SeriesSummary */

const MIDDLE_DOT = '·';

/**
 * The "Nicht abspielbar" pill (ban icon + German text), unpositioned —
 * callers place it (absolute in a tile, inline in an episode row).
 * @returns {HTMLElement}
 */
export function createUnplayableBadge() {
  return el('span', { class: 'badge-unplayable' }, banIcon(), 'Nicht abspielbar');
}

/**
 * @typedef {object} PosterTileParams
 * @property {string} title - Used to derive the initials placeholder.
 * @property {import('./icons.js').IconName} iconName - Category glyph shown top-left.
 * @property {boolean} unplayable - Shows the badge top-right when true.
 * @property {string} [className] - Extra class for a non-grid instance (e.g. series detail).
 */

/**
 * Builds the shared 2:3 poster-fallback tile (`.media-card__tile`): a
 * tokenized initials placeholder with the category icon and, when
 * unplayable, the badge — reused by the grid cards and the series-detail
 * header.
 * @param {PosterTileParams} params
 * @returns {HTMLElement}
 */
export function createPosterTile({ title, iconName, unplayable, className }) {
  return el(
    'div',
    { class: ['media-card__tile', className] },
    el('span', { class: 'media-card__icon' }, icon(iconName)),
    el('span', { class: 'media-card__initials' }, initials(title)),
    unplayable ? el('span', { class: 'media-card__badge' }, createUnplayableBadge()) : null,
  );
}

/**
 * Builds a movie card: playable movies link to the player, unplayable ones
 * are a non-interactive `<div>` with the German title-attribute explanation.
 * @param {LibraryItem} item
 * @returns {HTMLElement}
 */
export function createMovieCard(item) {
  const meta = item.year != null ? `${item.year} ${MIDDLE_DOT} ${item.ext.toUpperCase()}` : item.ext.toUpperCase();
  const children = [
    createPosterTile({ title: item.title, iconName: 'movies', unplayable: !item.playable }),
    el('p', { class: 'media-card__title' }, item.title),
    el('p', { class: 'media-card__meta' }, meta),
  ];
  const dataset = { itemId: String(item.id) };
  if (item.playable) {
    return el('a', { class: 'media-card', href: `/player?id=${item.id}`, dataset }, ...children);
  }
  return el('div', { class: 'media-card', dataset, title: UNPLAYABLE_TITLE }, ...children);
}

/**
 * Builds a series card. Always a link to the series detail page — the
 * badge (shown only when no episode is playable) never removes the link.
 * @param {SeriesSummary} series
 * @returns {HTMLElement}
 */
export function createSeriesCard(series) {
  const metaParts = [];
  if (series.seasonCount > 0) metaParts.push(pluralize(series.seasonCount, 'Staffel', 'Staffeln'));
  metaParts.push(pluralize(series.episodeCount, 'Folge', 'Folgen'));
  const tile = createPosterTile({
    title: series.title,
    iconName: 'series',
    unplayable: series.playableCount === 0,
  });
  return el(
    'a',
    { class: 'media-card', href: `/series-detail?id=${series.id}`, dataset: { seriesId: String(series.id) } },
    tile,
    el('p', { class: 'media-card__title' }, series.title),
    el('p', { class: 'media-card__meta' }, metaParts.join(` ${MIDDLE_DOT} `)),
  );
}

/**
 * Builds one series-detail episode row (`.episode-row`): playable episodes
 * link to the player, unplayable ones are a non-interactive `<div>` showing
 * the badge instead of the play icon.
 * @param {LibraryItem} item
 * @returns {HTMLElement}
 */
export function createEpisodeRow(item) {
  const number = episodeNumber({ episode: item.episode, episodeEnd: item.episodeEnd });
  const title = episodeLabel({
    title: item.title,
    season: item.season,
    episode: item.episode,
    episodeEnd: item.episodeEnd,
  });
  const meta = `${item.ext.toUpperCase()} ${MIDDLE_DOT} ${formatFileSize(item.size)}`;
  const children = [
    el('span', { class: 'episode-row__number' }, number),
    el(
      'div',
      { class: 'episode-row__body' },
      el('span', { class: 'episode-row__title' }, title),
      el('span', { class: 'episode-row__meta' }, meta),
    ),
    item.playable ? el('span', { class: 'episode-row__action' }, playIcon()) : createUnplayableBadge(),
  ];
  const dataset = { itemId: String(item.id) };
  if (item.playable) {
    return el('a', { class: 'episode-row', href: `/player?id=${item.id}`, dataset }, ...children);
  }
  return el('div', { class: 'episode-row', dataset, title: UNPLAYABLE_TITLE }, ...children);
}
