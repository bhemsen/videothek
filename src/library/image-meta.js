// @ts-check

/**
 * Post-scan `image_meta` sync (D6): registered on P2's `onScanComplete`
 * (one line in `src/server.js`). A pass first inserts stub rows for
 * `images`-category items that have none yet (backfill + freshness, no file
 * I/O), then sequentially reads EXIF headers for stale JPEG rows and marks
 * every other stale row without I/O. Single-flight: a call while a pass is
 * running is coalesced into exactly one follow-up pass.
 *
 * @see docs/specs/spec-image-gallery.md — "Scan extension point",
 * "`createImageMetaSync`", "Sync failure handling".
 */

import { open as fsOpen } from 'node:fs/promises';
import {
  insertMetaStubs,
  listItemsWithoutMeta,
  listStaleMeta,
  saveMeta,
} from '../db/image-meta.js';
import { folderKeyForDir } from './image-folders.js';
import { resolveMediaPath } from '../media/paths.js';
import { EXIF_WINDOW_BYTES, JPEG_EXTENSIONS, parseExif } from './tags/exif.js';

/** @typedef {import('../log.js').Logger} Logger */

/** Current `image_meta.meta_version`; bump to force every header re-read. */
export const IMAGE_META_VERSION = 1;

const STUB_CHUNK_SIZE = 500;
const HEADER_BATCH_SIZE = 50;

/** Thrown internally to unwind a pass the instant `db.isOpen` goes false; never escapes `createImageMetaSync`. */
class QuietStop extends Error {}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
function assertOpen(db) {
  if (!db.isOpen) throw new QuietStop();
}

/**
 * Inserts stub rows (keyset cursor, chunks of `STUB_CHUNK_SIZE`) for every
 * `images` item that has no `image_meta` row yet, until none remain.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ value: number }} cursor mutated to the last inserted item's id.
 * @param {{ stubs: number }} counters
 * @returns {void}
 */
function runStubs(db, cursor, counters) {
  for (;;) {
    assertOpen(db);
    const items = listItemsWithoutMeta(db, cursor.value, STUB_CHUNK_SIZE);
    if (items.length === 0) return;
    insertMetaStubs(
      db,
      items.map((item) => ({ itemId: item.id, folder: folderKeyForDir(item.dir) }))
    );
    counters.stubs += items.length;
    cursor.value = items[items.length - 1].id;
  }
}

/**
 * Reads and saves one stale row's EXIF header, or saves null EXIF fields
 * without I/O for a non-JPEG/empty row. A per-file error (guard `null`,
 * open/read failure, an empty read) leaves the row stale — no `saveMeta`
 * call — so it is retried on the next pass; `db.isOpen` going false during
 * the file I/O propagates a `QuietStop` instead of being counted as failed.
 * @param {{ db: import('node:sqlite').DatabaseSync, mediaRoot: string,
 *   resolvePath: typeof resolveMediaPath, openFile: (path: string) => Promise<import('node:fs/promises').FileHandle>,
 *   buffer: Buffer }} deps
 * @param {{ itemId: number, relPath: string, ext: string, size: number, mtimeMs: number }} row
 * @param {{ read: number, skipped: number, failed: number }} counters
 * @returns {Promise<void>}
 */
async function processRow({ db, mediaRoot, resolvePath, openFile, buffer }, row, counters) {
  const base = { sourceSize: row.size, sourceMtimeMs: row.mtimeMs, metaVersion: IMAGE_META_VERSION };
  if (row.size <= 0 || !JPEG_EXTENSIONS.includes(row.ext)) {
    assertOpen(db);
    saveMeta(db, row.itemId, { takenAt: null, orientation: null, thumbOffset: null, thumbLength: null, ...base });
    counters.skipped += 1;
    return;
  }
  /** @type {import('node:fs/promises').FileHandle | undefined} */
  let handle;
  try {
    const path = await resolvePath(mediaRoot, row.relPath);
    if (path === null) {
      counters.failed += 1;
      return;
    }
    handle = await openFile(path);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) {
      counters.failed += 1;
      return;
    }
    const exif = parseExif(buffer.subarray(0, bytesRead));
    assertOpen(db);
    saveMeta(db, row.itemId, { ...exif, ...base });
    counters.read += 1;
  } catch (err) {
    if (err instanceof QuietStop) throw err;
    counters.failed += 1;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Keyset-walks stale rows in batches of `HEADER_BATCH_SIZE`, processing each
 * one sequentially through one reused buffer. Between batches, a pending
 * `rerun` (a call arrived mid-pass) re-runs the stub step so a file added
 * during this pass gets its header read before the pass ends.
 * @param {{ db: import('node:sqlite').DatabaseSync, mediaRoot: string,
 *   resolvePath: typeof resolveMediaPath, openFile: (path: string) => Promise<import('node:fs/promises').FileHandle>,
 *   buffer: Buffer }} deps
 * @param {{ value: number }} stubCursor shared with the initial stub step.
 * @param {{ stubs: number, read: number, skipped: number, failed: number }} counters
 * @param {() => boolean} isRerunPending
 * @returns {Promise<void>}
 */
async function runHeaders(deps, stubCursor, counters, isRerunPending) {
  const cursor = { value: 0 };
  for (;;) {
    assertOpen(deps.db);
    const batch = listStaleMeta(deps.db, cursor.value, HEADER_BATCH_SIZE, IMAGE_META_VERSION);
    if (batch.length === 0) return;
    for (const row of batch) {
      assertOpen(deps.db);
      await processRow(deps, row, counters);
      cursor.value = row.itemId;
    }
    if (isRerunPending()) runStubs(deps.db, stubCursor, counters);
  }
}

/**
 * Synchronously creates the sync's `db`/`mediaRoot`/`resolvePath`/`openFile`
 * closure and the single-flight coalescing state around one pass
 * (stubs, then headers). See the module doc and the spec's
 * `createImageMetaSync` row for the exact contract.
 * @param {{ db: import('node:sqlite').DatabaseSync, mediaRoot: string, log: Logger,
 *   now?: () => number, resolvePath?: typeof resolveMediaPath,
 *   openFile?: (path: string) => Promise<import('node:fs/promises').FileHandle> }} deps
 * @returns {{ syncImageMeta: (event?: unknown) => Promise<void>, idle: () => Promise<void> }}
 */
export function createImageMetaSync({
  db,
  mediaRoot,
  log,
  now = Date.now,
  resolvePath = resolveMediaPath,
  openFile = (path) => fsOpen(path, 'r'),
}) {
  // One buffer, reused for every header read across every pass for the life
  // of this sync (never reallocated), per the spec's memory-conscious design.
  const buffer = Buffer.alloc(EXIF_WINDOW_BYTES);
  const deps = { db, mediaRoot, resolvePath, openFile, buffer };
  let running = false;
  let rerun = false;
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

  /** @returns {Promise<void>} */
  async function runPass() {
    const counters = { stubs: 0, read: 0, skipped: 0, failed: 0 };
    const start = now();
    try {
      const stubCursor = { value: 0 };
      runStubs(db, stubCursor, counters);
      await runHeaders(deps, stubCursor, counters, () => rerun);
    } catch (err) {
      if (err instanceof QuietStop) return;
      log.error('image_meta_failed', { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (counters.stubs || counters.read || counters.skipped || counters.failed) {
      log.info('image_meta_synced', { ...counters, durationMs: now() - start });
    }
  }

  /** @returns {Promise<void>} */
  async function runUntilSettled() {
    try {
      do {
        rerun = false;
        await runPass();
      } while (rerun);
    } finally {
      running = false;
      currentPass = null;
      settleIdle();
    }
  }

  /**
   * @param {unknown} [_event] the scanner's `ScanCompletePayload`; unused —
   *   every pass re-reads the index itself instead of the event's stats.
   * @returns {Promise<void>}
   */
  function syncImageMeta(_event) {
    if (running) {
      rerun = true;
      return /** @type {Promise<void>} */ (currentPass);
    }
    running = true;
    currentPass = runUntilSettled();
    return currentPass;
  }

  /** @returns {Promise<void>} */
  function idle() {
    return running ? new Promise((resolve) => idleWaiters.push(resolve)) : Promise.resolve();
  }

  return { syncImageMeta, idle };
}
