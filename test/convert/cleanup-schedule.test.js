// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConversion } from '../../src/db/conversions.js';
import { createConversionQueue } from '../../src/convert/queue.js';
import {
  makeDb, makeTempDir, fakeConfig, fakeLogger, enqueueSource, deferredRun, successResult, waitUntil,
} from '../helpers/conversion-queue-fixtures.js';
import { writeCopy, exists } from '../helpers/cleanup-fixtures.js';

const ORPHAN = 'f'.repeat(64);
const ORPHAN2 = '9'.repeat(64);

/**
 * A queue over real temp dirs whose `removeDir` can hold orphan removals
 * until released, and records which paths it saw.
 * @param {import('node:test').TestContext} t
 * @param {{ hold?: boolean, stopDeadlineMs?: number }} [options]
 */
async function fixture(t, { hold = false, stopDeadlineMs } = {}) {
  const db = makeDb();
  t.after(() => { if (db.isOpen) db.close(); });
  const convertDirReal = await makeTempDir(t, 'vt-sched-convert-');
  const mediaRoot = await makeTempDir(t, 'vt-sched-media-');
  const { log, calls } = fakeLogger();
  /** @type {string[]} */
  const orphanRemovals = [];
  /** @type {(() => void) | null} */
  let release = null;
  const gate = new Promise((resolve) => { release = () => resolve(undefined); });
  const removeDir = async (/** @type {string} */ target) => {
    if (/^[0-9a-f]{64}$/.test(path.basename(target))) {
      orphanRemovals.push(path.basename(target));
      if (hold) await gate;
    }
    await fs.rm(target, { recursive: true, force: true });
  };
  const runner = deferredRun();
  const queue = createConversionQueue({
    db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run: runner.run, removeDir,
    ...(stopDeadlineMs === undefined ? {} : { stopDeadlineMs }),
  });
  return { db, convertDirReal, mediaRoot, calls, queue, runner, orphanRemovals, release: () => release?.() };
}

test('requestCleanup() before start() and after stop() does nothing', async (t) => {
  const f = await fixture(t);
  await writeCopy(f.convertDirReal, ORPHAN);
  f.queue.requestCleanup();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await exists(path.join(f.convertDirReal, ORPHAN)), true, 'not ready yet');
  assert.equal(await f.queue.start(), true);
  await f.queue.stop();
  f.queue.requestCleanup();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await exists(path.join(f.convertDirReal, ORPHAN)), true, 'stopped');
  assert.deepEqual(f.orphanRemovals, []);
});

test('requestCleanup() on an idle ready queue runs one pass and removes the orphan', async (t) => {
  const f = await fixture(t);
  await f.queue.start();
  await writeCopy(f.convertDirReal, ORPHAN);
  f.queue.requestCleanup();
  await waitUntil(() => f.orphanRemovals.length === 1);
  assert.equal(await exists(path.join(f.convertDirReal, ORPHAN)), false);
});

test('while a job runs the cleanup waits, runs after the job settles and before the next claim', async (t) => {
  const f = await fixture(t, { hold: true });
  await enqueueSource(f.db, f.mediaRoot, 'Hoerbuecher/a.mp3', { queuedAt: 1 });
  await enqueueSource(f.db, f.mediaRoot, 'Hoerbuecher/b.mp3', { queuedAt: 2 });
  await f.queue.start();
  await writeCopy(f.convertDirReal, ORPHAN);
  f.queue.kick();
  const entry = await f.runner.next();

  f.queue.requestCleanup();
  f.queue.requestCleanup(); // coalesced
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(f.orphanRemovals, [], 'never while a job runs');

  entry.resolve(await successResult(entry.args));
  await waitUntil(() => f.orphanRemovals.length === 1);
  assert.equal(getConversion(f.db, 'Hoerbuecher/a.mp3')?.status, 'playable');
  assert.equal(getConversion(f.db, 'Hoerbuecher/b.mp3')?.status, 'queued', 'the next claim waits for the cleanup');
  f.queue.kick();
  assert.equal(f.runner.calls.length, 1, 'kick() claims nothing during a cleanup');

  f.release();
  const second = await f.runner.next();
  assert.equal(getConversion(f.db, 'Hoerbuecher/b.mp3')?.status, 'converting');
  assert.equal(f.orphanRemovals.length, 1, 'the coalesced requests ran one pass');
  second.resolve(await successResult(second.args));
  await waitUntil(() => getConversion(f.db, 'Hoerbuecher/b.mp3')?.status === 'playable');
});

test('a request during a running cleanup is coalesced into exactly one follow-up pass', async (t) => {
  const f = await fixture(t, { hold: true });
  await f.queue.start();
  await writeCopy(f.convertDirReal, ORPHAN);
  f.queue.requestCleanup();
  await waitUntil(() => f.orphanRemovals.length === 1);
  f.queue.requestCleanup();
  f.queue.requestCleanup();
  await writeCopy(f.convertDirReal, ORPHAN2);
  f.release();
  await waitUntil(() => f.orphanRemovals.length === 2);
  assert.deepEqual(f.orphanRemovals.sort(), [ORPHAN2, ORPHAN].sort());
});

test('stop() waits for an in-flight cleanup and the pass removes nothing more afterwards', async (t) => {
  const f = await fixture(t, { hold: true, stopDeadlineMs: 5000 });
  await f.queue.start();
  await writeCopy(f.convertDirReal, ORPHAN);
  await writeCopy(f.convertDirReal, ORPHAN2);
  f.queue.requestCleanup();
  await waitUntil(() => f.orphanRemovals.length === 1);

  let stopped = false;
  const stopPromise = f.queue.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stopped, false, 'stop() waits for the running cleanup');
  f.release();
  await stopPromise;
  assert.equal(f.orphanRemovals.length, 1, 'the second directory is not removed once stopping');
});

test('stop() gives up on a hung cleanup after stopDeadlineMs', async (t) => {
  const f = await fixture(t, { hold: true, stopDeadlineMs: 80 });
  await f.queue.start();
  await writeCopy(f.convertDirReal, ORPHAN);
  f.queue.requestCleanup();
  await waitUntil(() => f.orphanRemovals.length === 1);
  const startedAt = Date.now();
  await f.queue.stop();
  assert.ok(Date.now() - startedAt < 2000);
  assert.ok(f.calls.some((c) => c.event === 'conversion_stop_timeout'));
  f.release();
});
