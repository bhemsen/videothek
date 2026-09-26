// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createDirWatchSet } from '../../src/library/dir-watch.js';

const mediaRoot = join('media-root'); // relative; goes through path.join like the implementation

/** Mirrors dir-watch's own absPathFor() so tests stay separator-agnostic. */
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
 * A fake `fs.watch`-shaped function. Each created watcher records its own
 * error listener so a test can simulate an async watch error by calling
 * `watcher.triggerError(err)`.
 */
function createFakeWatchFn() {
  /** @type {string[]} */
  const calls = [];
  /** @type {Map<string, { closed: boolean, close(): void, on(event: string, cb: (err: NodeJS.ErrnoException) => void): unknown, emit(filename: string | null): void, triggerError(err: NodeJS.ErrnoException): void }>} */
  const watchers = new Map();

  /**
   * @param {string} absPath
   * @param {{ persistent?: boolean }} _options
   * @param {(eventType: string, filename: string | Buffer | null) => void} listener
   */
  function watchFn(absPath, _options, listener) {
    calls.push(absPath);
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

  return { watchFn, calls, watchers };
}

test('seen() watches a directory only once (idempotent)', () => {
  const { watchFn, calls } = createFakeWatchFn();
  const { log } = createFakeLog();
  const set = createDirWatchSet({ mediaRoot, watchFn, onEvent() {}, onWatchError() {}, log });

  set.seen('Filme');
  set.seen('Filme');

  assert.equal(calls.length, 1);
  assert.equal(set.count(), 1);
});

test('seen() joins the changed filename to the watched directory', () => {
  const { watchFn, watchers } = createFakeWatchFn();
  const { log } = createFakeLog();
  /** @type {(string | null)[]} */
  const events = [];
  const set = createDirWatchSet({ mediaRoot, watchFn, onEvent: (p) => events.push(p), onWatchError() {}, log });

  set.seen('Filme');
  watchers.get(abs('Filme'))?.emit('Movie.mp4');
  set.seen('');
  watchers.get(abs(''))?.emit('Filme');

  assert.deepEqual(events, ['Filme/Movie.mp4', 'Filme']);
});

test('seen() forwards a null filename as an escalation signal', () => {
  const { watchFn, watchers } = createFakeWatchFn();
  const { log } = createFakeLog();
  /** @type {(string | null)[]} */
  const events = [];
  const set = createDirWatchSet({ mediaRoot, watchFn, onEvent: (p) => events.push(p), onWatchError() {}, log });

  set.seen('Filme');
  watchers.get(abs('Filme'))?.emit(null);

  assert.deepEqual(events, [null]);
});

test('gone() closes the directory and every watch below it', () => {
  const { watchFn, watchers } = createFakeWatchFn();
  const { log } = createFakeLog();
  const set = createDirWatchSet({ mediaRoot, watchFn, onEvent() {}, onWatchError() {}, log });

  set.seen('Serien/Dark');
  set.seen('Serien/Dark/Staffel 1');
  set.seen('Serien/Stromberg');

  set.gone('Serien/Dark');

  assert.equal(set.count(), 1);
  assert.equal(watchers.get(abs('Serien/Dark'))?.closed, true);
  assert.equal(watchers.get(abs('Serien/Dark/Staffel 1'))?.closed, true);
  assert.equal(watchers.get(abs('Serien/Stromberg'))?.closed, false);
});

test('sweep() closes every watch not in the visited set', () => {
  const { watchFn, watchers } = createFakeWatchFn();
  const { log } = createFakeLog();
  const set = createDirWatchSet({ mediaRoot, watchFn, onEvent() {}, onWatchError() {}, log });

  set.seen('Filme');
  set.seen('Serien');

  set.sweep(new Set(['Filme']));

  assert.equal(set.count(), 1);
  assert.equal(watchers.get(abs('Serien'))?.closed, true);
});

test('a per-watch runtime error closes the watch, logs once and reports the directory', () => {
  const { watchFn, watchers } = createFakeWatchFn();
  const { log, warns } = createFakeLog();
  /** @type {string[]} */
  const errored = [];
  const set = createDirWatchSet({ mediaRoot, watchFn, onEvent() {}, onWatchError: (d) => errored.push(d), log });

  set.seen('Filme');
  const err = /** @type {NodeJS.ErrnoException} */ (new Error('boom'));
  err.code = 'EIO';
  watchers.get(abs('Filme'))?.triggerError(err);

  assert.equal(set.count(), 0);
  assert.deepEqual(errored, ['Filme']);
  assert.deepEqual(warns, [{ event: 'library_watch_error', fields: { dir: 'Filme', code: 'EIO' } }]);

  // The rescan re-adds the directory once it is reconciled.
  set.seen('Filme');
  assert.equal(set.count(), 1);
});

test('a synchronous watch error (directory vanished before watching) also reports the directory', () => {
  const watchFn = () => {
    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  };
  const { log, warns } = createFakeLog();
  /** @type {string[]} */
  const errored = [];
  const set = createDirWatchSet({ mediaRoot, watchFn, onEvent() {}, onWatchError: (d) => errored.push(d), log });

  set.seen('Filme');

  assert.equal(set.count(), 0);
  assert.deepEqual(errored, ['Filme']);
  assert.equal(warns[0]?.fields?.code, 'ENOENT');
});

test('ENOSPC/EMFILE logs library_watch_limit once and stops adding watches until the next sweep', () => {
  let blockAdds = true;
  /** @type {string[]} */
  const calls = [];
  /** @param {string} absPath */
  const watchFn = (absPath) => {
    calls.push(absPath);
    if (blockAdds) throw Object.assign(new Error('limit'), { code: 'ENOSPC' });
    return { close() {}, on() { return this; } };
  };
  const { log, warns } = createFakeLog();
  /** @type {string[]} */
  const errored = [];
  const set = createDirWatchSet({ mediaRoot, watchFn, onEvent() {}, onWatchError: (d) => errored.push(d), log });

  set.seen('Filme');
  set.seen('Serien'); // never even attempted once the limit is hit

  assert.equal(warns.length, 1);
  assert.equal(warns[0]?.event, 'library_watch_limit');
  assert.deepEqual(errored, []); // ENOSPC/EMFILE never routes through onWatchError
  assert.equal(calls.length, 1);
  assert.equal(set.count(), 0);

  // A full scan's sweep resets the limit so the next scan can try again.
  set.sweep(new Set());
  blockAdds = false;
  set.seen('Filme');

  assert.equal(set.count(), 1);
  assert.equal(calls.length, 2);
});

test('closeAll() closes every open watch', () => {
  const { watchFn, watchers } = createFakeWatchFn();
  const { log } = createFakeLog();
  const set = createDirWatchSet({ mediaRoot, watchFn, onEvent() {}, onWatchError() {}, log });

  set.seen('Filme');
  set.seen('Serien');
  set.closeAll();

  assert.equal(set.count(), 0);
  assert.equal(watchers.get(abs('Filme'))?.closed, true);
  assert.equal(watchers.get(abs('Serien'))?.closed, true);
});
