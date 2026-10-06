// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConversion } from '../../src/db/conversions.js';
import { getItemByRelPath } from '../../src/db/library-repo.js';
import { runConversionJob } from '../../src/convert/job.js';
import { REL_PATH, fakeConfig, fakeRun, convertedFlac, fakeLogger, setup } from '../helpers/conversion-job-fixtures.js';

/** Counts `isCancelled()` calls and answers `true` from the `trueFrom`-th call on. @param {number} trueFrom */
const cancelFrom = (trueFrom) => {
  const state = { calls: 0 };
  return { state, isCancelled: () => { state.calls += 1; return state.calls >= trueFrom; } };
};

test('cancel flagged before the spawn ends cancelled without spawning, ahead of a pending stop()', async (t) => {
  const { db, convertDirReal, mediaRoot, row } = await setup(t);
  const { run, calls } = fakeRun(() => assert.fail('run must not be called'));
  const { log } = fakeLogger();
  await runConversionJob({
    db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, convertDirReal, row,
    isStopping: () => true, isCancelled: () => true,
  });
  assert.equal(calls.length, 0);
  assert.equal(getConversion(db, REL_PATH)?.status, 'failed');
  assert.equal(getConversion(db, REL_PATH)?.error, 'cancelled');
});

test('cancel flagged while the run is in flight ends cancelled, not interpreted, and removes the job dir', async (t) => {
  const { db, convertDirReal, mediaRoot, row } = await setup(t);
  const { isCancelled } = cancelFrom(2); // false before the spawn, true once the run settled
  const { run, calls } = fakeRun((args) => convertedFlac(args));
  const { log } = fakeLogger();
  await runConversionJob({
    db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, convertDirReal, row,
    isStopping: () => false, isCancelled,
  });
  assert.equal(calls.length, 1);
  assert.equal(getConversion(db, REL_PATH)?.error, 'cancelled');
  assert.equal(getItemByRelPath(db, REL_PATH)?.playable, 0);
  const leftovers = await fs.readdir(path.join(convertDirReal, '.videothek-work')).catch(() => []);
  assert.deepEqual(leftovers, []);
});

test('cancel flagged right before the publish transaction ends cancelled and leaves the renamed files for cleanup', async (t) => {
  const { db, convertDirReal, mediaRoot, row } = await setup(t);
  const { isCancelled, state } = cancelFrom(3); // false before spawn and after the run, true at the last check
  const { run } = fakeRun((args) => convertedFlac(args));
  const { log } = fakeLogger();
  await runConversionJob({
    db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, convertDirReal, row,
    isStopping: () => false, isCancelled,
  });
  assert.equal(state.calls, 3);
  const stored = getConversion(db, REL_PATH);
  assert.equal(stored?.status, 'failed');
  assert.equal(stored?.error, 'cancelled');
  assert.equal(getItemByRelPath(db, REL_PATH)?.playable, 0);
  const published = await fs.readdir(path.join(convertDirReal, row.storage_key));
  assert.equal(published.length, 1, 'the renamed output is left in place for cleanup');
});

test('a cancel arriving after the commit changes nothing', async (t) => {
  const { db, convertDirReal, mediaRoot, row } = await setup(t);
  const { run } = fakeRun((args) => convertedFlac(args));
  const { log } = fakeLogger();
  let committed = false;
  await runConversionJob({
    db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, convertDirReal, row,
    isStopping: () => false, isCancelled: () => committed,
  });
  committed = true;
  assert.equal(getConversion(db, REL_PATH)?.status, 'playable');
});
