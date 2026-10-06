// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { getConversion } from '../../src/db/conversions.js';
import { createConversionQueue } from '../../src/convert/queue.js';
import {
  makeDb, makeTempDir, fakeConfig, fakeLogger, enqueueSource, deferredRun, successResult, waitUntil,
} from '../helpers/conversion-queue-fixtures.js';

const A = 'Hoerbuecher/a.mp3';
const B = 'Hoerbuecher/b.mp3';

/** A settled result for a run that was killed from outside. @param {string | null} killedBy */
const killedResult = (killedBy) => ({
  spawnError: null, exitCode: null, signal: 'SIGKILL', killedBy, records: [],
  stdoutInvalid: false, stdioTimedOut: false, stderrTail: '',
});

/** @param {import('node:test').TestContext} t @param {{ killGraceMs?: number, run?: any }} [opts] */
async function setup(t, { killGraceMs = 30, run } = {}) {
  const db = makeDb();
  t.after(() => db.close());
  const convertDirReal = await makeTempDir(t, 'vt-queue-convert-');
  const mediaRoot = await makeTempDir(t, 'vt-queue-media-');
  await enqueueSource(db, mediaRoot, A, { queuedAt: 1 });
  await enqueueSource(db, mediaRoot, B, { queuedAt: 2 });
  const deferred = deferredRun();
  const { log } = fakeLogger();
  const queue = createConversionQueue({
    db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run: run ?? deferred.run, killGraceMs,
  });
  assert.equal(await queue.start(), true);
  return { db, queue, deferred };
}

test('cancel of a queued row ends it failed/cancelled and it is never claimed; unknown rows are not cancellable', async (t) => {
  const { db, queue, deferred } = await setup(t);
  assert.equal(queue.cancel(B), 'cancelled');
  assert.equal(getConversion(db, B)?.status, 'failed');
  assert.equal(getConversion(db, B)?.error, 'cancelled');
  assert.equal(queue.cancel(B), 'not_cancellable', 'already failed');
  assert.equal(queue.cancel('nope.mp3'), 'not_cancellable', 'no row');
  queue.kick();
  const entry = await deferred.next();
  entry.resolve(await successResult(entry.args));
  await waitUntil(() => getConversion(db, A)?.status === 'playable');
  assert.equal(deferred.calls.length, 1, 'only A was ever run');
  assert.equal(queue.cancel(A), 'not_cancellable', 'playable');
});

test('cancel of the running job: SIGTERM at once, SIGKILL after killGraceMs, ends failed/cancelled, job dir removed; second cancel is idempotent', async (t) => {
  const { db, queue, deferred } = await setup(t);
  queue.kick();
  const entry = await deferred.next();
  assert.equal(queue.cancellingRelPath(), null);

  assert.equal(queue.cancel(A), 'cancelling');
  assert.equal(queue.cancellingRelPath(), A);
  assert.deepEqual(entry.killCalls, ['SIGTERM']);
  assert.equal(queue.cancel(A), 'cancelling');
  assert.deepEqual(entry.killCalls, ['SIGTERM'], 'a second cancel re-arms nothing');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(entry.killCalls, ['SIGTERM', 'SIGKILL']);

  entry.resolve(killedResult('stop'));
  await waitUntil(() => getConversion(db, A)?.status === 'failed');
  assert.equal(getConversion(db, A)?.error, 'cancelled');
  await waitUntil(() => deferred.calls.length === 2); // the queue chained on to B
  await assert.rejects(fs.access(entry.args.cwd), 'job dir removed');
  assert.equal(queue.cancellingRelPath(), null);
});

test('cancel between claim and spawn ends cancelled without spawning', async (t) => {
  const run = () => assert.fail('run must not be called');
  const { db, queue } = await setup(t, { run });
  queue.kick(); // synchronous claim; the job suspends before any handle exists
  assert.equal(queue.cancel(A), 'cancelling');
  assert.equal(queue.cancellingRelPath(), A);
  await waitUntil(() => getConversion(db, A)?.status === 'failed');
  assert.equal(getConversion(db, A)?.error, 'cancelled');
});

test('cancel + stop(): cancelled wins, one SIGTERM and one timer (a single SIGKILL), stop() resolves', async (t) => {
  const { db, queue, deferred } = await setup(t);
  queue.kick();
  const entry = await deferred.next();
  assert.equal(queue.cancel(A), 'cancelling');
  const stopPromise = queue.stop();
  assert.deepEqual(entry.killCalls, ['SIGTERM'], 'stop() reuses the armed escalation');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(entry.killCalls, ['SIGTERM', 'SIGKILL'], 'exactly one SIGKILL');
  entry.resolve(killedResult(null));
  await stopPromise;
  assert.equal(getConversion(db, A)?.error, 'cancelled');
  assert.equal(getConversion(db, B)?.status, 'queued');
});

test('the shared timer is cleared when the run settles before killGraceMs', async (t) => {
  const { queue, deferred } = await setup(t);
  queue.kick();
  const entry = await deferred.next();
  queue.cancel(A);
  entry.resolve(await successResult(entry.args));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(entry.killCalls.filter((/** @type {string} */ s) => s === 'SIGKILL'), [], 'no SIGKILL after the run settled');
});

test('stop() after cancel and cancel after stop() send no second SIGTERM/SIGKILL once SIGKILL fired', async (t) => {
  const { queue, deferred } = await setup(t, { killGraceMs: 10 });
  queue.kick();
  const entry = await deferred.next();
  queue.cancel(A);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(entry.killCalls, ['SIGTERM', 'SIGKILL']);
  const stopPromise = queue.stop();
  assert.equal(queue.cancel(A), 'cancelling');
  assert.deepEqual(entry.killCalls, ['SIGTERM', 'SIGKILL'], 'nothing more sent in the close-grace window');
  entry.resolve(killedResult(null));
  await stopPromise;
});

test('cancel after stop() sends no extra signal and a queued row still ends cancelled', async (t) => {
  const { db, queue, deferred } = await setup(t, { killGraceMs: 10 });
  queue.kick();
  const entry = await deferred.next();
  const stopPromise = queue.stop();
  assert.deepEqual(entry.killCalls, ['SIGTERM']);
  assert.equal(queue.cancel(A), 'cancelling');
  assert.equal(queue.cancel(B), 'cancelled');
  assert.equal(getConversion(db, B)?.error, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(entry.killCalls, ['SIGTERM', 'SIGKILL'], 'one escalation only');
  entry.resolve(killedResult(null));
  await stopPromise;
});

test('cancel while the running row is already playable (job cleaning up) is not_cancellable', async (t) => {
  const { db, queue, deferred } = await setup(t);
  queue.kick();
  const entry = await deferred.next();
  db.prepare("UPDATE conversions SET status = 'playable' WHERE rel_path = ?").run(A);
  assert.equal(queue.cancel(A), 'not_cancellable');
  assert.equal(getConversion(db, A)?.status, 'playable');
  assert.deepEqual(entry.killCalls, []);
  assert.equal(queue.cancellingRelPath(), null);
  entry.resolve(killedResult(null));
});
