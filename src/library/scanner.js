// @ts-check
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { syncDirectory } from './dir-sync.js';
import { reconcilePaths } from './reconcile.js';
import { listDirectory, isSkippedName } from './walk.js';
import { categoryForFolder } from './categories.js';
import { hasItemsUnderDir, listIndexedRootNames, deleteOrphanedSeries } from '../db/library-repo.js';
import { createScanQueue } from './scan-queue.js';
import { emptyStats, addDirStats, sweepPrefix } from './scan-stats.js';

/**
 * Full/subtree scan, root safety, the end-of-walk sweep, series orphan
 * cleanup and `onScanComplete` dispatch. Owns the depth-first walk that
 * `dir-sync.js` (one directory) and `reconcile.js` (path reconcile, incl.
 * its own subtree scans) are driven from. Spec: spec-library-video.md,
 * "Scanner modules" (`scanner.js`).
 */

/** @typedef {import('./dir-watch.js').Logger} Logger */
/** @typedef {import('./dir-watch.js').DirWatchSet} DirWatchSet */
/** @typedef {import('./scan-stats.js').ScanStats} ScanStats */
/** @typedef {{ running: boolean, lastCompletedAt: number | null, lastStats: ScanStats | null, lastError: string | null }} ScanStatus */
/** @typedef {{ kind: 'initial' | 'full' | 'paths', stats: ScanStats, completedAt: number }} ScanCompletePayload */

/** @type {DirWatchSet} */
const NOOP_DIR_OBSERVER = { seen() {}, gone() {}, sweep() {}, count: () => 0, closeAll() {} };

/**
 * Thrown by `walkDir` when `stop()` cut a walk short; propagates out of
 * `runFullScan`/`scanSubtree` uncaught, so `scan-queue.js` logs the run as
 * failed instead of reporting a completion (spec: not fired for a run "cut
 * short by `stop()`").
 */
class ScanAbortedError extends Error {
  constructor() {
    super('scan aborted by stop()');
    this.name = 'ScanAbortedError';
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
  /** @type {Set<string> | null} the currently-running full scan's visited set, for interleaved reconciles to extend */
  let activeFullVisited = null;
  /** @type {boolean} set by `stop()`; checked by `walkDir` between directories so a full/subtree walk aborts instead of running to completion */
  let stopped = false;

  /**
   * @param {string} relDir
   * @param {ScanStats} stats
   * @param {Set<string>} visited
   * @param {string[]} protectedPrefixes
   * @returns {Promise<void>}
   */
  async function walkDir(relDir, stats, visited, protectedPrefixes) {
    if (stopped) throw new ScanAbortedError();
    dirObserver.seen(relDir);
    let result;
    try {
      result = await syncDirectory(syncCtx, relDir);
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err)?.code ?? 'unknown';
      if (code !== 'ENOENT') {
        log.warn('library_dir_failed', { dir: relDir, code });
        stats.failedDirs += 1;
        protectedPrefixes.push(relDir);
      }
      // ENOENT: the directory vanished between its parent's listing and its
      // own readdir (an interleaved reconcile, or a user deleting it mid-scan)
      // — treated as simply gone, not a failure: it is left out of `visited`
      // so the end-of-walk sweep deletes its rows, with no warning and no
      // protected subtree.
      return;
    }
    addDirStats(stats, result.stats);
    visited.add(relDir);
    if (activeFullVisited) await queue.drainPathsBetweenDirs();
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
   * @returns {Promise<{ stats: ScanStats }>}
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
   * @returns {Promise<void>}
   */
  async function visitRoot(name, isPresent, stats, visited, protectedPrefixes) {
    const reason = isPresent ? await checkPresentRootHealth(name) : 'missing';
    if (!reason) {
      await walkDir(name, stats, visited, protectedPrefixes);
      sweepPrefix(db, name, visited, protectedPrefixes, stats);
      return;
    }
    if (hasItemsUnderDir(db, name)) {
      log.warn('library_root_protected', { root: name, reason });
      stats.protectedRoots += 1;
      protectedPrefixes.push(name);
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
    const rootCandidates = new Set([...discovered, ...listIndexedRootNames(db)]);
    activeFullVisited = visited;
    try {
      for (const name of rootCandidates) {
        await visitRoot(name, discovered.has(name), stats, visited, protectedPrefixes);
      }
    } finally {
      activeFullVisited = null;
    }
    deleteOrphanedSeries(db);
    dirObserver.sweep(visited);

    stats.durationMs = Date.now() - start;
    void kind;
    return stats;
  }

  /**
   * Runs the reconcile, then stamps `durationMs` on its stats so a `'paths'`
   * run's stats carry the same full `ScanStats` shape as `'initial'`/`'full'`
   * (`reconcile.js`'s `ReconcileStats` deliberately omits `durationMs`, since
   * only this wrapper — timing the whole batch, incl. any subtree walks —
   * knows it).
   * @param {string[]} relPaths
   * @returns {Promise<{ stats: ScanStats, escalate: boolean }>}
   */
  async function runPathsReconcile(relPaths) {
    const start = Date.now();
    const { stats, escalate } = await reconcilePaths({ db, mediaRoot, now, dirObserver, scanSubtree }, relPaths);
    return { stats: { ...stats, durationMs: Date.now() - start }, escalate };
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
    // Applies to every run kind (not just full scans): a 'paths' run may
    // itself carry a failed/protected subtree via an interleaved reconcile's
    // scanSubtree, and a run that completes cleanly must reset a lingering
    // error from an earlier one.
    state.lastError = innerStats.protectedRoots > 0 ? 'root_protected' : innerStats.failedDirs > 0 ? 'dir_failed' : null;
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

  /**
   * Stops the queue from starting any further run (`queue.stop()`) and marks
   * this scanner `stopped` so `walkDir` aborts the run currently in flight
   * (if any) at its next directory, instead of letting it run to completion.
   * @returns {void}
   */
  function stop() {
    stopped = true;
    queue.stop();
  }

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
    stop,
  };
}

/** @param {unknown} err @returns {string} */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
