import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getProgress, saveProgress, removeProgress, listProgress, trackPlayback, formatClock, formatRemaining } from '../../public/js/lib/progress.js';

/** @typedef {import('../../public/js/lib/progress.js').ProgressEntry} ProgressEntry */

/** @type {{ fetch?: unknown, document?: unknown, window?: unknown, location?: unknown }} */
let saved;

beforeEach(() => {
  const g = /** @type {{ document?: unknown, window?: unknown, location?: unknown }} */ (globalThis);
  saved = { fetch: globalThis.fetch, document: g.document, window: g.window, location: g.location };
});

afterEach(() => {
  globalThis.fetch = /** @type {typeof fetch} */ (saved.fetch);
  const g = /** @type {{ document?: unknown, window?: unknown, location?: unknown }} */ (globalThis);
  Object.assign(g, { document: saved.document, window: saved.window, location: saved.location });
});

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
    listenerCount(/** @type {string} */ type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

/** @param {{ readyState?: number, duration?: number, currentTime?: number }} [opts] */
function createMedia({ readyState = 0, duration = NaN, currentTime = 0 } = {}) {
  return { ...createTarget(), readyState, duration, currentTime };
}

/** Installs a stubbed `document`/`window` pair and returns them. */
function stubDocWin() {
  const doc = { ...createTarget(), visibilityState: 'visible' };
  const win = createTarget();
  /** @type {{ document?: unknown }} */ (globalThis).document = doc;
  /** @type {{ window?: unknown }} */ (globalThis).window = win;
  return { doc, win };
}

/**
 * Installs a stub `fetch`: the collection route answers `{ items: [] }`, a
 * `PUT` echoes its body back as the entry, `fail` makes every call a 500.
 * @param {{ fail?: boolean }} [opts]
 * @returns {{ url: string, init: RequestInit }[]}
 */
function stubFetch({ fail = false } = {}) {
  const calls = /** @type {{ url: string, init: RequestInit }[]} */ ([]);
  globalThis.fetch = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      /** @param {unknown} input @param {unknown} init */
      async (input, init) => {
        const requestInit = /** @type {RequestInit} */ (init ?? {});
        const url = String(input);
        calls.push({ url, init: requestInit });
        if (fail) return { status: 500, headers: { get: () => null }, text: async () => JSON.stringify({ error: 'boom' }) };
        if (url === '/api/progress' || url.startsWith('/api/progress?')) {
          return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ items: [] }) };
        }
        const body = requestInit.body ? JSON.parse(String(requestInit.body)) : {};
        const entry = makeEntry(1, body.position ?? 0, body.duration ?? null, 'in_progress');
        return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(entry) };
      }
    )
  );
  return calls;
}

/** Flushes pending microtasks (report promises) without touching mocked timers. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Dispatches an event on `target` and flushes the report promise it may trigger.
 * @param {{ dispatch: (type: string) => void }} target @param {string} type */
async function fireOn(target, type) {
  target.dispatch(type);
  await flush();
}

test('getProgress GETs and removeProgress DELETEs /api/progress/:id', async () => {
  const calls = stubFetch();
  const entry = await getProgress(42);
  await removeProgress(9);
  assert.equal(calls[0].url, '/api/progress/42');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(entry.itemId, 1);
  assert.equal(calls[1].url, '/api/progress/9');
  assert.equal(calls[1].init.method, 'DELETE');
});

test('saveProgress PUTs a keepalive JSON body and never redirects on a 401', async () => {
  const calls = stubFetch();
  await saveProgress(7, { position: 12, duration: 100 });
  assert.equal(calls[0].url, '/api/progress/7');
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.keepalive, true);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { position: 12, duration: 100 });

  globalThis.fetch = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (async () => ({ status: 401, headers: { get: () => null }, text: async () => JSON.stringify({ error: 'unauthorized' }) }))
  );
  const assigned = /** @type {string[]} */ ([]);
  /** @type {{ location?: unknown }} */ (globalThis).location = { pathname: '/', search: '', assign: (/** @type {string} */ u) => assigned.push(u) };
  await assert.rejects(() => saveProgress(1, { position: 1, duration: 10 }));
  assert.deepEqual(assigned, []);
});

test('listProgress joins an array category, appends view/limit, and needs no params', async () => {
  const calls = stubFetch();
  const items = await listProgress({ category: ['movies', 'series'], view: 'continue', limit: 5 });
  await listProgress({ category: 'music,audiobooks' });
  await listProgress();
  assert.equal(calls[0].url, '/api/progress?category=movies%2Cseries&view=continue&limit=5');
  assert.deepEqual(items, []);
  assert.equal(calls[1].url, '/api/progress?category=music%2Caudiobooks');
  assert.equal(calls[2].url, '/api/progress');
});

test('formatClock formats M:SS under an hour and H:MM:SS from an hour on', () => {
  assert.equal(formatClock(5), '0:05');
  assert.equal(formatClock(754), '12:34');
  assert.equal(formatClock(3723), '1:02:03');
  assert.equal(formatClock(7200), '2:00:00');
});

test('formatRemaining rounds minutes up (min 1) and combines hours, omitting a zero minute part', () => {
  assert.equal(formatRemaining(1), 'Noch 1 Min.');
  assert.equal(formatRemaining(1439), 'Noch 24 Min.');
  assert.equal(formatRemaining(6720), 'Noch 1 Std. 52 Min.');
  assert.equal(formatRemaining(7200), 'Noch 2 Std.');
});

test('resumes by seeking on metadata, calls onResume once on seeked, then reports', async () => {
  stubDocWin();
  const calls = stubFetch();
  const media = createMedia({ readyState: 0 });
  let resumedAt = -1;
  const entry = makeEntry(5, 120, 1000, 'in_progress');
  const tracker = await trackPlayback(media, 5, { entry, onResume: (p) => { resumedAt = p; } });
  await fireOn(media, 'pause');
  assert.equal(calls.length, 0, 'no report before metadata');
  media.duration = 1000;
  media.dispatch('loadedmetadata');
  assert.equal(media.currentTime, 120);
  await fireOn(media, 'pause');
  assert.equal(calls.length, 0, 'no report before the seek lands');
  media.dispatch('seeked');
  assert.equal(resumedAt, 120);
  media.currentTime = 130;
  await fireOn(media, 'pause');
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { position: 130, duration: 1000 });
  await tracker.stop();
});

test('arms reporting on the first playing when seeked never arrives; a later seeked still resumes once', async () => {
  stubDocWin();
  const calls = stubFetch();
  const media = createMedia({ readyState: 1, duration: 1000, currentTime: 0 });
  let resumeCalls = 0;
  const entry = makeEntry(6, 200, 1000, 'in_progress');
  const tracker = await trackPlayback(media, 6, { entry, onResume: () => { resumeCalls += 1; } });
  assert.equal(media.currentTime, 200);
  media.dispatch('playing');
  assert.equal(resumeCalls, 0);
  media.currentTime = 210;
  await fireOn(media, 'pause');
  assert.equal(calls.length, 1, 'armed via the playing fallback');
  media.dispatch('seeked');
  assert.equal(resumeCalls, 1);
  media.dispatch('seeked');
  assert.equal(resumeCalls, 1, 'onResume fires at most once');
  await tracker.stop();
});

test('never seeks when resume is false or the stored position is at or past the duration', async () => {
  stubDocWin();
  const calls = stubFetch();
  const noResume = createMedia({ readyState: 1, duration: 1000, currentTime: 0 });
  let resumeCalled = false;
  const t1 = await trackPlayback(noResume, 7, {
    entry: makeEntry(7, 300, 1000, 'in_progress'),
    resume: false,
    onResume: () => { resumeCalled = true; },
  });
  assert.equal(noResume.currentTime, 0);
  assert.equal(resumeCalled, false);
  await t1.stop();

  const atEnd = createMedia({ readyState: 1, duration: 100, currentTime: 0 });
  const t2 = await trackPlayback(atEnd, 8, { entry: makeEntry(8, 100, 100, 'in_progress') });
  assert.equal(atEnd.currentTime, 0);
  atEnd.currentTime = 5;
  await fireOn(atEnd, 'pause');
  assert.equal(calls.length, 1, 'armed directly since there is nothing to resume');
  await t2.stop();
});

test('reports every 10 s while playing and skips moves under 1 s', async (t) => {
  stubDocWin();
  const calls = stubFetch();
  t.mock.timers.enable({ apis: ['setInterval'] });
  const media = createMedia({ readyState: 1, duration: 1000, currentTime: 0 });
  const tracker = await trackPlayback(media, 9, { entry: makeEntry(9, 0, 1000, 'none') });
  media.dispatch('playing');
  media.currentTime = 0.4;
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(calls.length, 0, 'sub-second move skipped');
  media.currentTime = 10;
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(calls.length, 1);
  await tracker.stop();
});

test('reports immediately on pause, ended, tab hide and pagehide', async () => {
  const { doc, win } = stubDocWin();
  const calls = stubFetch();
  const media = createMedia({ readyState: 1, duration: 1000, currentTime: 0 });
  const tracker = await trackPlayback(media, 10, { entry: makeEntry(10, 0, 1000, 'none') });
  media.currentTime = 5;
  await fireOn(media, 'pause');
  media.currentTime = 15;
  await fireOn(media, 'ended');
  media.currentTime = 25;
  doc.visibilityState = 'hidden';
  await fireOn(doc, 'visibilitychange');
  media.currentTime = 35;
  await fireOn(win, 'pagehide');
  assert.equal(calls.length, 4);
  await tracker.stop();
});

test('emptied disarms until playing; a failed report retries; stop flushes and detaches', async (t) => {
  stubDocWin();
  const calls = stubFetch();
  const media = createMedia({ readyState: 1, duration: 1000, currentTime: 0 });
  const tracker = await trackPlayback(media, 11, { entry: makeEntry(11, 0, 1000, 'none') });
  media.dispatch('emptied');
  media.currentTime = 20;
  await fireOn(media, 'pause');
  assert.equal(calls.length, 0, 'disarmed after emptied');
  media.dispatch('playing');
  media.currentTime = 30;
  await fireOn(media, 'pause');
  assert.equal(calls.length, 1, 're-armed on the next playing');
  const warn = t.mock.method(console, 'warn', () => {});
  stubFetch({ fail: true });
  media.currentTime = 40;
  await fireOn(media, 'pause');
  await fireOn(media, 'pause'); // same position: retried, not skipped, since the failed report never advanced lastSent
  assert.equal(warn.mock.callCount(), 2);
  const calls2 = stubFetch();
  media.currentTime = 50;
  await tracker.stop();
  assert.equal(calls2.length, 1);
  assert.equal(media.listenerCount('pause'), 0);
  await fireOn(media, 'pause');
  assert.equal(calls2.length, 1, 'detached: no report after stop');
});

test('fetches the entry via getProgress when omitted; a failed fetch counts as state none', async () => {
  stubDocWin();
  globalThis.fetch = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (async () => ({ status: 500, headers: { get: () => null }, text: async () => '' }))
  );
  const media = createMedia({ readyState: 1, duration: 1000, currentTime: 0 });
  const tracker = await trackPlayback(media, 14, {});
  assert.equal(media.currentTime, 0, 'no resume attempted for a failed fetch');
  const calls = stubFetch();
  media.currentTime = 20;
  await fireOn(media, 'pause');
  assert.equal(calls.length, 1);
  await tracker.stop();
});
