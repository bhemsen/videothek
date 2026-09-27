// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startLibrary } from '../../src/library/index.js';
import { createMediaTree, removeMediaTree, writeMediaFile } from '../helpers/media-tree.js';
import { NOW, fakeLog, loadRow, testDb } from '../helpers/scanner-fixtures.js';

/**
 * Replaces `fs.watch` for one test with a watcher that opens no OS handle
 * and never emits anything. `createWatcher` reads `fs.watch` when
 * `startLibrary` builds it, so this reaches the real, un-injected wiring.
 * @param {import('node:test').TestContext} t
 * @returns {{ callCount(): number }}
 */
function mockSilentFsWatch(t) {
  const fake = {
    close() {},
    on() {
      return fake;
    },
  };
  const spy = t.mock.method(fs, 'watch', () => fake);
  return { callCount: () => spy.mock.callCount() };
}

/**
 * `startLibrary`'s own service-level contract: synchronous, non-blocking
 * construction, the deferred `'initial'` scan, the periodic rescan timer,
 * and a `stop()` that leaves no timer or watch behind. The scanner/watcher
 * integration itself (real change detection reaching the DB) is
 * `freshness.test.js`'s job; this file only exercises the wiring
 * `startLibrary` itself owns. Spec: spec-library-video.md, "Service
 * (`src/library/index.js`) and wiring".
 */

/**
 * A minimal but fully-shaped fake `Config` — only `mediaRoot` and
 * `rescanIntervalMin` are ever read by `startLibrary`.
 * @param {string} mediaRoot
 * @param {number} [rescanIntervalMin]
 * @returns {import('../../src/config.js').Config}
 */
function fakeConfig(mediaRoot, rescanIntervalMin = 15) {
  return Object.freeze({
    mediaRoot,
    dataDir: '',
    host: '0.0.0.0',
    port: 0,
    rescanIntervalMin,
    adminUser: null,
    adminPassword: null,
  });
}

/** @param {() => boolean} predicate @param {number} [timeoutMs] @returns {Promise<void>} */
async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out waiting for the condition');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('startLibrary returns synchronously, before any scan I/O has happened', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const db = testDb();
  const { log, calls } = fakeLog();

  const service = startLibrary({ db, config: fakeConfig(root), log, now: NOW });
  t.after(() => service.stop());

  assert.equal(typeof service.requestFull, 'function');
  assert.equal(typeof service.onScanComplete, 'function');
  assert.equal(typeof service.status, 'function');
  assert.equal(service.status().running, false, 'no scan has started synchronously');
  assert.equal(calls.info.length, 0, 'nothing was scanned yet — the initial scan is deferred');
});

test('the deferred first scan runs with kind "initial"', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/Arrival (2016).webm');
  const db = testDb();
  const { log } = fakeLog();

  const service = startLibrary({ db, config: fakeConfig(root), log, now: NOW });
  t.after(() => service.stop());

  const payload = await new Promise((resolve) => {
    const unsubscribe = service.onScanComplete((p) => {
      unsubscribe();
      resolve(p);
    });
  });

  assert.equal(payload.kind, 'initial');
  assert.equal(payload.stats.added, 1);
});

test("the periodic rescan timer requests a plain 'full' scan every rescanIntervalMin minutes", async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const db = testDb();
  const { log } = fakeLog();

  /** @type {string[]} */
  const kinds = [];
  const service = startLibrary({ db, config: fakeConfig(root, 15), log, now: NOW });
  t.after(() => service.stop());
  service.onScanComplete((p) => {
    kinds.push(p.kind);
  });

  await waitFor(() => kinds.includes('initial'));
  t.mock.timers.tick(15 * 60_000);
  await waitFor(() => kinds.includes('full'));

  assert.deepEqual(kinds, ['initial', 'full']);
});

test('stop() called before the deferred boot fires cancels it: no scan ever starts, no watch is ever opened', async (t) => {
  // Regression: a server that starts and is asked to stop again right away
  // (e.g. a test harness) used to still run the deferred setImmediate boot
  // afterwards, starting the watcher — a real, persistent handle — after
  // the service was already told to stop, leaking it forever.
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/Arrival (2016).webm');
  const db = testDb();
  const { log, calls } = fakeLog();
  // The scan-side assertions below hold even without the guard (a stopped
  // scanner ignores requestFull), so the watch spy is what actually proves
  // the deferred boot never ran: without the guard, watcher.start() opens a
  // watch on macOS/Windows (recursive mode) after stop() already resolved.
  const watch = mockSilentFsWatch(t);

  const service = startLibrary({ db, config: fakeConfig(root), log, now: NOW });
  await service.stop();

  // Give the deferred `setImmediate` every chance to run (it would have,
  // absent the guard) before asserting nothing happened.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(watch.callCount(), 0, 'no watch may be opened after stop()');
  assert.equal(service.status().running, false);
  assert.equal(calls.info.length, 0, 'no scan ever ran, so no library_scan_complete was logged');
});

test('with a silent watcher, the rescanIntervalMin timer alone indexes a file added after the initial scan', async (t) => {
  // Freshness backstop (spec "Outcome"): a watcher that never reports
  // anything must still let a new file appear, via startLibrary's own
  // periodic-rescan interval, not a hand-called requestFull().
  t.mock.timers.enable({ apis: ['setInterval'] });
  const watch = mockSilentFsWatch(t);
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/Existing (2010).webm');
  const db = testDb();
  const { log } = fakeLog();

  /** @type {string[]} */
  const kinds = [];
  const service = startLibrary({ db, config: fakeConfig(root, 15), log, now: NOW });
  t.after(() => service.stop());
  service.onScanComplete((p) => {
    kinds.push(p.kind);
  });

  await waitFor(() => kinds.includes('initial'));
  assert.ok(watch.callCount() > 0, 'the watcher is running — it just never reports anything');
  await writeMediaFile(root, 'Filme/Silent (2020).webm');
  assert.equal(loadRow(db, 'Filme/Silent (2020).webm'), undefined, 'nothing reported the new file yet');

  t.mock.timers.tick(15 * 60_000);
  await waitFor(() => kinds.includes('full'));

  assert.ok(loadRow(db, 'Filme/Silent (2020).webm'), 'the periodic rescan must index the file a silent watcher missed');
});

/** @returns {number} how many `fs.watch` handles this process currently has open */
function openWatchCount() {
  return process.getActiveResourcesInfo().filter((name) => name === 'FSEventWrap').length;
}

test('stop() clears the rescan timer, stops the watcher and resolves once the in-flight scan has exited', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const db = testDb();
  const { log } = fakeLog();
  // The rescan timer is unref'ed, so it would neither hang the runner nor
  // show up in getActiveResourcesInfo() if leaked — track it explicitly.
  /** @type {unknown[]} */
  const intervals = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  t.mock.method(globalThis, 'setInterval', /** @type {any} */ ((/** @type {any[]} */ ...args) => {
    const handle = Reflect.apply(realSetInterval, globalThis, args);
    intervals.push(handle);
    return handle;
  }));
  const clearSpy = t.mock.method(globalThis, 'clearInterval', /** @type {any} */ ((/** @type {any} */ handle) => realClearInterval(handle)));
  const watchesBefore = openWatchCount();

  const service = startLibrary({ db, config: fakeConfig(root), log, now: NOW });
  await new Promise((resolve) => {
    const unsubscribe = service.onScanComplete(() => {
      unsubscribe();
      resolve(undefined);
    });
  });
  assert.ok(openWatchCount() > watchesBefore, 'a real watch is open while the service runs');
  assert.ok(intervals.length >= 1, 'the rescan timer was scheduled');

  await service.stop();

  assert.equal(service.status().running, false);
  const cleared = clearSpy.mock.calls.map((/** @type {{ arguments: unknown[] }} */ call) => call.arguments[0]);
  assert.ok(intervals.every((handle) => cleared.includes(handle)), 'every interval startLibrary scheduled is cleared');
  await waitFor(() => openWatchCount() === watchesBefore); // handle close completes asynchronously
  // Idempotent-safe: nothing pending or in flight left for a second stop() to wait on.
  await service.stop();
});
