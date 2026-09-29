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

/** A minimal, unsettled RunResult shape for a foreign-signal / no-op `stop()` test. @param {Partial<any>} [extra] */
const unsettledResult = (extra = {}) => ({
  spawnError: null, exitCode: null, signal: 'SIGTERM', killedBy: null, records: [],
  stdoutInvalid: false, stdioTimedOut: false, stderrTail: '', ...extra,
});

test("stop() prevents new claims and waits for the in-flight job's DB write and cleanup before resolving", async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const convertDirReal = await makeTempDir(t, 'vt-queue-convert-');
  const mediaRoot = await makeTempDir(t, 'vt-queue-media-');
  await enqueueSource(db, mediaRoot, 'Hoerbuecher/a.mp3', { queuedAt: 1 });
  await enqueueSource(db, mediaRoot, 'Hoerbuecher/b.mp3', { queuedAt: 2 });

  const { run, calls, next } = deferredRun();
  const { log } = fakeLogger();
  const queue = createConversionQueue({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run });
  assert.equal(await queue.start(), true);
  queue.kick();
  const entry = await next();

  const stopPromise = queue.stop();
  assert.deepEqual(entry.killCalls, ['SIGTERM'], 'the running job is killed at once');
  entry.resolve(await successResult(entry.args));
  await stopPromise;

  const row = getConversion(db, 'Hoerbuecher/a.mp3');
  assert.equal(row?.status, 'failed');
  assert.equal(row?.error, 'interrupted', 'stop() was already pending, so the job records its own interruption, not the result it settled with');
  assert.equal(getConversion(db, 'Hoerbuecher/b.mp3')?.status, 'queued', 'the second row was never claimed');
  assert.equal(calls.length, 1);
});

test('stop() called before a handle exists (steps 1-3) interrupts without spawning and resolves promptly', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const convertDirReal = await makeTempDir(t, 'vt-queue-convert-');
  const mediaRoot = await makeTempDir(t, 'vt-queue-media-');
  await enqueueSource(db, mediaRoot, 'Hoerbuecher/a.mp3');

  const calls = /** @type {any[]} */ ([]);
  const run = (/** @type {any} */ args) => { calls.push(args); assert.fail('run must not be called'); };
  const { log } = fakeLogger();
  const queue = createConversionQueue({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run });
  assert.equal(await queue.start(), true);

  const startedAt = Date.now();
  queue.kick(); // synchronous claim; the job suspends at its first real await, before any handle exists
  await queue.stop();
  assert.ok(Date.now() - startedAt < 500, 'stop() resolved promptly, not after a real conversion');
  assert.equal(calls.length, 0);
  assert.equal(getConversion(db, 'Hoerbuecher/a.mp3')?.error, 'interrupted');
});

test('stop() sends SIGTERM at once and escalates to SIGKILL after killGraceMs; a foreign-signal end after stop() also records interrupted', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const convertDirReal = await makeTempDir(t, 'vt-queue-convert-');
  const mediaRoot = await makeTempDir(t, 'vt-queue-media-');
  await enqueueSource(db, mediaRoot, 'Hoerbuecher/a.mp3');

  const { run, next } = deferredRun();
  const { log } = fakeLogger();
  const queue = createConversionQueue({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, killGraceMs: 30 });
  assert.equal(await queue.start(), true);
  queue.kick();
  const entry = await next();

  const stopPromise = queue.stop();
  assert.deepEqual(entry.killCalls, ['SIGTERM'], 'SIGTERM is sent at once');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(entry.killCalls, ['SIGTERM'], 'no SIGKILL before killGraceMs has elapsed');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(entry.killCalls, ['SIGTERM', 'SIGKILL'], 'SIGKILL is sent once killGraceMs elapses with result still pending');

  entry.resolve(unsettledResult()); // a foreign signal, not the queue's own kill (killedBy: null)
  await stopPromise;
  assert.equal(getConversion(db, 'Hoerbuecher/a.mp3')?.error, 'interrupted', 'ended by a foreign signal after stop(), never interpreted');
});

test('the SIGKILL timer is cleared once result settles, even before killGraceMs elapses', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const convertDirReal = await makeTempDir(t, 'vt-queue-convert-');
  const mediaRoot = await makeTempDir(t, 'vt-queue-media-');
  await enqueueSource(db, mediaRoot, 'Hoerbuecher/a.mp3');

  const { run, next } = deferredRun();
  const { log } = fakeLogger();
  const queue = createConversionQueue({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, killGraceMs: 30 });
  assert.equal(await queue.start(), true);
  queue.kick();
  const entry = await next();

  const stopPromise = queue.stop();
  entry.resolve(unsettledResult({ killedBy: 'stop' }));
  await stopPromise;
  await new Promise((resolve) => setTimeout(resolve, 40)); // well past killGraceMs
  assert.deepEqual(entry.killCalls, ['SIGTERM'], 'no SIGKILL was ever sent once result had already settled');
});

test('a run whose result never settles resolves stop() after stopDeadlineMs, logs conversion_stop_timeout, and leaves the row converting; stop() is memoised', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const convertDirReal = await makeTempDir(t, 'vt-queue-convert-');
  const mediaRoot = await makeTempDir(t, 'vt-queue-media-');
  await enqueueSource(db, mediaRoot, 'Hoerbuecher/a.mp3');

  const { run, next } = deferredRun(); // kill() records only; the returned entry is never resolved
  const { log, calls: logCalls } = fakeLogger();
  const queue = createConversionQueue({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, killGraceMs: 10, stopDeadlineMs: 30 });
  assert.equal(await queue.start(), true);
  queue.kick();
  await next();

  const stopPromise1 = queue.stop();
  const stopPromise2 = queue.stop();
  assert.equal(stopPromise1, stopPromise2, 'stop() is memoised: a second call returns the same promise');
  await stopPromise1; // must not reject

  assert.ok(logCalls.some((c) => c.event === 'conversion_stop_timeout'));
  assert.equal(getConversion(db, 'Hoerbuecher/a.mp3')?.status, 'converting');
});

test("stop() resolves only after the job's step-7 work-dir removal has finished, not merely its DB write", async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const convertDirReal = await makeTempDir(t, 'vt-queue-convert-');
  const mediaRoot = await makeTempDir(t, 'vt-queue-media-');
  await enqueueSource(db, mediaRoot, 'Hoerbuecher/a.mp3');

  /** @type {{ target: string, release: () => void }[]} */
  const removals = [];
  const removeDir = (/** @type {string} */ target) => {
    if (path.basename(target) === '.videothek-work') return fs.rm(target, { recursive: true, force: true });
    return new Promise((resolve, reject) => {
      removals.push({ target, release: () => { fs.rm(target, { recursive: true, force: true }).then(resolve, reject); } });
    });
  };
  const { run, next } = deferredRun();
  const { log } = fakeLogger();
  const queue = createConversionQueue({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, removeDir });
  assert.equal(await queue.start(), true);
  queue.kick();
  const entry = await next();

  let stopped = false;
  const stopPromise = queue.stop().then(() => { stopped = true; });
  entry.resolve(await successResult(entry.args));
  await waitUntil(() => removals.length === 1);
  assert.equal(getConversion(db, 'Hoerbuecher/a.mp3')?.error, 'interrupted', 'the DB write already happened');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(stopped, false, 'stop() still waits for the pending work-dir removal');

  const jobDir = removals[0].target;
  assert.equal(jobDir, entry.args.cwd, 'step 7 removes the job dir');
  removals[0].release();
  await stopPromise;
  await assert.rejects(fs.access(jobDir), 'the job dir is gone once stop() resolved');
});

test('a handle whose kill() throws still lets stop() return its promise, resolve, and record interrupted', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const convertDirReal = await makeTempDir(t, 'vt-queue-convert-');
  const mediaRoot = await makeTempDir(t, 'vt-queue-media-');
  await enqueueSource(db, mediaRoot, 'Hoerbuecher/a.mp3');

  /** @type {(value: any) => void} */
  let settle = () => {};
  let ran = false;
  const run = () => {
    ran = true;
    return { result: new Promise((resolve) => { settle = resolve; }), kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } };
  };
  const { log, calls: logCalls } = fakeLogger();
  const queue = createConversionQueue({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, killGraceMs: 10_000 });
  assert.equal(await queue.start(), true);
  queue.kick();
  await waitUntil(() => ran);

  /** @type {Promise<void> | undefined} */
  let stopPromise;
  assert.doesNotThrow(() => { stopPromise = queue.stop(); });
  assert.ok(stopPromise instanceof Promise);
  settle(unsettledResult());
  await stopPromise;
  assert.deepEqual(logCalls.find((c) => c.event === 'conversion_error')?.fields, { code: 'ESRCH' });
  assert.equal(getConversion(db, 'Hoerbuecher/a.mp3')?.error, 'interrupted');
});
