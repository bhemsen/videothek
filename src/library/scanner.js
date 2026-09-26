// @ts-check
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { syncDirectory } from './dir-sync.js';
import { reconcilePaths } from './reconcile.js';
import { listDirectory, isSkippedName } from './walk.js';
import { categoryForFolder } from './categories.js';
import { hasItemsUnderDir, deleteItemsUnderDir, listDirsUnderDir, deleteOrphanedSeries } from '../db/library-repo.js';
import { createScanQueue } from './scan-queue.js';

/**
 * Full/subtree scan, root safety, the end-of-walk sweep, series orphan
 * cleanup and `onScanComplete` dispatch. Owns the depth-first walk that
 * `dir-sync.js` (one directory) and `reconcile.js` (path reconcile, incl.
 * its own subtree scans) are driven from. Spec: spec-library-video.md,
 * "Scanner modules" (`scanner.js`).
 */

/** @typedef {import('./dir-watch.js').Logger} Logger */
/** @typedef {import('./dir-watch.js').DirWatchSet} DirWatchSet */
/** @typedef {import('./dir-sync.js').DirSyncStats} DirSyncStats */
/** @typedef {{ added: number, updated: number, removed: number, unchanged: number, failedDirs: number, skippedSymlinks: number, skippedUndecodable: number, protectedRoots: number, durationMs: number }} ScanStats */
/** @typedef {{ running: boolean, lastCompletedAt: number | null, lastStats: ScanStats | null, lastError: string | null }} ScanStatus */
/** @typedef {{ kind: 'initial' | 'full' | 'paths', stats: ScanStats, completedAt: number }} ScanCompletePayload */

/** @type {DirWatchSet} */
const NOOP_DIR_OBSERVER = { seen() {}, gone() {}, sweep() {}, count: () => 0, closeAll() {} };

/** @returns {ScanStats} */
function emptyStats() {
  return {
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    failedDirs: 0,
    skippedSymlinks: 0,
    skippedUndecodable: 0,
    protectedRoots: 0,
    durationMs: 0,
  };
}

/** @param {ScanStats} target mutated in place @param {DirSyncStats} part @returns {void} */
function addDirStats(target, part) {
  target.added += part.added;
  target.updated += part.updated;
  target.removed += part.removed;
  target.unchanged += part.unchanged;
  target.skippedSymlinks += part.skippedSymlinks;
  target.skippedUndecodable += part.skippedUndecodable;
}

/** @param {string} dir @param {string[]} protectedPrefixes @returns {boolean} whether `dir` is, or lies under, a protected/failed prefix */
function isUnderProtected(dir, protectedPrefixes) {
  return protectedPrefixes.some((p) => dir === p || dir.startsWith(`${p}/`));
}

/**
 * Deletes rows for every DB-known directory under `rootPrefix` that the walk
 * did not visit, except under a protected/failed prefix. Shared by the full
 * scan (one call per healthy category root) and `scanSubtree` (one call
 * scoped to the reconciled directory).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} rootPrefix
 * @param {Set<string>} visited
 * @param {string[]} protectedPrefixes
 * @param {ScanStats} stats mutated in place
 * @returns {void}
 */
function sweepPrefix(db, rootPrefix, visited, protectedPrefixes, stats) {
  for (const dir of listDirsUnderDir(db, rootPrefix)) {
    if (visited.has(dir) || isUnderProtected(dir, protectedPrefixes)) continue;
    stats.removed += deleteItemsUnderDir(db, dir);
  }
}

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, mediaRoot: string, now: () => number, log: Logger, dirObserver?: DirWatchSet, statFn?: import('./walk.js').StatFn }} deps
 *   `statFn` is a test-only override threaded through to every directory
 *   listing, letting a test deterministically hook a specific file's `stat`
 *   call (e.g. to inject an interleaved reconcile mid-walk).
 * @returns {{
 *   requestFull(kind?: 'initial' | 'full'): void,
 *   requestPaths(relPaths: string[]): void,
 *   onScanComplete(listener: (payload: ScanCompletePayload) => void | Promise<void>): () => void,
 *   status(): ScanStatus,
 *   idle(): Promise<void>,
 *   stop(): void,
 * }}
 */
export function createScanner({ db, mediaRoot, log, now, dirObserver = NOOP_DIR_OBSERVER, statFn }) {
  const syncCtx = { db, mediaRoot, now, statFn };
  /** @type {Set<(payload: ScanCompletePayload) => void | Promise<void>>} */
  const listeners = new Set();
  /** @type {{ lastCompletedAt: number | null, lastStats: ScanStats | null, lastError: string | null }} */
  const state = { lastCompletedAt: null, lastStats: null, lastError: null };
  /** @type {Set<string>} known category-root dir names, across full scans */
  let knownRoots = new Set();
  /** @type {Set<string> | null} the currently-running full scan's visited set, for interleaved reconciles to extend */
  let activeFullVisited = null;

  /**
   * @param {string} relDir
   * @param {ScanStats} stats
   * @param {Set<string>} visited
   * @param {string[]} protectedPrefixes
   * @returns {Promise<void>}
   */
  async function walkDir(relDir, stats, visited, protectedPrefixes) {
    dirObserver.seen(relDir);
    let result;
    try {
      result = await syncDirectory(syncCtx, relDir);
    } catch (err) {
      log.warn('library_dir_failed', { dir: relDir, code: /** @type {NodeJS.ErrnoException} */ (err)?.code ?? 'unknown' });
      stats.failedDirs += 1;
      protectedPrefixes.push(relDir);
      return;
    }
    addDirStats(stats, result.stats);
    visited.add(relDir);
    await queue.drainPathsBetweenDirs();
    for (const child of result.dirs) {
      await walkDir(`${relDir}/${child}`, stats, visited, protectedPrefixes);
    }
  }

  /**
   * The same walk, scoped to one directory: used for a reconciled path that
   * turned out to be a directory. Its own visited set is merged into the
   * currently-running full scan's set (if one is in progress) so an
   * interleaved reconcile's finds survive that full scan's own sweep.
   * @param {string} startRelDir
   * @returns {Promise<{ stats: DirSyncStats }>}
   */
  async function scanSubtree(startRelDir) {
    const stats = emptyStats();
    const visited = new Set();
    const protectedPrefixes = /** @type {string[]} */ ([]);
    await walkDir(startRelDir, stats, visited, protectedPrefixes);
    sweepPrefix(db, startRelDir, visited, protectedPrefixes, stats);
    if (activeFullVisited) for (const dir of visited) activeFullVisited.add(dir);
    return { stats };
  }

  /**
   * @param {string} rootName exact on-disk name, currently listed at the top of `mediaRoot`
   * @returns {Promise<'empty' | 'unreadable' | null>} `null` = healthy
   */
  async function checkPresentRootHealth(rootName) {
    try {
      const { files, dirs } = await listDirectory(join(mediaRoot, rootName));
      return files.length + dirs.length === 0 ? 'empty' : null;
    } catch {
      return 'unreadable';
    }
  }

  /** @returns {Promise<Set<string>>} exact on-disk names of every category-root directory currently at the top of `mediaRoot` */
  async function discoverRoots() {
    const entries = await readdir(mediaRoot, { withFileTypes: true });
    const names = new Set();
    for (const entry of entries) {
      if (entry.isSymbolicLink() || isSkippedName(entry.name) || !entry.isDirectory()) continue;
      if (categoryForFolder(entry.name)) names.add(entry.name);
    }
    return names;
  }

  /**
   * Visits one root candidate: walks it when healthy, else protects it (when
   * it still has rows) and records the reason.
   * @param {string} name
   * @param {boolean} isPresent whether `name` was found by this scan's own `discoverRoots()`
   * @param {ScanStats} stats
   * @param {Set<string>} visited
   * @param {string[]} protectedPrefixes
   * @param {Set<string>} nextKnownRoots mutated in place
   * @returns {Promise<void>}
   */
  async function visitRoot(name, isPresent, stats, visited, protectedPrefixes, nextKnownRoots) {
    const reason = isPresent ? await checkPresentRootHealth(name) : 'missing';
    if (!reason) {
      nextKnownRoots.add(name);
      await walkDir(name, stats, visited, protectedPrefixes);
      sweepPrefix(db, name, visited, protectedPrefixes, stats);
      return;
    }
    if (hasItemsUnderDir(db, name)) {
      log.warn('library_root_protected', { root: name, reason });
      stats.protectedRoots += 1;
      protectedPrefixes.push(name);
      nextKnownRoots.add(name);
    }
  }

  /**
   * @param {'initial' | 'full'} kind
   * @returns {Promise<ScanStats | { aborted: true }>}
   */
  async function runFullScan(kind) {
    const start = Date.now();
    let discovered;
    try {
      discovered = await discoverRoots();
    } catch {
      log.warn('library_scan_failed', { reason: 'media_root_unreadable' });
      state.lastError = 'media_root_unreadable';
      return { aborted: true };
    }

    const stats = emptyStats();
    const visited = new Set();
    const protectedPrefixes = /** @type {string[]} */ ([]);
    const nextKnownRoots = new Set();
    activeFullVisited = visited;
    try {
      for (const name of new Set([...discovered, ...knownRoots])) {
        await visitRoot(name, discovered.has(name), stats, visited, protectedPrefixes, nextKnownRoots);
      }
    } finally {
      activeFullVisited = null;
    }
    knownRoots = nextKnownRoots;
    deleteOrphanedSeries(db);

    stats.durationMs = Date.now() - start;
    state.lastError = stats.protectedRoots > 0 ? 'root_protected' : stats.failedDirs > 0 ? 'dir_failed' : null;
    void kind;
    return stats;
  }

  /**
   * @param {string[]} relPaths
   * @returns {Promise<{ stats: import('./reconcile.js').ReconcileStats, escalate: boolean }>}
   */
  function runPathsReconcile(relPaths) {
    return reconcilePaths({ db, mediaRoot, now, dirObserver, scanSubtree }, relPaths);
  }

  /**
   * @param {{ kind: 'initial' | 'full' | 'paths', stats: unknown }} payload
   * @returns {void}
   */
  function dispatchComplete({ kind, stats: rawResult }) {
    if (kind !== 'paths' && /** @type {{ aborted?: boolean }} */ (rawResult).aborted) return;
    const innerStats = /** @type {ScanStats} */ (
      kind === 'paths' ? /** @type {{ stats: unknown }} */ (rawResult).stats : rawResult
    );
    state.lastCompletedAt = now();
    state.lastStats = innerStats;
    log.info('library_scan_complete', { kind, ...innerStats });
    if (innerStats.skippedUndecodable) log.warn('library_names_undecodable', { count: innerStats.skippedUndecodable });

    const payload = { kind, stats: innerStats, completedAt: state.lastCompletedAt };
    setImmediate(() => {
      for (const listener of listeners) {
        try {
          const result = listener(payload);
          if (result instanceof Promise) {
            result.catch((err) => log.error('library_listener_failed', { error: errorMessage(err) }));
          }
        } catch (err) {
          log.error('library_listener_failed', { error: errorMessage(err) });
        }
      }
    });
  }

  const queue = createScanQueue({ runFull: runFullScan, runPaths: runPathsReconcile, onComplete: dispatchComplete, log });

  return {
    requestFull: queue.requestFull,
    requestPaths: queue.requestPaths,
    onScanComplete: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status: () => ({
      running: queue.running(),
      lastCompletedAt: state.lastCompletedAt,
      lastStats: state.lastStats,
      lastError: state.lastError,
    }),
    idle: queue.idle,
    stop: queue.stop,
  };
}

/** @param {unknown} err @returns {string} */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
