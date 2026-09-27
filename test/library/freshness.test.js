// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';
import { createScanner } from '../../src/library/scanner.js';
import { createWatcher } from '../../src/library/watcher.js';
import { createMediaTree, removeMediaTree, writeMediaFile } from '../helpers/media-tree.js';
import { NOW, fakeLog, testDb, loadRow } from '../helpers/scanner-fixtures.js';

/**
 * The one integration test wiring a real scanner to a real watcher exactly
 * like `startLibrary` does (real filesystem, real debounce timers), with
 * only the watch events themselves faked — so the 10 s freshness bound
 * (spec: "Outcome") can be exercised deterministically and fast, both at
 * rest and while a full scan is in progress, plus the periodic-rescan
 * backstop for a watcher that never reports anything. `test/library/
 * index.test.js` covers `startLibrary`'s own wiring (deferred boot, the
 * `rescanIntervalMin` timer, `stop()`); this file never calls it, since its
 * fixed `{ db, config, log, now }` signature has no room for the injectable
 * `watchFn`/`debounceMs` a fast, deterministic test needs.
 */

/**
 * A controllable fake `fs.watch`, keyed by absolute path, for driving a
 * directory's change event by hand against an otherwise fully real scanner
 * and a real temp media tree.
 * @returns {{ watchFn: import('../../src/library/dir-watch.js').WatchFn, watchers: Map<string, { emit(filename: string | null): void }> }}
 */
function createRecordingWatchFn() {
  /** @type {Map<string, { emit(filename: string | null): void }>} */
  const watchers = new Map();
  /** @type {import('../../src/library/dir-watch.js').WatchFn} */
  const watchFn = (absPath, _options, listener) => {
    const watcher = {
      close() {},
      on() {
        return watcher;
      },
      /** @param {string | null} filename */
      emit(filename) {
        listener('change', filename);
      },
    };
    watchers.set(absPath, watcher);
    return watcher;
  };
  return { watchFn, watchers };
}

/**
 * Wires a real scanner to a real watcher the same way `startLibrary` does
 * (the scanner needs the watcher's `dirObserver` at creation time, the
 * watcher needs a scanner-like object it only calls later), but with every
 * knob a fast, deterministic test needs exposed.
 * @param {{
 *   root: string,
 *   db: import('node:sqlite').DatabaseSync,
 *   log: import('../../src/library/dir-watch.js').Logger,
 *   watchFn: import('../../src/library/dir-watch.js').WatchFn,
 *   debounceMs: number,
 *   maxWaitMs: number,
 *   statFn?: import('../../src/library/walk.js').StatFn,
 * }} deps
 */
function wireLibrary({ root, db, log, watchFn, debounceMs, maxWaitMs, statFn }) {
  /** @type {ReturnType<typeof createScanner> | null} */
  let scanner = null;
  const scannerProxy = {
    /** @param {'initial' | 'full'} [kind] */
    requestFull(kind) {
      scanner?.requestFull(kind);
    },
    /** @param {string[]} relPaths */
    requestPaths(relPaths) {
      scanner?.requestPaths(relPaths);
    },
  };
  const watcher = createWatcher({ mediaRoot: root, log, scanner: scannerProxy, platform: 'linux', watchFn, debounceMs, maxWaitMs });
  scanner = createScanner({ db, mediaRoot: root, log, now: NOW, dirObserver: watcher.dirObserver, statFn });
  return { scanner, watcher };
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('a file added to a watched directory is indexed right after the short debounce flush', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/Existing.webm');
  const db = testDb();
  const { log } = fakeLog();
  const { watchFn, watchers } = createRecordingWatchFn();

  const { scanner, watcher } = wireLibrary({ root, db, log, watchFn, debounceMs: 20, maxWaitMs: 40 });
  t.after(() => {
    watcher.stop();
    scanner.stop();
  });
  watcher.start();
  scanner.requestFull('initial');
  await scanner.idle();

  await writeMediaFile(root, 'Filme/New.webm');
  watchers.get(join(root, 'Filme'))?.emit('New.webm');
  await sleep(60); // well past the 20 ms debounce
  await scanner.idle();

  assert.ok(loadRow(db, 'Filme/New.webm'), 'the new file must be indexed right after the flush');
});

test('a file added while a slow full scan is still running appears without waiting for it to finish', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  // Two directories so the walk has a directory boundary to drain at
  // (drainPathsBetweenDirs() runs once a directory's own syncDirectory has
  // fully returned, never mid-directory) while a later directory keeps the
  // overall scan in flight past that point. Both trigger files are slow, so
  // the assertion window holds regardless of readdir's (unspecified) order.
  await writeMediaFile(root, 'Filme/AAA/trigger-a.webm');
  await writeMediaFile(root, 'Filme/BBB/trigger-b.webm');
  const db = testDb();
  const { log } = fakeLog();
  const { watchFn, watchers } = createRecordingWatchFn();

  let fired = false;
  /** @param {string} absPath */
  const statFn = async (absPath) => {
    if (absPath.endsWith('trigger-a.webm') || absPath.endsWith('trigger-b.webm')) {
      if (!fired) {
        fired = true;
        // Fires on whichever trigger file the walk reaches first — the
        // owning directory's watch already exists at this point
        // (dirObserver.seen() runs before a directory's own files are
        // stat'ed) — then keeps that directory's sync in flight for well
        // past the short debounce below.
        await writeMediaFile(root, 'Filme/AAA/new.webm');
        watchers.get(join(root, 'Filme', 'AAA'))?.emit('new.webm');
      }
      await sleep(150);
    }
    return fsStat(absPath);
  };

  const { scanner, watcher } = wireLibrary({ root, db, log, watchFn, debounceMs: 20, maxWaitMs: 40, statFn });
  t.after(() => {
    watcher.stop();
    scanner.stop();
  });
  watcher.start();
  scanner.requestFull('initial');

  // Past the first directory's ~150 ms slow stat (and the drain it triggers
  // right after), still well inside the second directory's own slow stat.
  await sleep(220);
  assert.equal(scanner.status().running, true, 'the full scan must still be in flight for this to prove interleaving');
  assert.ok(loadRow(db, 'Filme/AAA/new.webm'), 'the new file must already be indexed while the full scan is still running');

  await scanner.idle();
});

test('with a silent watcher (no event ever fires), the periodic rescan backstop still catches the new file', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/Existing.webm');
  const db = testDb();
  const { log } = fakeLog();
  const { watchFn } = createRecordingWatchFn(); // never emits — simulates a broken/silent watcher

  const { scanner, watcher } = wireLibrary({ root, db, log, watchFn, debounceMs: 20, maxWaitMs: 40 });
  t.after(() => {
    watcher.stop();
    scanner.stop();
  });
  watcher.start();
  scanner.requestFull('initial');
  await scanner.idle();

  await writeMediaFile(root, 'Filme/Silent.webm');
  await sleep(30); // long past the debounce window — nothing was ever reported
  assert.equal(loadRow(db, 'Filme/Silent.webm'), undefined, 'a silent watcher must not have reported the new file');

  // Stand-in for `startLibrary`'s own `config.rescanIntervalMin` timer
  // (unit-tested in isolation by `index.test.js`): the periodic full-rescan
  // backstop is what actually catches a file a broken watcher missed.
  scanner.requestFull();
  await scanner.idle();

  assert.ok(loadRow(db, 'Filme/Silent.webm'), 'the periodic rescan must index it once it runs');
});
