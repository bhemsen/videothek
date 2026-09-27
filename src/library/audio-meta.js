// @ts-check

/**
 * Post-scan `audio_meta` pass (D6): registered on P2's `onScanComplete` (one
 * line in `src/server.js`). A run selects every stale `music`/`audiobooks`
 * item (`listStaleAudioItems` — missing, version-bumped, or size/mtime
 * changed) and processes each sequentially: the folder-convention parser
 * (`parseMusicPath`/`parseAudiobookPath`) resolves its group/title fields,
 * `readTags` reads ID3v2/FLAC tags (mp3/flac only — every other extension
 * yields an all-null result without I/O), tags win over the folder for
 * display fields, the folder wins for grouping, and the resolved row is
 * upserted. Single-flight: a call while a pass is running is coalesced into
 * exactly one follow-up pass and returns the active pass's promise.
 *
 * @see docs/specs/spec-music-audiobooks.md — "Scan hook", "Pass algorithm",
 * "Music precedence", "Audiobook precedence" decision-log rows.
 */

import { listStaleAudioItems, upsertAudioMeta } from '../db/audio-meta-repo.js';
import { parseAudiobookPath } from './parsers/audiobook.js';
import { parseMusicPath } from './parsers/music.js';
import { readAudioTags } from './tags/index.js';
import { resolveMediaPath } from '../media/paths.js';

/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('./tags/index.js').AudioTags} AudioTags */
/** @typedef {import('../db/library-repo.js').LibraryItemRow} LibraryItemRow */
/** @typedef {import('../db/audio-meta-repo.js').AudioMetaInput} AudioMetaInput */

/** Current `audio_meta.meta_version`; bump to force every row to be re-derived. */
export const AUDIO_META_VERSION = 1;

/** SQLite extended result code for a FOREIGN KEY constraint violation. */
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;

/** All-null tag result for a rejected `readTags` call — the item still gets a row (folder-derived fields only). */
const NULL_TAGS = Object.freeze(
  /** @type {AudioTags} */ ({
    title: null, artist: null, albumArtist: null, album: null,
    trackNo: null, discNo: null, year: null, durationMs: null, format: null,
  })
);

/** Thrown internally to unwind a pass the instant `db.isOpen` goes false; never escapes `createAudioMetaPass`. */
class QuietStop extends Error {}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
function assertOpen(db) {
  if (!db.isOpen) throw new QuietStop();
}

/**
 * Whether `err` is the FOREIGN KEY violation `upsertAudioMeta` raises when
 * the item's `library_items` row was deleted (by a concurrent scan) between
 * this run's `listStaleAudioItems` select and the item's upsert. Checked
 * primarily via `node:sqlite`'s extended result code, with a message
 * fallback in case a future Node version stops setting `errcode`.
 * @param {unknown} err
 * @returns {boolean}
 */
function isForeignKeyViolation(err) {
  if (!(err instanceof Error)) return false;
  const code = /** @type {{ errcode?: number }} */ (err).errcode;
  return code === SQLITE_CONSTRAINT_FOREIGNKEY || err.message.includes('FOREIGN KEY constraint failed');
}

/**
 * Resolves one item's `audio_meta` fields per the "Music precedence" /
 * "Audiobook precedence" decision rows: tags win for display (title, track),
 * the folder wins for grouping (`group_key`/`group_title`/`group_artist`)
 * and for the disc-number fallback.
 * @param {LibraryItemRow} item
 * @param {AudioTags} tags
 * @returns {AudioMetaInput}
 */
function buildRow(item, tags) {
  const parsed = item.category === 'music' ? parseMusicPath(item.rel_path) : parseAudiobookPath(item.rel_path);
  return {
    item_id: item.id,
    meta_version: AUDIO_META_VERSION,
    source_mtime_ms: item.mtime_ms,
    source_size: item.size,
    group_key: parsed.groupKey,
    group_title: parsed.groupTitle,
    group_artist: parsed.groupArtist,
    title: tags.title ?? parsed.fileTitle,
    track_no: tags.trackNo ?? parsed.fileTrackNo,
    disc_no: tags.discNo ?? parsed.folderDiscNo ?? 1,
    tag_artist: tags.artist,
    tag_album_artist: tags.albumArtist,
    tag_album: tags.album,
    tag_year: tags.year,
    duration_ms: tags.durationMs,
    tag_format: tags.format,
  };
}

/**
 * Processes one stale item: resolves its absolute path (`null` -> skip, no
 * row — the file is gone or unsafe, and the next scan removes the
 * `library_items` row too), reads its tags (a rejection is logged as
 * `audio_meta_read_failed` with no tag content and treated as an all-null
 * result, so an unreadable file still gets a folder-derived row instead of
 * vanishing from the library), then upserts the resolved row. A FOREIGN KEY
 * violation (the item was deleted by a concurrent scan after the select) is
 * swallowed as a skip rather than failing the whole run.
 * @param {{ db: import('node:sqlite').DatabaseSync, mediaRoot: string, log: Logger,
 *   readTags: typeof readAudioTags, resolvePath: typeof resolveMediaPath }} deps
 * @param {LibraryItemRow} item
 * @param {{ processed: number, failed: number }} counters
 * @returns {Promise<void>}
 */
async function processItem({ db, mediaRoot, log, readTags, resolvePath }, item, counters) {
  const absPath = await resolvePath(mediaRoot, item.rel_path);
  if (absPath === null) {
    counters.failed += 1;
    return;
  }

  let tags = NULL_TAGS;
  try {
    tags = await readTags(absPath, { ext: item.ext, size: item.size });
  } catch {
    assertOpen(db); // a read that fails because shutdown is under way must not log either
    log.warn('audio_meta_read_failed', { relPath: item.rel_path });
  }

  assertOpen(db);
  try {
    upsertAudioMeta(db, buildRow(item, tags));
    counters.processed += 1;
  } catch (err) {
    if (!isForeignKeyViolation(err)) throw err;
    counters.failed += 1;
  }
}

/**
 * Runs one full pass over every currently stale item. Lets `QuietStop` and
 * any other DB error propagate to the caller instead of catching them here,
 * so a shutdown or a real failure unwinds the whole pass (and any coalesced
 * rerun) immediately rather than only the current item.
 * @param {{ db: import('node:sqlite').DatabaseSync, mediaRoot: string, log: Logger,
 *   readTags: typeof readAudioTags, resolvePath: typeof resolveMediaPath }} deps
 * @param {() => number} now
 * @returns {Promise<void>}
 */
async function runPass(deps, now) {
  const start = now();
  const counters = { processed: 0, failed: 0 };
  const items = listStaleAudioItems(deps.db, AUDIO_META_VERSION);
  for (const item of items) {
    assertOpen(deps.db);
    await processItem(deps, item, counters);
  }
  if (counters.processed >= 1) {
    deps.log.info('audio_meta_pass', { ...counters, durationMs: now() - start });
  }
}

/**
 * Runs passes until no coalesced rerun is pending. A `QuietStop` — or any
 * error once `db.isOpen` is false — ends the loop without a log line (the
 * spec's "checks `db.isOpen` ... in its error handler"); any other error ends
 * it with `audio_meta_pass_failed` (the next completed scan retries).
 * @param {{ db: import('node:sqlite').DatabaseSync, mediaRoot: string, log: Logger,
 *   readTags: typeof readAudioTags, resolvePath: typeof resolveMediaPath }} deps
 * @param {() => number} now
 * @param {{ rerun: boolean }} state shared with `refreshAudioMeta`, which sets `rerun`
 * @returns {Promise<void>}
 */
async function runUntilSettled(deps, now, state) {
  try {
    do {
      state.rerun = false;
      await runPass(deps, now);
    } while (state.rerun);
  } catch (err) {
    if (err instanceof QuietStop || !deps.db.isOpen) return;
    deps.log.error('audio_meta_pass_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Synchronously creates the pass's `db`/`mediaRoot`/`readTags`/`resolvePath`
 * closure and the single-flight coalescing state around one run. See the
 * module doc and the spec's "Pass algorithm" decision row for the exact
 * contract.
 * @param {{ db: import('node:sqlite').DatabaseSync, mediaRoot: string, log: Logger,
 *   now?: () => number, readTags?: typeof readAudioTags, resolvePath?: typeof resolveMediaPath }} deps
 * @returns {{ refreshAudioMeta: (event?: unknown) => Promise<void>, idle: () => Promise<void> }}
 */
export function createAudioMetaPass({
  db,
  mediaRoot,
  log,
  now = Date.now,
  readTags = readAudioTags,
  resolvePath = resolveMediaPath,
}) {
  const deps = { db, mediaRoot, log, readTags, resolvePath };
  let running = false;
  const state = { rerun: false };
  /** @type {Promise<void> | null} */
  let currentPass = null;
  /** @type {Array<() => void>} */
  let idleWaiters = [];

  /** @returns {void} */
  function settleIdle() {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * @param {unknown} [_event] the scanner's `ScanCompletePayload`; unused —
   *   every pass re-selects the stale list itself instead of the event's stats.
   * @returns {Promise<void>}
   */
  function refreshAudioMeta(_event) {
    if (running) {
      state.rerun = true;
      return /** @type {Promise<void>} */ (currentPass);
    }
    running = true;
    currentPass = runUntilSettled(deps, now, state).finally(() => {
      running = false;
      currentPass = null;
      settleIdle();
    });
    return currentPass;
  }

  /** @returns {Promise<void>} */
  function idle() {
    return running ? new Promise((resolve) => idleWaiters.push(resolve)) : Promise.resolve();
  }

  return { refreshAudioMeta, idle };
}
