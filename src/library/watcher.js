// @ts-check

import fs from 'node:fs';
import { createDirWatchSet } from './dir-watch.js';

/** @typedef {import('./dir-watch.js').WatchFn} WatchFn */
/** @typedef {import('./dir-watch.js').DirWatchSet} DirWatchSet */
/** @typedef {import('./dir-watch.js').Logger} Logger */
/** @typedef {{ requestFull(kind?: string): void, requestPaths(relPaths: string[]): void }} ScannerLike */
/** @typedef {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} Timers */

const BACKOFF_INITIAL_MS = 5000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const ESCALATE_PATH_COUNT = 1000;

/** @type {DirWatchSet} */
const NOOP_DIR_OBSERVER = {
  seen() {},
  gone() {},
  sweep() {},
  count: () => 0,
  closeAll() {},
};

/**
 * Creates change detection for the library: per-directory watches on Linux
 * (via `dir-watch.js`, exposed as `dirObserver` for the scanner to drive) or
 * one native recursive watch on macOS/Windows. Both modes debounce raw
 * filesystem events into `scanner.requestPaths`/`requestFull` calls and never
 * stay off after an error — a failed root/recursive watch retries with
 * exponential backoff and triggers a full scan once it recovers.
 *
 * @param {{
 *   mediaRoot: string,
 *   scanner: ScannerLike,
 *   log: Logger,
 *   platform?: string,
 *   watchFn?: WatchFn,
 *   timers?: Timers,
 *   debounceMs?: number,
 *   maxWaitMs?: number,
 * }} deps
 * @returns {{ dirObserver: DirWatchSet, start(): void, stop(): void }}
 */
export function createWatcher({
  mediaRoot,
  scanner,
  log,
  platform = process.platform,
  watchFn = /** @type {WatchFn} */ (/** @type {unknown} */ (fs.watch)),
  timers = { setTimeout, clearTimeout },
  debounceMs = 5000,
  maxWaitMs = 8000,
}) {
  let stopped = true;
  const debounce = createDebounce({ scanner, timers, debounceMs, maxWaitMs });
  const onFsEvent = (/** @type {string | null} */ relPath) => {
    if (!stopped) debounce.record(relPath);
  };
  const rootBackoff = createBackoff({ timers, onRecover: () => scanner.requestFull() });
  const mode =
    platform === 'linux'
      ? createLinuxMode({ mediaRoot, watchFn, log, scanner, rootBackoff, onFsEvent, isStopped: () => stopped })
      : createRecursiveMode({ mediaRoot, watchFn, log, rootBackoff, onFsEvent, isStopped: () => stopped });

  function start() {
    stopped = false;
    mode.start();
  }

  function stop() {
    stopped = true;
    debounce.stop();
    rootBackoff.stop();
    mode.stop();
  }

  return { dirObserver: mode.dirObserver, start, stop };
}

/**
 * Linux mode: per-directory watches driven by the scanner's walk through
 * `dirObserver`. The `dirObserver.seen('')` call watches `MEDIA_ROOT` itself
 * (the scanner's own walk never visits `MEDIA_ROOT`, only the category roots
 * below it); if that particular watch fails, it gets the same backoff
 * treatment as the recursive watch instead of a plain `requestPaths(['' ])`,
 * since losing it means missing everything.
 *
 * @param {{ mediaRoot: string, watchFn: WatchFn, log: Logger, scanner: ScannerLike, rootBackoff: ReturnType<typeof createBackoff>, onFsEvent: (relPath: string | null) => void, isStopped: () => boolean }} deps
 */
function createLinuxMode({ mediaRoot, watchFn, log, scanner, rootBackoff, onFsEvent, isStopped }) {
  // Guards against a retry attempt's own failure re-entering onWatchError
  // (dir-watch calls it synchronously) and scheduling a second, overlapping
  // backoff sequence on top of the one already driving that same attempt.
  let rootRetrying = false;

  /** @param {string} relDir */
  function onWatchError(relDir) {
    if (isStopped()) return;
    if (relDir !== '') {
      scanner.requestPaths([relDir]);
      return;
    }
    if (rootRetrying) return;
    rootRetrying = true;
    rootBackoff.retry(attemptRootWatch);
  }

  const dirObserver = createDirWatchSet({ mediaRoot, watchFn, onEvent: onFsEvent, onWatchError, log });

  function attemptRootWatch() {
    const before = dirObserver.count();
    dirObserver.seen('');
    const success = dirObserver.count() > before;
    if (success) rootRetrying = false;
    return success;
  }

  return {
    dirObserver,
    start: () => dirObserver.seen(''),
    stop: () => {
      rootRetrying = false;
      dirObserver.closeAll();
    },
  };
}

/**
 * macOS/Windows mode: one native recursive watch on `MEDIA_ROOT`; `dirObserver`
 * is a no-op since the scanner needs no per-directory watches here.
 *
 * @param {{ mediaRoot: string, watchFn: WatchFn, log: Logger, rootBackoff: ReturnType<typeof createBackoff>, onFsEvent: (relPath: string | null) => void, isStopped: () => boolean }} deps
 */
function createRecursiveMode({ mediaRoot, watchFn, log, rootBackoff, onFsEvent, isStopped }) {
  /** @type {ReturnType<WatchFn> | null} */
  let watcher = null;

  /** @param {string} eventType @param {string | Buffer | null} filename */
  function handleEvent(eventType, filename) {
    if (filename === null || filename === undefined) {
      onFsEvent(null);
      return;
    }
    onFsEvent(String(filename).replaceAll('\\', '/'));
  }

  function close() {
    if (!watcher) return;
    try {
      watcher.close();
    } catch {
      // already gone
    }
    watcher = null;
  }

  /** @returns {boolean} */
  function attempt() {
    /** @type {ReturnType<WatchFn>} */
    let thisWatcher;
    try {
      thisWatcher = watchFn(mediaRoot, { persistent: true, recursive: true }, handleEvent);
    } catch (err) {
      log.warn('library_watch_error', { dir: '', code: /** @type {NodeJS.ErrnoException} */ (err)?.code ?? 'unknown' });
      return false;
    }
    watcher = thisWatcher;
    // Guards against the same (already-closed) watcher emitting 'error'
    // twice: the first error nulls out `watcher` via close(), so a stale
    // duplicate no longer matches `thisWatcher` and cannot schedule a second,
    // overlapping backoff retry.
    thisWatcher.on?.('error', (err) => {
      if (watcher !== thisWatcher || isStopped()) return;
      close();
      log.warn('library_watch_error', { dir: '', code: err?.code ?? 'unknown' });
      rootBackoff.retry(attempt);
    });
    return true;
  }

  return {
    dirObserver: NOOP_DIR_OBSERVER,
    start: () => {
      if (!attempt()) rootBackoff.retry(attempt);
    },
    stop: close,
  };
}

/**
 * Trailing/max-wait debounce shared by both platforms: events accumulate in
 * a pending set and flush as one `requestPaths` call 5 s after the last
 * event, but at most 8 s after the first pending event; a `null` path or
 * more than 1000 pending paths flushes as `requestFull` instead.
 *
 * @param {{ scanner: ScannerLike, timers: Timers, debounceMs: number, maxWaitMs: number }} deps
 */
function createDebounce({ scanner, timers, debounceMs, maxWaitMs }) {
  /** @type {Set<string>} */
  let pending = new Set();
  let escalated = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let trailingTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let maxWaitTimer = null;

  function clearTimers() {
    if (trailingTimer) timers.clearTimeout(trailingTimer);
    if (maxWaitTimer) timers.clearTimeout(maxWaitTimer);
    trailingTimer = null;
    maxWaitTimer = null;
  }

  function flush() {
    clearTimers();
    const paths = [...pending];
    const wasEscalated = escalated;
    pending = new Set();
    escalated = false;
    if (wasEscalated) {
      scanner.requestFull();
      return;
    }
    if (paths.length > 0) scanner.requestPaths(paths);
  }

  /** @param {string | null} relPath */
  function record(relPath) {
    if (relPath === null) {
      escalated = true;
    } else if (!escalated) {
      // Once escalated, the set is thrown away unread at flush, so stop
      // growing it — a long burst would otherwise accumulate paths forever.
      pending.add(relPath);
      if (pending.size > ESCALATE_PATH_COUNT) escalated = true;
    }
    if (!maxWaitTimer) maxWaitTimer = timers.setTimeout(flush, maxWaitMs);
    if (trailingTimer) timers.clearTimeout(trailingTimer);
    trailingTimer = timers.setTimeout(flush, debounceMs);
  }

  function stop() {
    clearTimers();
    pending = new Set();
    escalated = false;
  }

  return { record, stop };
}

/**
 * Exponential-backoff retry helper (5 s doubling up to 5 min) for the
 * catastrophic watches (recursive macOS/Windows watch, Linux root watch): a
 * failed attempt is retried after a growing delay; a successful attempt
 * resets the delay and runs `onRecover` once (events may have been missed).
 *
 * @param {{ timers: Timers, onRecover: () => void }} deps
 */
function createBackoff({ timers, onRecover }) {
  let delayMs = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  /** @param {() => boolean} attempt */
  function retry(attempt) {
    delayMs = delayMs === 0 ? BACKOFF_INITIAL_MS : Math.min(delayMs * 2, BACKOFF_MAX_MS);
    timer = timers.setTimeout(() => {
      timer = null;
      if (attempt()) {
        delayMs = 0;
        onRecover();
      } else {
        retry(attempt);
      }
    }, delayMs);
  }

  function stop() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    delayMs = 0;
  }

  return { retry, stop };
}
