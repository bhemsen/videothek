/**
 * Overflow slice of `progress-client.test.js` (P1's 300-line test-file cap):
 * the pending-entry-fetch contract of `trackPlayback` (sync return, interval
 * survival, stop safety) plus two edge cases from the resume/report spec.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackPlayback } from '../../public/js/lib/progress.js';

/** @typedef {import('../../public/js/lib/progress.js').ProgressEntry} ProgressEntry */

/** @param {number} itemId @param {number} position @param {number | null} duration @param {ProgressEntry['state']} state @returns {ProgressEntry} */
function makeEntry(itemId, position, duration, state) {
  return { itemId, position, duration, state, updatedAt: null };
}

/** A fake `EventTarget` exposing a synchronous `dispatch` for tests. */
function createTarget() {
  /** @type {Map<string, Set<() => void>>} */
  const listeners = new Map();
  return {
    addEventListener(/** @type {string} */ type, /** @type {() => void} */ fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(fn);
    },
    removeEventListener(/** @type {string} */ type, /** @type {() => void} */ fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(/** @type {string} */ type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
  };
}

/** @param {{ readyState?: number, duration?: number, currentTime?: number }} [opts] */
function createMedia({ readyState = 0, duration = NaN, currentTime = 0 } = {}) {
  return { ...createTarget(), readyState, duration, currentTime };
}

/** Installs a stubbed `document`/`window` pair and returns `document`. */
function stubDocWin() {
  const doc = { ...createTarget(), visibilityState: 'visible' };
  /** @type {{ document?: unknown }} */ (globalThis).document = doc;
  /** @type {{ window?: unknown }} */ (globalThis).window = createTarget();
  return doc;
}

/** Installs a stub `fetch` echoing a PUT body back as the entry; logs every call.
 * @returns {{ url: string, init: RequestInit }[]} */
function stubFetch() {
  const calls = /** @type {{ url: string, init: RequestInit }[]} */ ([]);
  globalThis.fetch = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      /** @param {unknown} input @param {unknown} init */
      async (input, init) => {
        const requestInit = /** @type {RequestInit} */ (init ?? {});
        calls.push({ url: String(input), init: requestInit });
        const body = requestInit.body ? JSON.parse(String(requestInit.body)) : {};
        const entry = makeEntry(1, body.position ?? 0, body.duration ?? null, 'in_progress');
        return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(entry) };
      }
    )
  );
  return calls;
}

/** Flushes pending microtasks (report/fetch promises) without touching mocked timers. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** @param {{ dispatch: (type: string) => void }} target @param {string} type */
async function fireOn(target, type) {
  target.dispatch(type);
  await flush();
}

test('trackPlayback returns the stop handle synchronously; a playing event during the pending entry fetch still starts the report interval', async (t) => {
  stubDocWin();
  /** @type {(v: unknown) => void} */
  let resolveFetch = () => {};
  globalThis.fetch = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (() => new Promise((resolve) => { resolveFetch = resolve; }))
  );
  t.mock.timers.enable({ apis: ['setInterval'] });
  const media = createMedia({ readyState: 1, duration: 1000, currentTime: 0 });
  const tracker = trackPlayback(media, 15, {});
  assert.equal(typeof tracker.stop, 'function', 'the stop handle is available before the entry fetch settles');
  media.dispatch('playing'); // fires while getProgress is still pending
  resolveFetch({ status: 500, headers: { get: () => null }, text: async () => '' });
  await flush();
  const calls = stubFetch();
  media.currentTime = 10;
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(calls.length, 1, 'the interval kept running across the pending fetch, not just after the next play');
  await tracker.stop();
});

test('stop() is safe while the entry fetch is pending; a late resolution never seeks', async () => {
  stubDocWin();
  /** @type {(v: unknown) => void} */
  let resolveFetch = () => {};
  globalThis.fetch = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (() => new Promise((resolve) => { resolveFetch = resolve; }))
  );
  const media = createMedia({ readyState: 1, duration: 1000, currentTime: 0 });
  const tracker = trackPlayback(media, 16, {});
  await tracker.stop();
  resolveFetch({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(makeEntry(16, 500, 1000, 'in_progress')) });
  await flush();
  assert.equal(media.currentTime, 0, 'a late-resolving entry never seeks a stopped tracker');
});

test('a seek interrupted by emptied is repeated on the next loadedmetadata; onResume still fires once', async () => {
  stubDocWin();
  stubFetch();
  const media = createMedia({ readyState: 0 });
  let resumeCalls = 0;
  const entry = makeEntry(20, 150, 1000, 'in_progress');
  const tracker = trackPlayback(media, 20, { entry, onResume: () => { resumeCalls += 1; } });
  media.duration = 1000;
  media.dispatch('loadedmetadata');
  assert.equal(media.currentTime, 150, 'seek issued on the first metadata');
  media.dispatch('emptied'); // the seek above never landed
  media.currentTime = 0;
  media.dispatch('loadedmetadata'); // reloaded; the seek is repeated
  assert.equal(media.currentTime, 150, 'seek re-issued after emptied');
  media.dispatch('seeked');
  assert.equal(resumeCalls, 1);
  media.dispatch('seeked');
  assert.equal(resumeCalls, 1, 'onResume fires at most once even with a second seeked');
  await tracker.stop();
});

test('visibilitychange does not report while the tab stays visible', async () => {
  const doc = stubDocWin();
  const calls = stubFetch();
  const media = createMedia({ readyState: 1, duration: 1000, currentTime: 0 });
  const tracker = trackPlayback(media, 21, { entry: makeEntry(21, 0, 1000, 'none') });
  media.currentTime = 5;
  doc.visibilityState = 'visible';
  await fireOn(doc, 'visibilitychange');
  assert.equal(calls.length, 0, 'no report while still visible');
  await tracker.stop();
});
