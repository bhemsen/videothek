// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createWatcher } from '../../src/library/watcher.js';

const mediaRoot = join('media-root');

/** @param {string} relDir */
function abs(relDir) {
  return relDir === '' ? mediaRoot : join(mediaRoot, relDir);
}

function createFakeLog() {
  /** @type {{ event: string, fields?: Record<string, unknown> }[]} */
  const warns = [];
  return {
    log: {
      info() {},
      /** @param {string} event @param {Record<string, unknown>} [fields] */
      warn: (event, fields) => warns.push({ event, fields }),
      error() {},
    },
    warns,
  };
}

/**
 * A controllable fake `fs.watch`. `failNextTimes(n, code)` makes the next `n`
 * calls throw synchronously (simulating a directory/root that cannot be
 * watched yet); afterwards calls succeed and return a fake watcher whose
 * `emit`/`triggerError` let a test drive it directly.
 */
function createControllableWatchFn() {
  /** @type {{ absPath: string, options: unknown }[]} */
  const calls = [];
  /** @type {Map<string, { closed: boolean, close(): void, on(event: string, cb: (err: NodeJS.ErrnoException) => void): unknown, emit(filename: string | null): void, triggerError(err: NodeJS.ErrnoException): void }>} */
  const watchers = new Map();
  let failNext = 0;
  let failCode = 'EIO';

  /**
   * @param {string} absPath
   * @param {unknown} options
   * @param {(eventType: string, filename: string | Buffer | null) => void} listener
   */
  function watchFn(absPath, options, listener) {
    calls.push({ absPath, options });
    if (failNext > 0) {
      failNext -= 1;
      throw Object.assign(new Error('fail'), { code: failCode });
    }
    /** @type {((err: NodeJS.ErrnoException) => void) | null} */
    let errorListener = null;
    const watcher = {
      closed: false,
      close() {
        this.closed = true;
      },
      /** @param {string} event @param {(err: NodeJS.ErrnoException) => void} cb */
      on(event, cb) {
        if (event === 'error') errorListener = cb;
        return this;
      },
      /** @param {string | null} filename */
      emit(filename) {
        listener('change', filename);
      },
      /** @param {NodeJS.ErrnoException} err */
      triggerError(err) {
        errorListener?.(err);
      },
    };
    watchers.set(absPath, watcher);
    return watcher;
  }

  /** @param {number} n @param {string} [code] */
  function failNextTimes(n, code = 'EIO') {
    failNext = n;
    failCode = code;
  }

  return { watchFn, calls, watchers, failNextTimes };
}

/** @returns {{ requestFull(): void, requestPaths(p: string[]): void, fullCount: number, pathsCalls: string[][] }} */
function createFakeScanner() {
  /** @type {string[][]} */
  const pathsCalls = [];
  const scanner = {
    fullCount: 0,
    pathsCalls,
    requestFull() {
      scanner.fullCount += 1;
    },
    /** @param {string[]} p */
    requestPaths(p) {
      pathsCalls.push(p);
    },
  };
  return scanner;
}

test('Linux: pending paths flush once, 5 s after the last event', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { watchFn, watchers } = createControllableWatchFn();
  const scanner = createFakeScanner();
  const watcher = createWatcher({ mediaRoot, scanner, log: createFakeLog().log, platform: 'linux', watchFn });

  watcher.start();
  watcher.dirObserver.seen('Filme');
  watchers.get(abs('Filme'))?.emit('a.mp4');
  t.mock.timers.tick(5000);

  assert.deepEqual(scanner.pathsCalls, [['Filme/a.mp4']]);
  assert.equal(scanner.fullCount, 0);
});

test('Linux: a continuous event stream still flushes at 8 s (max wait)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { watchFn, watchers } = createControllableWatchFn();
  const scanner = createFakeScanner();
  const watcher = createWatcher({ mediaRoot, scanner, log: createFakeLog().log, platform: 'linux', watchFn });

  watcher.start();
  watcher.dirObserver.seen('Filme');
  const w = watchers.get(abs('Filme'));

  w?.emit('a1.mp4'); // t=0: trailing @5000, maxWait @8000
  t.mock.timers.tick(2000); // t=2000
  w?.emit('a2.mp4'); // trailing pushed to 7000, maxWait stays at 8000
  t.mock.timers.tick(2000); // t=4000
  w?.emit('a3.mp4'); // trailing pushed to 9000, maxWait still 8000
  t.mock.timers.tick(2000); // t=6000
  w?.emit('a4.mp4'); // trailing pushed to 11000, maxWait still 8000
  t.mock.timers.tick(2000); // t=8000: maxWait fires despite the still-pending trailing timer

  assert.equal(scanner.pathsCalls.length, 1);
  assert.deepEqual(scanner.pathsCalls[0].sort(), ['Filme/a1.mp4', 'Filme/a2.mp4', 'Filme/a3.mp4', 'Filme/a4.mp4']);

  t.mock.timers.tick(10000); // the stale trailing timer must already be cleared by the flush
  assert.equal(scanner.pathsCalls.length, 1);
});

test('a null filename escalates the next flush to a full scan', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { watchFn, watchers } = createControllableWatchFn();
  const scanner = createFakeScanner();
  const watcher = createWatcher({ mediaRoot, scanner, log: createFakeLog().log, platform: 'linux', watchFn });

  watcher.start();
  watcher.dirObserver.seen('Filme');
  watchers.get(abs('Filme'))?.emit(null);
  t.mock.timers.tick(5000);

  assert.equal(scanner.fullCount, 1);
  assert.deepEqual(scanner.pathsCalls, []);
});

test('more than 1000 pending paths escalates the next flush to a full scan', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { watchFn, watchers } = createControllableWatchFn();
  const scanner = createFakeScanner();
  const watcher = createWatcher({ mediaRoot, scanner, log: createFakeLog().log, platform: 'linux', watchFn });

  watcher.start();
  watcher.dirObserver.seen('Filme');
  const w = watchers.get(abs('Filme'));
  for (let i = 0; i < 1001; i += 1) w?.emit(`f${i}.mp4`);
  t.mock.timers.tick(5000);

  assert.equal(scanner.fullCount, 1);
  assert.deepEqual(scanner.pathsCalls, []);
});

test('a non-root Linux directory watch error calls requestPaths immediately, undebounced', () => {
  const { watchFn, watchers } = createControllableWatchFn();
  const scanner = createFakeScanner();
  const watcher = createWatcher({ mediaRoot, scanner, log: createFakeLog().log, platform: 'linux', watchFn });

  watcher.start();
  watcher.dirObserver.seen('Filme');
  watchers.get(abs('Filme'))?.triggerError(/** @type {NodeJS.ErrnoException} */ (Object.assign(new Error('x'), { code: 'EIO' })));

  assert.deepEqual(scanner.pathsCalls, [['Filme']]);
  assert.equal(scanner.fullCount, 0);
});

test('the Linux MEDIA_ROOT watch gets the same backoff as the recursive watch and requests a full scan on recovery', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { watchFn, watchers } = createControllableWatchFn();
  const scanner = createFakeScanner();
  const watcher = createWatcher({ mediaRoot, scanner, log: createFakeLog().log, platform: 'linux', watchFn });

  watcher.start();
  assert.equal(watcher.dirObserver.count(), 1);
  watchers.get(mediaRoot)?.triggerError(/** @type {NodeJS.ErrnoException} */ (Object.assign(new Error('x'), { code: 'EIO' })));
  assert.equal(watcher.dirObserver.count(), 0);
  assert.equal(scanner.pathsCalls.length, 0); // not the generic per-directory path

  t.mock.timers.tick(5000);

  assert.equal(watcher.dirObserver.count(), 1);
  assert.equal(scanner.fullCount, 1);
});

test('recursive mode (macOS/Windows) restarts with 5 s, 10 s, ... doubling capped at 5 min, and requests a full scan on recovery', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { watchFn, calls, failNextTimes } = createControllableWatchFn();
  // Delays: 5s, 10s, 20s, 40s, 80s, 160s, then 320s would be next but caps at 300s (5 min).
  failNextTimes(7);
  const scanner = createFakeScanner();
  const watcher = createWatcher({ mediaRoot, scanner, log: createFakeLog().log, platform: 'darwin', watchFn });

  watcher.start();
  assert.equal(calls.length, 1);

  const delays = [5000, 10000, 20000, 40000, 80000, 160000, 300000];
  for (const delay of delays) t.mock.timers.tick(delay);

  assert.equal(calls.length, 8);
  assert.equal(scanner.fullCount, 1);
});

test('recursive mode: an error on a running watch retries and recovers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { watchFn, watchers } = createControllableWatchFn();
  const scanner = createFakeScanner();
  const watcher = createWatcher({ mediaRoot, scanner, log: createFakeLog().log, platform: 'win32', watchFn });

  watcher.start();
  watchers.get(mediaRoot)?.triggerError(/** @type {NodeJS.ErrnoException} */ (Object.assign(new Error('x'), { code: 'EIO' })));
  assert.equal(scanner.fullCount, 0);

  t.mock.timers.tick(5000);

  assert.equal(scanner.fullCount, 1);
});

test('recursive mode: relative-path events use forward slashes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { watchFn, watchers } = createControllableWatchFn();
  const scanner = createFakeScanner();
  const watcher = createWatcher({ mediaRoot, scanner, log: createFakeLog().log, platform: 'win32', watchFn });

  watcher.start();
  watchers.get(mediaRoot)?.emit('Filme\\Movie.mp4');
  t.mock.timers.tick(5000);

  assert.deepEqual(scanner.pathsCalls, [['Filme/Movie.mp4']]);
});

test('stop() clears all timers and closes every watch; nothing fires afterwards', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { watchFn, watchers } = createControllableWatchFn();
  const scanner = createFakeScanner();
  const watcher = createWatcher({ mediaRoot, scanner, log: createFakeLog().log, platform: 'linux', watchFn });

  watcher.start();
  watcher.dirObserver.seen('Filme');
  watchers.get(abs('Filme'))?.emit('a.mp4');

  watcher.stop();

  assert.equal(watcher.dirObserver.count(), 0);
  assert.equal(watchers.get(mediaRoot)?.closed, true);
  assert.equal(watchers.get(abs('Filme'))?.closed, true);

  t.mock.timers.tick(20000);

  assert.deepEqual(scanner.pathsCalls, []);
  assert.equal(scanner.fullCount, 0);
});
