// @ts-check

import { START_THRESHOLD_S } from './progress-rules.js';

/**
 * Pure derivation of one audiobook's play state from its files (in play
 * order) and the user's progress rows, on top of Phase 4's `progress` table
 * (one row per `(user, rel_path)`, no book-level table). Only *counted* rows
 * matter for state/`L`/resume/`fraction`: `finished` or `position >=
 * START_THRESHOLD_S` (imported, never a literal `30` here); Phase 4's `none`
 * rows are ignored. Only playable files take part in state, `L`, resume and
 * `fraction` — a non-playable file's row never becomes `L` and its own
 * `progress` entry is always `null`; `lastPlayedAt` is not part of that
 * exclusion list and is computed over every file's counted row, playable or
 * not (recorded in the spec's Decision log).
 * @typedef {{ id: number, playable: boolean, duration: number | null }} BookFile
 * @typedef {{ itemId: number, position: number, duration: number | null, finished: 0 | 1, updatedAt: number }} AudioProgressRow
 * @typedef {{ position: number, duration: number | null, finished: boolean }} FileProgress
 * @typedef {{
 *   state: 'new' | 'in_progress' | 'finished',
 *   resume: { itemId: number, position: number } | null,
 *   fraction: number | null,
 *   lastPlayedAt: string | null,
 *   progress: Map<number, FileProgress | null>,
 * }} BookProgress
 */

/**
 * Whether a progress row counts toward state/`L`/resume/`fraction`/
 * `lastPlayedAt`: finished, or started at/above the threshold. `undefined`
 * (no row for this file) never counts.
 * @param {AudioProgressRow | undefined} row
 * @returns {boolean}
 */
function isCounted(row) {
  return row !== undefined && (row.finished === 1 || row.position >= START_THRESHOLD_S);
}

/**
 * @param {AudioProgressRow | undefined} row
 * @returns {boolean}
 */
function isFinishedRow(row) {
  return row !== undefined && row.finished === 1;
}

/**
 * Builds the `id -> progress row` lookup and, for every file, its own
 * per-file `progress` entry (`null` for a non-playable file or an uncounted/
 * absent row).
 * @param {BookFile[]} files
 * @param {AudioProgressRow[]} rows
 * @returns {{ rowsByFileId: Map<number, AudioProgressRow>, progress: Map<number, FileProgress | null> }}
 */
function indexRows(files, rows) {
  const rowsByFileId = new Map(rows.map((row) => [row.itemId, row]));
  /** @type {Map<number, FileProgress | null>} */
  const progress = new Map();
  for (const file of files) {
    const row = rowsByFileId.get(file.id);
    progress.set(
      file.id,
      file.playable && isCounted(row)
        ? { position: /** @type {AudioProgressRow} */ (row).position, duration: /** @type {AudioProgressRow} */ (row).duration, finished: /** @type {AudioProgressRow} */ (row).finished === 1 }
        : null
    );
  }
  return { rowsByFileId, progress };
}

/**
 * `lastPlayedAt`: the max `updatedAt` of every file's counted row (playable
 * or not), as an ISO string, or `null` when no row counts.
 * @param {BookFile[]} files
 * @param {Map<number, AudioProgressRow>} rowsByFileId
 * @returns {string | null}
 */
function computeLastPlayedAt(files, rowsByFileId) {
  let max = /** @type {number | null} */ (null);
  for (const file of files) {
    const row = rowsByFileId.get(file.id);
    if (isCounted(row) && (max === null || /** @type {AudioProgressRow} */ (row).updatedAt > max)) {
      max = /** @type {AudioProgressRow} */ (row).updatedAt;
    }
  }
  return max === null ? null : new Date(max).toISOString();
}

/**
 * `fraction` = Σ(finished ? d : counted ? min(position, d) : 0) ÷ Σd, over
 * playable files with a known duration `d` (the file's own duration, else
 * its row's reported duration); `null` when that Σd is 0.
 * @param {BookFile[]} files
 * @param {Map<number, AudioProgressRow>} rowsByFileId
 * @returns {number | null}
 */
function computeFraction(files, rowsByFileId) {
  let sumDuration = 0;
  let sumWatched = 0;
  for (const file of files) {
    if (!file.playable) continue;
    const row = rowsByFileId.get(file.id);
    const duration = file.duration ?? row?.duration ?? null;
    if (duration == null) continue;
    sumDuration += duration;
    if (isFinishedRow(row)) {
      sumWatched += duration;
    } else if (isCounted(row)) {
      sumWatched += Math.min(/** @type {AudioProgressRow} */ (row).position, duration);
    }
  }
  return sumDuration === 0 ? null : sumWatched / sumDuration;
}

/**
 * The next playable file after `from` (by its index in `playableFiles`) that
 * is not finished, or `null` when none follows.
 * @param {BookFile} from
 * @param {BookFile[]} playableFiles
 * @param {Map<number, AudioProgressRow>} rowsByFileId
 * @returns {BookFile | null}
 */
function findNextUnfinishedAfter(from, playableFiles, rowsByFileId) {
  const startIndex = playableFiles.indexOf(from) + 1;
  for (let i = startIndex; i < playableFiles.length; i += 1) {
    if (!isFinishedRow(rowsByFileId.get(playableFiles[i].id))) return playableFiles[i];
  }
  return null;
}

/**
 * The latest counted row among `countedPlayable`: max `updatedAt`, ties
 * broken by the later file in `files`' play order.
 * @param {BookFile[]} countedPlayable
 * @param {BookFile[]} files
 * @param {Map<number, AudioProgressRow>} rowsByFileId
 * @returns {BookFile}
 */
function findLatestCounted(countedPlayable, files, rowsByFileId) {
  let best = countedPlayable[0];
  let bestRow = /** @type {AudioProgressRow} */ (rowsByFileId.get(best.id));
  let bestIndex = files.indexOf(best);
  for (const file of countedPlayable.slice(1)) {
    const row = /** @type {AudioProgressRow} */ (rowsByFileId.get(file.id));
    const index = files.indexOf(file);
    if (row.updatedAt > bestRow.updatedAt || (row.updatedAt === bestRow.updatedAt && index > bestIndex)) {
      best = file;
      bestRow = row;
      bestIndex = index;
    }
  }
  return best;
}

/**
 * Resolves the `in_progress` resume target once `L` (the latest counted
 * playable file) is known: `L` itself when unfinished; otherwise the next
 * unfinished playable file after `L`, else the first unfinished playable
 * file from the start — at its counted position, else 0.
 * @param {BookFile} l
 * @param {BookFile[]} playableFiles
 * @param {Map<number, AudioProgressRow>} rowsByFileId
 * @returns {{ itemId: number, position: number }}
 */
function resolveInProgressResume(l, playableFiles, rowsByFileId) {
  const rowL = /** @type {AudioProgressRow} */ (rowsByFileId.get(l.id));
  if (!isFinishedRow(rowL)) {
    return { itemId: l.id, position: rowL.position };
  }
  const target =
    findNextUnfinishedAfter(l, playableFiles, rowsByFileId) ??
    /** @type {BookFile} */ (playableFiles.find((file) => !isFinishedRow(rowsByFileId.get(file.id))));
  const targetRow = rowsByFileId.get(target.id);
  return { itemId: target.id, position: isCounted(targetRow) ? /** @type {AudioProgressRow} */ (targetRow).position : 0 };
}

/**
 * Derives one audiobook's `state`/resume/`fraction`/`lastPlayedAt`/per-file
 * `progress` from its files (in play order) and the user's progress rows for
 * (at least) those files — extra rows for other books are harmless, since
 * only rows matching a file id in `files` are ever looked up.
 * @param {BookFile[]} files - the book's files, in play order
 * @param {AudioProgressRow[]} rows - the user's relevant progress rows
 * @returns {BookProgress}
 */
export function deriveBookProgress(files, rows) {
  const { rowsByFileId, progress } = indexRows(files, rows);
  const lastPlayedAt = computeLastPlayedAt(files, rowsByFileId);
  const fraction = computeFraction(files, rowsByFileId);

  const playableFiles = files.filter((file) => file.playable);
  if (playableFiles.length === 0) {
    return { state: 'new', resume: null, fraction, lastPlayedAt, progress };
  }

  const countedPlayable = playableFiles.filter((file) => isCounted(rowsByFileId.get(file.id)));
  if (countedPlayable.length === 0) {
    return { state: 'new', resume: { itemId: playableFiles[0].id, position: 0 }, fraction, lastPlayedAt, progress };
  }

  const allFinished = playableFiles.every((file) => isFinishedRow(rowsByFileId.get(file.id)));
  if (allFinished) {
    return {
      state: 'finished',
      resume: { itemId: playableFiles[0].id, position: 0 },
      fraction,
      lastPlayedAt,
      progress,
    };
  }

  const l = findLatestCounted(countedPlayable, files, rowsByFileId);
  const resume = resolveInProgressResume(l, playableFiles, rowsByFileId);
  return { state: 'in_progress', resume, fraction, lastPlayedAt, progress };
}
