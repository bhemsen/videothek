// @ts-check

import { join } from 'node:path';

/**
 * @typedef {{ close(): void, on?(event: 'error', listener: (err: NodeJS.ErrnoException) => void): unknown }} RawWatcher
 * @typedef {(absPath: string, options: { persistent?: boolean, recursive?: boolean }, listener: (eventType: string, filename: string | Buffer | null) => void) => RawWatcher} WatchFn
 * @typedef {{ info(event: string, fields?: Record<string, unknown>): void, warn(event: string, fields?: Record<string, unknown>): void, error(event: string, fields?: Record<string, unknown>): void }} Logger
 */

/**
 * @typedef {object} DirWatchSet
 * @property {(relDir: string) => void} seen Ensure a non-recursive watch exists for `relDir` (idempotent). A no-op after `closeAll`.
 * @property {(relDir: string) => void} gone Close the watch for `relDir` and every watch below it.
 * @property {(visitedDirs: Set<string>) => void} sweep Close every watch whose directory was not visited; only call after a full scan. Never closes the `''` (MEDIA_ROOT) watch — the scanner's walk never visits MEDIA_ROOT itself, so `visitedDirs` never contains `''`.
 * @property {() => number} count Number of currently open watches.
 * @property {() => void} closeAll Close every open watch.
 */

/** @typedef {{ mediaRoot: string, watchFn: WatchFn, onEvent: (relPath: string | null) => void, onWatchError: (relDir: string) => void, log: Logger }} Deps */
/** @typedef {{ watches: Map<string, RawWatcher>, limitReached: boolean, stopped: boolean }} State */

/**
 * Creates the per-directory watch set used as the scanner's `dirObserver` on
 * Linux: one non-recursive `fs.watch` per directory the scanner walk visits,
 * kept in sync with `seen`/`gone`/`sweep`. Each watch handles its own error
 * independently; a resource-limit error (`ENOSPC`/`EMFILE`) is logged once
 * and stops new watches from being added until the next `sweep` (i.e. the
 * next full scan). The `''` (MEDIA_ROOT) entry is seeded only by the
 * watcher's own `start()`, never by the scanner's walk, so `sweep` leaves it
 * alone regardless of `visitedDirs` (see decision log, #31). `seen` is a
 * no-op after `closeAll` so an in-flight scan cannot reopen a watch post-stop.
 *
 * @param {Deps} deps
 * @returns {DirWatchSet}
 */
export function createDirWatchSet(deps) {
  /** @type {State} */
  const state = { watches: new Map(), limitReached: false, stopped: false };
  return {
    seen: (relDir) => seen(state, deps, relDir),
    gone: (relDir) => gone(state, relDir),
    sweep: (visitedDirs) => sweep(state, visitedDirs),
    count: () => state.watches.size,
    closeAll: () => closeAll(state),
  };
}

/**
 * @param {string} mediaRoot
 * @param {string} relDir
 */
function absPathFor(mediaRoot, relDir) {
  return relDir === '' ? mediaRoot : join(mediaRoot, relDir);
}

/**
 * @param {State} state
 * @param {string} relDir
 */
function closeWatch(state, relDir) {
  const watcher = state.watches.get(relDir);
  if (!watcher) return;
  state.watches.delete(relDir);
  try {
    watcher.close();
  } catch {
    // already closed by the OS (e.g. directory removed) — nothing to do.
  }
}

/**
 * @param {State} state
 * @param {Deps} deps
 * @param {string} relDir
 * @param {NodeJS.ErrnoException} [err]
 */
function handleFailure(state, deps, relDir, err) {
  if (err && (err.code === 'ENOSPC' || err.code === 'EMFILE')) {
    if (!state.limitReached) {
      state.limitReached = true;
      deps.log.warn('library_watch_limit', { count: state.watches.size });
    }
    return;
  }
  deps.log.warn('library_watch_error', { dir: relDir, code: err?.code ?? 'unknown' });
  deps.onWatchError(relDir);
}

/**
 * @param {string} relDir
 * @param {string} filename
 */
function joinRelPath(relDir, filename) {
  return relDir === '' ? filename : `${relDir}/${filename}`;
}

/**
 * @param {State} state
 * @param {Deps} deps
 * @param {string} relDir
 */
function seen(state, deps, relDir) {
  if (state.stopped || state.watches.has(relDir) || state.limitReached) return;
  /** @type {RawWatcher} */
  let watcher;
  try {
    watcher = deps.watchFn(absPathFor(deps.mediaRoot, relDir), { persistent: true }, (_eventType, filename) => {
      if (filename === null || filename === undefined) {
        deps.onEvent(null);
        return;
      }
      deps.onEvent(joinRelPath(relDir, String(filename)));
    });
  } catch (err) {
    handleFailure(state, deps, relDir, /** @type {NodeJS.ErrnoException} */ (err));
    return;
  }
  watcher.on?.('error', (err) => {
    closeWatch(state, relDir);
    handleFailure(state, deps, relDir, err);
  });
  state.watches.set(relDir, watcher);
}

/**
 * @param {State} state
 * @param {string} relDir
 */
function gone(state, relDir) {
  const prefix = relDir === '' ? '' : `${relDir}/`;
  for (const key of [...state.watches.keys()]) {
    if (key === relDir || key.startsWith(prefix)) closeWatch(state, key);
  }
}

/**
 * Closes every watch whose directory was not visited by the full scan that
 * just completed, except `''` (MEDIA_ROOT): the scanner's walk never visits
 * MEDIA_ROOT itself, so `visitedDirs` never contains `''`, and treating it
 * like any other unvisited key would close the root watch after the first
 * full scan with nothing left to reopen it (decision log, #31).
 *
 * @param {State} state
 * @param {Set<string>} visitedDirs
 */
function sweep(state, visitedDirs) {
  for (const key of [...state.watches.keys()]) {
    if (key !== '' && !visitedDirs.has(key)) closeWatch(state, key);
  }
  state.limitReached = false;
}

/** @param {State} state */
function closeAll(state) {
  state.stopped = true;
  for (const key of [...state.watches.keys()]) closeWatch(state, key);
}
