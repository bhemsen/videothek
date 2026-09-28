// @ts-check

import { requireUser } from '../http/guards.js';
import { sendError, sendJson } from '../http/respond.js';
import { getAudioRow, listAudioRows, listGroupRows } from '../db/audio-meta-repo.js';
import { listAudioProgress } from '../db/audio-progress.js';
import { buildBooks } from '../library/audio-groups.js';
import { deriveBookProgress } from './audiobook-resume.js';

/** `:id` must be one to sixteen digits, no leading zero, and a safe integer (Phases 3/6's rule). */
const ID_PATTERN = /^[1-9][0-9]{0,15}$/;

/**
 * Parses and validates a route `:id` param.
 * @param {string} raw
 * @returns {number | null}
 */
function parseItemId(raw) {
  if (!ID_PATTERN.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * The authenticated user's id. `requireUser` guarantees `ctx.user` is set at
 * runtime before this handler ever runs; the cast makes that guarantee
 * explicit for `tsc --strict`, which cannot see across the wrapper.
 * @param {import('../http/router.js').RequestContext} ctx
 * @returns {number}
 */
function userId(ctx) {
  return /** @type {import('../http/router.js').AuthUser} */ (ctx.user).id;
}

/**
 * `audio_meta.duration_ms` (milliseconds) to whole seconds, or `null`.
 * @param {number | null} durationMs
 * @returns {number | null}
 */
export function msToSeconds(durationMs) {
  return durationMs == null ? null : Math.round(durationMs / 1000);
}

/**
 * Maps a book's joined members to `deriveBookProgress`'s pure `BookFile`
 * input, in the same (already play-ordered) member order.
 * @param {import('../library/audio-groups.js').Book} book
 * @returns {import('./audiobook-resume.js').BookFile[]}
 */
export function toBookFiles(book) {
  return book.members.map((member) => ({
    id: member.id,
    playable: Boolean(member.playable),
    duration: msToSeconds(member.durationMs),
  }));
}

/**
 * A file's `duration` (seconds) shown in the API: its own meta duration,
 * else the user's reported progress-row duration for it, else `null` (the
 * spec's "Duration without decoding" fallback).
 * @param {import('../library/audio-groups.js').AudioRow} member
 * @param {Map<number, import('./audiobook-resume.js').AudioProgressRow>} rowsByItemId
 * @returns {number | null}
 */
function resolveFileDuration(member, rowsByItemId) {
  return msToSeconds(member.durationMs) ?? rowsByItemId.get(member.id)?.duration ?? null;
}

/**
 * The book summary shape shared by the list and detail endpoints.
 * @param {import('../library/audio-groups.js').Book} book
 * @param {import('./audiobook-resume.js').BookProgress} derived
 * @returns {object}
 */
function toBookSummary(book, derived) {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    coverId: book.coverId,
    fileCount: book.members.length,
    duration: msToSeconds(book.durationMs),
    state: derived.state,
    fraction: derived.fraction,
    lastPlayedAt: derived.lastPlayedAt,
  };
}

/**
 * One `files[]` entry of the detail response.
 * @param {import('../library/audio-groups.js').AudioRow} member
 * @param {Map<number, import('./audiobook-resume.js').AudioProgressRow>} rowsByItemId
 * @param {Map<number, import('./audiobook-resume.js').FileProgress | null>} progressByFileId
 * @returns {object}
 */
function toFileEntry(member, rowsByItemId, progressByFileId) {
  return {
    id: member.id,
    title: member.title,
    trackNo: member.trackNo,
    discNo: member.discNo,
    duration: resolveFileDuration(member, rowsByItemId),
    playable: Boolean(member.playable),
    ext: member.ext,
    progress: progressByFileId.get(member.id) ?? null,
  };
}

/**
 * Registers `GET /api/audiobooks` (the book grid) and `GET
 * /api/audiobooks/:id` (one book's detail), both behind `requireUser`. See
 * the spec's "API" and "Audiobook resume" rows for the exact shapes and
 * derivation rules.
 * @param {ReturnType<typeof import('../http/router.js').createRouter>} router
 * @param {{ db: import('node:sqlite').DatabaseSync }} deps
 * @returns {void}
 */
export function registerAudiobookRoutes(router, { db }) {
  router.add(
    'GET',
    '/api/audiobooks',
    requireUser((_req, res, ctx) => {
      const books = buildBooks(listAudioRows(db, 'audiobooks'));
      const progressRows = listAudioProgress(db, userId(ctx), 'audiobooks');
      const bookSummaries = books.map((book) =>
        toBookSummary(book, deriveBookProgress(toBookFiles(book), progressRows))
      );
      sendJson(res, 200, { books: bookSummaries });
    })
  );

  router.add(
    'GET',
    '/api/audiobooks/:id',
    requireUser((_req, res, ctx) => {
      const id = parseItemId(ctx.params.id);
      const row = id === null ? undefined : getAudioRow(db, id);
      if (!row || row.category !== 'audiobooks') {
        sendError(res, 404, 'not_found');
        return;
      }
      const [book] = buildBooks(listGroupRows(db, row.groupKey));
      const progressRows = listAudioProgress(db, userId(ctx), 'audiobooks');
      const rowsByItemId = new Map(progressRows.map((r) => [r.itemId, r]));
      const derived = deriveBookProgress(toBookFiles(book), progressRows);
      sendJson(res, 200, {
        ...toBookSummary(book, derived),
        resume: derived.resume,
        files: book.members.map((member) => toFileEntry(member, rowsByItemId, derived.progress)),
      });
    })
  );
}
