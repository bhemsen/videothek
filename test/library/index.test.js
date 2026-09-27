// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLibrary } from '../../src/library/index.js';
import { createMediaTree, removeMediaTree, writeMediaFile } from '../helpers/media-tree.js';
import { NOW, fakeLog, testDb } from '../helpers/scanner-fixtures.js';

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

  const service = startLibrary({ db, config: fakeConfig(root), log, now: NOW });
  await service.stop();

  // Give the deferred `setImmediate` every chance to run (it would have,
  // absent the guard) before asserting nothing happened.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(service.status().running, false);
  assert.equal(calls.info.length, 0, 'no scan ever ran, so no library_scan_complete was logged');
});

test('stop() clears the rescan timer, stops the watcher and resolves once the in-flight scan has exited', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const db = testDb();
  const { log } = fakeLog();

  const service = startLibrary({ db, config: fakeConfig(root), log, now: NOW });
  await new Promise((resolve) => {
    const unsubscribe = service.onScanComplete(() => {
      unsubscribe();
      resolve(undefined);
    });
  });

  await service.stop();

  assert.equal(service.status().running, false);
  // Idempotent-safe: nothing pending or in flight left for a second stop() to wait on.
  await service.stop();
});
