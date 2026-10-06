// @ts-check

import { CATEGORIES } from '../library/categories.js';
import {
  getItemById,
  getSeriesWithEpisodes,
  listCategoryItems,
  listSeries,
} from '../db/library-queries.js';
import { requireUser } from '../http/guards.js';
import { sendError, sendJson } from '../http/respond.js';
import { toItemDetailJson } from './item-detail.js';
import { toItemJson } from './library-json.js';

/**
 * Library browse API — `GET /api/library/:category`,
 * `GET /api/library/series/:id`, `GET /api/library/items/:id`. Knows
 * nothing about file formats: every shape decision (playable, codecs,
 * MIME) lives in `src/library/`; this module only reads
 * `src/db/library-queries.js` rows and serializes them.
 * @typedef {import('../library/categories.js').Category} Category
 * @typedef {import('../http/router.js').RequestContext} RequestContext
 * @typedef {import('../db/library-queries.js').SeriesSummaryRow} SeriesSummaryRow
 * @typedef {{ status: () => { running: boolean, lastCompletedAt: number | null } }} LibraryStatusSource
 */

const ID_PATTERN = /^[1-9][0-9]{0,15}$/;
const CATEGORY_SET = new Set(CATEGORIES);

/**
 * Parses the `sort` query param: absent -> `'title'` (the default);
 * `'title'`/`'added'` -> itself; anything else -> `null`, meaning the
 * caller must answer `400 invalid_sort`.
 * @param {URL} url
 * @returns {'title' | 'added' | null}
 */
function parseSort(url) {
  const raw = url.searchParams.get('sort');
  if (raw === null || raw === 'title') return 'title';
  return raw === 'added' ? 'added' : null;
}

/**
 * Parses a route `:id` param per the spec's pattern; anything else means
 * the caller must answer `404 not_found` (never a validation error for an
 * id — an unknown/malformed id looks the same to the client).
 * @param {string} raw
 * @returns {number | null}
 */
function parseId(raw) {
  return ID_PATTERN.test(raw) ? Number(raw) : null;
}

/**
 * The `scan` field shared by every list response: reflects the injected
 * `deps.library.status()` when present, else the fixed no-scanner default.
 * @param {LibraryStatusSource | undefined} library
 * @returns {{ running: boolean, lastCompletedAt: string | null }}
 */
function scanStatusJson(library) {
  if (!library) return { running: false, lastCompletedAt: null };
  const { running, lastCompletedAt } = library.status();
  return { running, lastCompletedAt: lastCompletedAt === null ? null : new Date(lastCompletedAt).toISOString() };
}

/**
 * @param {SeriesSummaryRow} row
 * @returns {{ id: number, title: string, year: number | null, seasonCount: number, episodeCount: number, playableCount: number, addedAt: string }}
 */
export function toSeriesSummaryJson(row) {
  return {
    id: row.id,
    title: row.title,
    year: row.year ?? null,
    seasonCount: row.seasonCount,
    episodeCount: row.episodeCount,
    playableCount: row.playableCount,
    addedAt: new Date(row.addedAt).toISOString(),
  };
}

/**
 * `GET /api/library/:category?sort=title|added`.
 * @param {import('node:http').ServerResponse} res
 * @param {RequestContext} ctx
 * @param {{ db: import('node:sqlite').DatabaseSync, library?: LibraryStatusSource }} deps
 * @returns {void}
 */
function handleListCategory(res, ctx, deps) {
  const category = /** @type {Category} */ (ctx.params.category);
  if (!CATEGORY_SET.has(category)) {
    sendError(res, 404, 'not_found');
    return;
  }
  const sort = parseSort(ctx.url);
  if (sort === null) {
    sendError(res, 400, 'invalid_sort');
    return;
  }
  const scan = scanStatusJson(deps.library);
  if (category === 'series') {
    const series = listSeries(deps.db, sort).map(toSeriesSummaryJson);
    sendJson(res, 200, { category, sort, scan, series });
    return;
  }
  const items = listCategoryItems(deps.db, category, sort).map(toItemJson);
  sendJson(res, 200, { category, sort, scan, items });
}

/**
 * `GET /api/library/series/:id`.
 * @param {import('node:http').ServerResponse} res
 * @param {RequestContext} ctx
 * @param {{ db: import('node:sqlite').DatabaseSync }} deps
 * @returns {void}
 */
function handleSeriesDetail(res, ctx, deps) {
  const id = parseId(ctx.params.id);
  const series = id === null ? undefined : getSeriesWithEpisodes(deps.db, id);
  if (!series) {
    sendError(res, 404, 'not_found');
    return;
  }
  sendJson(res, 200, {
    id: series.id,
    title: series.title,
    year: series.year,
    addedAt: new Date(series.addedAt).toISOString(),
    seasonCount: series.seasonCount,
    episodeCount: series.episodeCount,
    playableCount: series.playableCount,
    seasons: series.seasons.map((group) => ({
      season: group.season,
      episodes: group.episodes.map(toItemJson),
    })),
  });
}

/**
 * `GET /api/library/items/:id`.
 * @param {import('node:http').ServerResponse} res
 * @param {RequestContext} ctx
 * @param {{ db: import('node:sqlite').DatabaseSync, config: import('../config.js').Config }} deps
 * @returns {Promise<void>}
 */
async function handleItemDetail(res, ctx, deps) {
  const id = parseId(ctx.params.id);
  const row = id === null ? undefined : getItemById(deps.db, id);
  if (!row) {
    sendError(res, 404, 'not_found');
    return;
  }
  sendJson(res, 200, await toItemDetailJson({ db: deps.db, mediaRoot: deps.config.mediaRoot, convertDir: deps.config.convertDir }, row));
}

/**
 * Registers the library browse routes. All three require a session
 * (`requireUser`); `deps.library` is optional (absent -> `scan` defaults to
 * `{ running: false, lastCompletedAt: null }`).
 * @param {ReturnType<typeof import('../http/router.js').createRouter>} router
 * @param {{ db: import('node:sqlite').DatabaseSync, config: import('../config.js').Config, library?: LibraryStatusSource } & Record<string, unknown>} deps
 * @returns {void}
 */
export function registerLibraryRoutes(router, deps) {
  router.add(
    'GET',
    '/api/library/:category',
    requireUser((_req, res, ctx) => handleListCategory(res, ctx, deps))
  );
  router.add(
    'GET',
    '/api/library/series/:id',
    requireUser((_req, res, ctx) => handleSeriesDetail(res, ctx, deps))
  );
  router.add(
    'GET',
    '/api/library/items/:id',
    requireUser((_req, res, ctx) => handleItemDetail(res, ctx, deps))
  );
}
