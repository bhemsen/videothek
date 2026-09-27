// @ts-check
import { syncDirectory } from './dir-sync.js';
import { reconcilePaths } from './reconcile.js';
import { discoverRoots, rootHealth } from './root-health.js';
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
 * Thrown by `walkDir` when `stop()` cut a walk short. `runFullScan` and
 * `runPathsReconcile` turn it into an `{ aborted: true }` result (info
 * `library_scan_stopped`), which `dispatchComplete` never reports (spec: not
 * fired for a run "cut short by `stop()`") — a normal shutdown is not a failure.
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
 *   listing (lets a test hook one file's `stat`, e.g. to interleave a reconcile).
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
      protectFailedDir(relDir, /** @type {NodeJS.ErrnoException} */ (err)?.code ?? 'unknown', stats, protectedPrefixes);
      return;
    }
    addDirStats(stats, result.stats);
    visited.add(relDir);
    // Only the full scan's own walk drains inline. A `scanSubtree` (own local
    // `visited`) must not: a nested drain's finds would miss that subtree's
    // `visited` and its own sweepPrefix() would delete them again.
    if (visited === activeFullVisited) await queue.drainPathsBetweenDirs();
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
   * A directory whose listing failed protects its subtree from this run's
   * sweep — ENOENT included (a lazily unmounted disk; spec: walk rule, D7).
   * A category root failing this way is recorded as a protected root.
   * @param {string} relDir
   * @param {string} code
   * @param {ScanStats} stats
   * @param {string[]} protectedPrefixes
   * @returns {void}
   */
  function protectFailedDir(relDir, code, stats, protectedPrefixes) {
    if (!relDir.includes('/')) {
      protectRoot(relDir, code === 'ENOENT' ? 'missing' : 'unreadable', stats, protectedPrefixes);
      return;
    }
    log.warn('library_dir_failed', { dir: relDir, code });
    stats.failedDirs += 1;
    protectedPrefixes.push(relDir);
  }

  /**
   * Protects an unhealthy category root that still has rows (D7).
   * @param {string} name
   * @param {'missing' | 'unreadable' | 'empty'} reason
   * @param {ScanStats} stats
   * @param {string[]} protectedPrefixes
   * @returns {void}
   */
  function protectRoot(name, reason, stats, protectedPrefixes) {
    if (!hasItemsUnderDir(db, name)) return;
    log.warn('library_root_protected', { root: name, reason });
    stats.protectedRoots += 1;
    protectedPrefixes.push(name);
  }

  /**
   * Visits one root candidate: walks it when healthy, else protects it (when
   * it still has rows) and records the reason. An empty root is not walked
   * but still watched and counted as visited.
   * @param {string} name
   * @param {boolean} isPresent whether `name` was found by this scan's own `discoverRoots()`
   * @param {ScanStats} stats
   * @param {Set<string>} visited
   * @param {string[]} protectedPrefixes
   * @returns {Promise<void>}
   */
  async function visitRoot(name, isPresent, stats, visited, protectedPrefixes) {
    let reason = isPresent ? await rootHealth(mediaRoot, name) : 'missing';
    if (reason === 'empty') {
      // Watched (and kept by the sweep) so a first file copied in shows up in
      // seconds; re-checked after `seen` to close the list-then-watch race.
      dirObserver.seen(name);
      visited.add(name);
      reason = await rootHealth(mediaRoot, name);
    }
    if (reason) {
      protectRoot(name, reason, stats, protectedPrefixes);
      return;
    }
    await walkDir(name, stats, visited, protectedPrefixes);
    sweepPrefix(db, name, visited, protectedPrefixes, stats);
  }

  /** @returns {Promise<ScanStats | { aborted: true }>} */
  async function runFullScan() {
    const start = Date.now();
    let discovered;
    try {
      discovered = await discoverRoots(mediaRoot);
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
    } catch (err) {
      return asAborted(err);
    } finally {
      activeFullVisited = null;
    }
    deleteOrphanedSeries(db);
    dirObserver.sweep(visited);
    stats.durationMs = Date.now() - start;
    return stats;
  }

  /** @param {unknown} err @returns {{ aborted: true }} rethrows anything but a ScanAbortedError */
  function asAborted(err) {
    if (!(err instanceof ScanAbortedError)) throw err;
    log.info('library_scan_stopped');
    return { aborted: true };
  }

  /**
   * Runs the reconcile, then stamps `durationMs` (timing the whole batch,
   * incl. subtree walks) so a `'paths'` run carries the full `ScanStats` shape.
   * @param {string[]} relPaths
   * @returns {Promise<{ stats: ScanStats, escalate: boolean } | { aborted: true }>}
   */
  async function runPathsReconcile(relPaths) {
    const start = Date.now();
    const markTouched = (/** @type {string} */ dir) => void activeFullVisited?.add(dir);
    const ctx = { db, mediaRoot, now, dirObserver, scanSubtree, markTouched };
    const result = await reconcilePaths(ctx, relPaths).catch(asAborted);
    if ('aborted' in result) return result;
    const { stats, escalate } = result;
    // A 'paths' run can delete the last episode of a series (ENOENT, a
    // changed file whose series changed, or a symlink/skipped name); without
    // this, the now-empty series row would linger until the next full scan.
    deleteOrphanedSeries(db);
    return { stats: { ...stats, durationMs: Date.now() - start }, escalate };
  }

  /**
   * @param {{ kind: 'initial' | 'full' | 'paths', stats: unknown }} payload
   * @returns {void}
   */
  function dispatchComplete({ kind, stats: rawResult }) {
    if (/** @type {{ aborted?: boolean }} */ (rawResult).aborted) return;
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
