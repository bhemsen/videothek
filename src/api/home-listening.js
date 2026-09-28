// @ts-check

import { requireUser } from '../http/guards.js';
import { sendError, sendJson } from '../http/respond.js';
import { listAudioProgress } from '../db/audio-progress.js';
import { listGroupRows } from '../db/audio-meta-repo.js';
import { listStartedBookGroupKeys } from '../db/home-queries.js';
import { buildBooks } from '../library/audio-groups.js';
import { deriveBookProgress } from './audiobook-resume.js';
import { toBookFiles } from './audiobooks.js';
import { parseHomeLimit } from './home-params.js';
import { buildResumeJson } from './music.js';
import { START_THRESHOLD_S } from './progress-rules.js';

/**
 * `GET /api/home/listening`: the start page's "Weiterhören" row — the single
 * latest unfinished music track (`buildResumeJson`, unchanged semantics) plus
 * every in-progress audiobook (`deriveBookProgress`), merged, sorted by
 * recency and capped at `limit`. Adds no second resume logic of its own.
 * @typedef {import('./music.js').MusicResumeJson & { kind: 'music' }} MusicListeningItem
 * @typedef {{
 *   kind: 'audiobook',
 *   id: number,
 *   title: string,
 *   author: string | null,
 *   coverId: number,
 *   fraction: number | null,
 *   remaining: number | null,
 *   updatedAt: string,
 *   resume: { itemId: number, position: number, fileTitle: string },
 * }} AudiobookListeningItem
 * @typedef {MusicListeningItem | AudiobookListeningItem} ListeningItem
 */

/**
 * Seconds left in a book: the playable, known-duration total (`known`, the
 * same denominator `computeFraction` uses) times the unheard fraction,
 * rounded and floored at 0. `null` when `fraction` is `null` (nothing
 * playable has a known duration).
 * @param {import('./audiobook-resume.js').BookFile[]} files
 * @param {Map<number, import('../db/audio-progress.js').AudioProgressRow>} rowsByItemId
 * @param {number | null} fraction
 * @returns {number | null}
 */
function remainingSeconds(files, rowsByItemId, fraction) {
  if (fraction === null) return null;
  let known = 0;
  for (const file of files) {
    if (!file.playable) continue;
    const duration = file.duration ?? rowsByItemId.get(file.id)?.duration ?? null;
    if (duration == null) continue;
    known += duration;
  }
  return Math.max(0, Math.round(known * (1 - fraction)));
}

/**
 * Builds one in-progress audiobook's listening item. `resume` and
 * `lastPlayedAt` are the caller's already-narrowed non-null values from
 * `deriveBookProgress`'s `in_progress` state — its own typing does not tie
 * them to `state` in a way `tsc --strict` can narrow, so the caller
 * re-checks both before calling this.
 * @param {import('../library/audio-groups.js').Book} book
 * @param {import('./audiobook-resume.js').BookFile[]} files
 * @param {{ itemId: number, position: number }} resume
 * @param {string} lastPlayedAt
 * @param {number | null} fraction
 * @param {Map<number, import('../db/audio-progress.js').AudioProgressRow>} rowsByItemId
 * @returns {AudiobookListeningItem}
 */
function toAudiobookItem(book, files, resume, lastPlayedAt, fraction, rowsByItemId) {
  const fileTitle = book.members.find((member) => member.id === resume.itemId)?.title ?? '';
  return {
    kind: 'audiobook',
    id: book.id,
    title: book.title,
    author: book.author,
    coverId: book.coverId,
    fraction,
    remaining: remainingSeconds(files, rowsByItemId, fraction),
    updatedAt: lastPlayedAt,
    resume: { itemId: resume.itemId, position: resume.position, fileTitle },
  };
}

/**
 * Every in-progress audiobook item for `userId`. Only books with at least one
 * counted progress row are ever assembled (efficiency decision: a book with
 * none can only be `new`, so skipping it changes no result) — the set is
 * bounded by the user's own listening history, not by library size.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} userId
 * @returns {AudiobookListeningItem[]}
 */
function buildAudiobookItems(db, userId) {
  const progressRows = listAudioProgress(db, userId, 'audiobooks');
  const rowsByItemId = new Map(progressRows.map((row) => [row.itemId, row]));
  const groupKeys = listStartedBookGroupKeys(db, { userId, startThreshold: START_THRESHOLD_S });
  /** @type {AudiobookListeningItem[]} */
  const items = [];
  for (const groupKey of groupKeys) {
    const [book] = buildBooks(listGroupRows(db, groupKey));
    if (book === undefined) continue;
    const files = toBookFiles(book);
    const derived = deriveBookProgress(files, progressRows);
    if (derived.state !== 'in_progress' || derived.resume === null || derived.lastPlayedAt === null) continue;
    items.push(toAudiobookItem(book, files, derived.resume, derived.lastPlayedAt, derived.fraction, rowsByItemId));
  }
  return items;
}

/**
 * Sort/tie-break for the merged list: `updatedAt` descending (plain string
 * comparison — every value comes from `toISOString`), music before an
 * audiobook on an exact tie, then two audiobooks by `id` ascending.
 * @param {ListeningItem} a
 * @param {ListeningItem} b
 * @returns {number}
 */
function compareListening(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;
  if (a.kind !== b.kind) return a.kind === 'music' ? -1 : 1;
  if (a.kind === 'audiobook' && b.kind === 'audiobook') return a.id - b.id;
  return 0;
}

/**
 * Assembles the "Weiterhören" items: the single music resume card (if any)
 * plus every in-progress audiobook, sorted and capped at `limit`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} userId
 * @param {number} limit
 * @returns {ListeningItem[]}
 */
function buildListeningItems(db, userId, limit) {
  const musicResume = buildResumeJson(db, userId);
  /** @type {ListeningItem[]} */
  const items = musicResume === null ? [] : [{ kind: 'music', ...musicResume }];
  items.push(...buildAudiobookItems(db, userId));
  return items.sort(compareListening).slice(0, limit);
}

/**
 * Registers `GET /api/home/listening`, behind `requireUser`; `limit` is
 * parsed by `parseHomeLimit` (default 10, range 1..20), `400 invalid_query`
 * otherwise.
 * @param {ReturnType<typeof import('../http/router.js').createRouter>} router
 * @param {{ db: import('node:sqlite').DatabaseSync }} deps
 * @returns {void}
 */
export function registerHomeListeningRoutes(router, { db }) {
  router.add(
    'GET',
    '/api/home/listening',
    requireUser((_req, res, ctx) => {
      const limit = parseHomeLimit(ctx.url.searchParams);
      if (limit === null) {
        sendError(res, 400, 'invalid_query');
        return;
      }
      const userId = /** @type {import('../http/router.js').AuthUser} */ (ctx.user).id;
      sendJson(res, 200, { items: buildListeningItems(db, userId, limit) });
    })
  );
}
