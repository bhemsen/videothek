// @ts-check

import { CATEGORIES } from '../library/categories.js';

/**
 * @typedef {import('../library/categories.js').Category} Category
 */

/**
 * @typedef {'none' | 'in_progress' | 'finished' | 'next_up'} ProgressState
 */

/**
 * @typedef {{
 *   itemId: number,
 *   position: number,
 *   duration: number | null,
 *   state: ProgressState,
 *   updatedAt: string | null,
 * }} ProgressEntry
 */

/** Position (seconds) at/above which an otherwise-unfinished item counts as started. */
export const START_THRESHOLD_S = 30;

/** `movies`/`series` finished threshold: `position / duration` at/above this ratio. */
export const VIDEO_FINISHED_RATIO = 0.9;

/** `music`/`audiobooks` finished window: `duration - position` at/under this many seconds. */
export const AUDIO_END_WINDOW_S = 30;

/** Maximum accepted `duration` (seconds) — one week; rejects clearly bogus reports. */
export const MAX_DURATION_S = 604800;

/** Category ids `GET /api/progress` accepts (P2's `CATEGORIES` minus `images`). */
const QUERY_CATEGORIES = /** @type {Category[]} */ (CATEGORIES.filter((category) => category !== 'images'));

/** Default `category` query value, in P2's `CATEGORIES` order. */
const DEFAULT_QUERY_CATEGORIES = [...QUERY_CATEGORIES];

const VALID_QUERY_CATEGORIES = new Set(QUERY_CATEGORIES);

/** Sentinel thrown by the private query-parsing helpers and caught at the public boundary. */
class InvalidQueryError extends Error {}

/**
 * Validates and normalises a `PUT /api/progress/:id` request body. Whether
 * `body` is an object at all is P1's `readJson` concern (`400 invalid_json`);
 * this validates only the `position`/`duration` fields per the spec's rules
 * (`typeof number` + `Number.isFinite`, no coercion; unknown fields ignored).
 * @param {unknown} body parsed JSON request body
 * @returns {{ position: number, duration: number } | null} normalised values
 *   (`position` clamped to `duration`), or `null` on any violation
 */
export function validateProgressBody(body) {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { position, duration } = /** @type {Record<string, unknown>} */ (body);
  if (typeof position !== 'number' || !Number.isFinite(position)) {
    return null;
  }
  if (typeof duration !== 'number' || !Number.isFinite(duration)) {
    return null;
  }
  if (duration <= 0 || duration > MAX_DURATION_S || position < 0) {
    return null;
  }
  return { position: Math.min(position, duration), duration };
}

/**
 * Step 1 of the write rule: whether a write at this position/duration
 * finishes the item, per category (images never reach a progress write —
 * they are rejected as `not_resumable` before this rule runs).
 * @param {Category} category item category
 * @param {number} position seconds
 * @param {number} duration seconds
 * @returns {boolean}
 */
function isFinishedByRule(category, position, duration) {
  if (category === 'movies' || category === 'series') {
    return position >= VIDEO_FINISHED_RATIO * duration;
  }
  return duration - position <= AUDIO_END_WINDOW_S;
}

/**
 * Write-rule decision for `PUT /api/progress/:id`, evaluated in the spec's
 * order: 1) the finished rule; 2) the finished guard — an existing finished
 * row is left untouched by a write below the start threshold (the response
 * is then the unchanged existing entry, so the caller skips the upsert);
 * 3) otherwise the write is stored with `finished = 0`.
 * @param {{
 *   category: Category,
 *   position: number,
 *   duration: number,
 *   existingFinished: boolean,
 * }} input validated position/duration, the item's category and whether the
 *   current stored row (if any) has `finished = 1`
 * @returns {{ write: true, finished: boolean } | { write: false }} whether to
 *   upsert and, if so, the `finished` flag to store
 */
export function decideProgressWrite({ category, position, duration, existingFinished }) {
  if (isFinishedByRule(category, position, duration)) {
    return { write: true, finished: true };
  }
  if (existingFinished && position < START_THRESHOLD_S) {
    return { write: false };
  }
  return { write: true, finished: false };
}

/**
 * Derives the display state from a stored `finished` flag and position, per
 * the spec's Progress states table. `next_up` is never derived here — it is
 * produced only by the continue-view merge (`src/api/progress-next-up.js`).
 * @param {{ finished: boolean, position: number }} input
 * @returns {'none' | 'in_progress' | 'finished'}
 */
export function deriveProgressState({ finished, position }) {
  if (finished) {
    return 'finished';
  }
  return position >= START_THRESHOLD_S ? 'in_progress' : 'none';
}

/**
 * Builds the progress entry JSON shared by the `GET`/`PUT`/list responses.
 * The "no row" entry (`GET` on an item with no stored progress) is this
 * function called with `finished: false, position: 0, updatedAt: null`.
 * @param {{
 *   itemId: number,
 *   position: number,
 *   duration: number | null,
 *   finished: boolean,
 *   updatedAt: number | null,
 * }} input `updatedAt` is epoch ms (server clock), or `null` for "no row"
 * @returns {ProgressEntry}
 */
export function toProgressEntryJson({ itemId, position, duration, finished, updatedAt }) {
  return {
    itemId,
    position,
    duration,
    state: deriveProgressState({ finished, position }),
    updatedAt: updatedAt === null ? null : new Date(updatedAt).toISOString(),
  };
}

/**
 * Parses the `category` query parameter: a comma list of P2 category ids
 * (duplicates ignored), defaulting to every non-`images` category.
 * @param {string | null} raw raw `category` param, or `null` when absent
 * @returns {Category[]}
 */
function parseCategoryParam(raw) {
  if (raw === null) {
    return DEFAULT_QUERY_CATEGORIES;
  }
  const values = raw.split(',');
  if (values.some((value) => value.length === 0)) {
    throw new InvalidQueryError();
  }
  const unique = [...new Set(values)];
  for (const id of unique) {
    if (!VALID_QUERY_CATEGORIES.has(/** @type {Category} */ (id))) {
      throw new InvalidQueryError();
    }
  }
  return /** @type {Category[]} */ (unique);
}

/**
 * Parses the `view` query parameter.
 * @param {string | null} raw raw `view` param, or `null` when absent
 * @returns {'continue' | 'all'}
 */
function parseViewParam(raw) {
  const view = raw === null ? 'continue' : raw;
  if (view !== 'continue' && view !== 'all') {
    throw new InvalidQueryError();
  }
  return view;
}

/**
 * Parses the `limit` query parameter (only meaningful with `view=continue`).
 * @param {string | null} raw raw `limit` param, or `null` when absent
 * @returns {number} an integer 1–50, default 20
 */
function parseLimitParam(raw) {
  if (raw === null) {
    return 20;
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new InvalidQueryError();
  }
  const limit = Number(raw);
  if (limit < 1 || limit > 50) {
    throw new InvalidQueryError();
  }
  return limit;
}

/**
 * Parses and validates the `GET /api/progress` collection query. Unknown
 * parameters are ignored; any violation makes the whole query invalid (the
 * caller answers `400 invalid_query`).
 * @param {URLSearchParams} searchParams request query parameters
 * @returns {{ categories: Category[], view: 'continue' | 'all', limit: number | null } | null}
 *   the parsed query, or `null` when invalid
 */
export function parseProgressQuery(searchParams) {
  try {
    const categories = parseCategoryParam(searchParams.get('category'));
    const view = parseViewParam(searchParams.get('view'));
    const limitParam = searchParams.get('limit');
    if (view === 'all') {
      if (limitParam !== null) {
        throw new InvalidQueryError();
      }
      return { categories, view, limit: null };
    }
    return { categories, view, limit: parseLimitParam(limitParam) };
  } catch (err) {
    if (err instanceof InvalidQueryError) {
      return null;
    }
    throw err;
  }
}
