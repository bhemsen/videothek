// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { getConversion } from '../../src/db/conversions.js';
import { createConversionQueue } from '../../src/convert/queue.js';
import {
  makeDb, makeTempDir, fakeConfig, fakeLogger, enqueueSource, enqueueMissingSource, deferredRun, waitUntil, successResult,
} from '../helpers/conversion-queue-fixtures.js';

/**
 * Waits until `count` `conversion_finished` lines were logged - not merely
 * until the DB shows a terminal status, which a job's own `finally` cleanup
 * can still be running past (job.js step 7): closing the DB right after
 * that status appears would race the queue's still-pending re-kick chain.
 * @param {{ event: string }[]} logCalls
 * @param {number} count
 */
function waitForFinished(logCalls, count) {
  return waitUntil(() => logCalls.filter((c) => c.event === 'conversion_finished').length >= count);
}

test('claims one queued row at a time, FIFO by rel_path on a queued_at tie, with the right run() args', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const convertDirReal = await makeTempDir(t, 'vt-queue-convert-');
  const mediaRoot = await makeTempDir(t, 'vt-queue-media-');
  const relPaths = ['Hoerbuecher/c.mp3', 'Hoerbuecher/a.mp3', 'Hoerbuecher/b.mp3'];
  for (const relPath of relPaths) await enqueueSource(db, mediaRoot, relPath, { queuedAt: 100 });

  const { run, calls, next } = deferredRun();
  const { log, calls: logCalls } = fakeLogger();
  const queue = createConversionQueue({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 200, run });
  assert.equal(await queue.start(), true);
  queue.kick();

  /** @type {string[]} */
  const order = [];
  for (let i = 0; i < relPaths.length; i++) {
    const entry = await next();
    assert.equal(calls.length, i + 1, 'no second job was claimed while this one is still in flight');
    order.push(path.relative(mediaRoot, entry.args.source).split(path.sep).join('/'));
    if (i === 0) {
      assert.equal(entry.args.cwd, path.dirname(entry.args.outDir));
      assert.equal(entry.args.outDir, path.join(entry.args.cwd, 'out'));
      assert.equal(entry.args.env.TMPDIR, path.join(entry.args.cwd, 'tmp'));
      assert.equal(entry.args.env.TEMP, entry.args.env.TMPDIR);
      assert.equal(entry.args.env.TMP, entry.args.env.TMPDIR);
      assert.equal(entry.args.env.PATH, '/usr/bin', 'config.converterEnv is passed through');
    }
    entry.resolve(await successResult(entry.args));
  }
  assert.deepEqual(order, ['Hoerbuecher/a.mp3', 'Hoerbuecher/b.mp3', 'Hoerbuecher/c.mp3']);
  await waitForFinished(logCalls, relPaths.length);
  assert.ok(relPaths.every((p) => getConversion(db, p)?.status === 'playable'));
});

test('kick() is a no-op before start(), after start() until called, and while a job is in flight', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const convertDirReal = await makeTempDir(t, 'vt-queue-convert-');
  const mediaRoot = await makeTempDir(t, 'vt-queue-media-');
  await enqueueSource(db, mediaRoot, 'Hoerbuecher/a.mp3');

  const { run, calls, next } = deferredRun();
  const { log, calls: logCalls } = fakeLogger();
  const queue = createConversionQueue({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run });

  queue.kick();
  assert.equal(calls.length, 0, 'kick() before start() resolved claims nothing');

  assert.equal(await queue.start(), true);
  assert.equal(getConversion(db, 'Hoerbuecher/a.mp3')?.status, 'queued', 'start() alone never kicks');

  queue.kick();
  const entry = await next();
  queue.kick();
  queue.kick();
  assert.equal(calls.length, 1, 'kick() while a job runs claims nothing');

  entry.resolve(await successResult(entry.args));
  await waitForFinished(logCalls, 1);
  assert.equal(getConversion(db, 'Hoerbuecher/a.mp3')?.status, 'playable');
});

test('the chain continues past a thrown run() and a reported failure alike, never producing an unhandled rejection', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const convertDirReal = await makeTempDir(t, 'vt-queue-convert-');
  const mediaRoot = await makeTempDir(t, 'vt-queue-media-');
  const paths = ['Hoerbuecher/a.mp3', 'Hoerbuecher/b.mp3', 'Hoerbuecher/c.mp3'];
  for (const relPath of paths) await enqueueSource(db, mediaRoot, relPath, { queuedAt: 1 });

  let callNo = 0;
  const calls = /** @type {any[]} */ ([]);
  const run = (/** @type {any} */ args) => {
    calls.push(args);
    callNo += 1;
    if (callNo === 1) throw new Error('boom'); // unexpected throw -> internal
    if (callNo === 2) {
      return {
        result: Promise.resolve({
          spawnError: 'ENOENT', exitCode: null, signal: null, killedBy: null, records: [],
          stdoutInvalid: false, stdioTimedOut: false, stderrTail: '',
        }),
        kill: () => {},
      };
    }
    return { result: successResult(args), kill: () => {} };
  };
  const { log, calls: logCalls } = fakeLogger();
  const queue = createConversionQueue({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run });
  assert.equal(await queue.start(), true);
  queue.kick();

  await waitForFinished(logCalls, paths.length);
  assert.equal(getConversion(db, paths[0])?.error, 'internal');
  assert.equal(getConversion(db, paths[1])?.error, 'converter_unavailable');
  assert.equal(getConversion(db, paths[2])?.status, 'playable');
  assert.equal(calls.length, 3);
});

test('a queued row absent from library_items is claimed and ends source_missing without calling run, and the next one still runs', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const convertDirReal = await makeTempDir(t, 'vt-queue-convert-');
  const mediaRoot = await makeTempDir(t, 'vt-queue-media-');
  enqueueMissingSource(db, 'Hoerbuecher/gone1.mp3', { queuedAt: 1 });
  enqueueMissingSource(db, 'Hoerbuecher/gone2.mp3', { queuedAt: 1 });

  const run = () => { assert.fail('run must not be called for a missing source'); };
  const { log, calls: logCalls } = fakeLogger();
  const queue = createConversionQueue({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run });
  assert.equal(await queue.start(), true);
  queue.kick();

  await waitForFinished(logCalls, 2);
  assert.equal(getConversion(db, 'Hoerbuecher/gone1.mp3')?.error, 'source_missing');
  assert.equal(getConversion(db, 'Hoerbuecher/gone2.mp3')?.error, 'source_missing');
});
