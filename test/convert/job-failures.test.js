// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getItemByRelPath } from '../../src/db/library-repo.js';
import { getConversion } from '../../src/db/conversions.js';
import { runConversionJob } from '../../src/convert/job.js';
import { WORK_AREA_NAME } from '../../src/convert/work-dir.js';
import { REL_PATH, fakeConfig, fakeLogger, fakeRun, convertedFlac, setup } from '../helpers/conversion-job-fixtures.js';

/** A recording `removeDir` that still removes, like the default. */
function recordingRemoveDir() {
  const removed = /** @type {string[]} */ ([]);
  const removeDir = async (/** @type {string} */ dir) => {
    removed.push(dir);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  };
  return { removed, removeDir };
}

test('step 3: a regular file at .videothek-work ends storage_failed with an errno detail, without spawning or removing', async (t) => {
  const { db, convertDirReal, mediaRoot, row } = await setup(t);
  await fs.writeFile(path.join(convertDirReal, WORK_AREA_NAME), 'occupied');
  const { run, calls } = fakeRun(() => assert.fail('run must not be called'));
  const { removed, removeDir } = recordingRemoveDir();
  const { log, calls: logCalls } = fakeLogger();
  await runConversionJob({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, removeDir, convertDirReal, row, isStopping: () => false });
  assert.equal(calls.length, 0);
  assert.deepEqual(removed, [], 'no job dir was created, so nothing is removed');
  const stored = getConversion(db, REL_PATH);
  assert.equal(stored?.error, 'storage_failed');
  assert.match(stored?.error_detail ?? '', /^E[A-Z]+$/);
  assert.equal(logCalls.at(-1)?.fields?.error, 'storage_failed');
});

test('step 3: a .videothek-work link to another dir inside CONVERT_DIR ends storage_failed containment', async (t) => {
  const { db, convertDirReal, mediaRoot, row } = await setup(t);
  const elsewhere = path.join(convertDirReal, 'elsewhere');
  await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, path.join(convertDirReal, WORK_AREA_NAME), 'junction');
  const { run, calls } = fakeRun(() => assert.fail('run must not be called'));
  const { log } = fakeLogger();
  await runConversionJob({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, convertDirReal, row, isStopping: () => false });
  assert.equal(calls.length, 0);
  const stored = getConversion(db, REL_PATH);
  assert.equal(stored?.error, 'storage_failed');
  assert.equal(stored?.error_detail, 'containment');
  assert.deepEqual(await fs.readdir(elsewhere), [], 'nothing was created through the link');
});

test('step 5: the source removed during the run ends source_missing without publishing', async (t) => {
  const { db, convertDirReal, mediaRoot, row, source } = await setup(t);
  const { run } = fakeRun(async (args) => {
    await fs.unlink(source.abs);
    return convertedFlac(args);
  });
  const { log } = fakeLogger();
  await runConversionJob({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, convertDirReal, row, isStopping: () => false });
  const stored = getConversion(db, REL_PATH);
  assert.equal(stored?.status, 'failed');
  assert.equal(stored?.error, 'source_missing');
  assert.equal(getItemByRelPath(db, REL_PATH)?.playable, 0);
  await assert.rejects(fs.stat(path.join(convertDirReal, row.storage_key)), 'no publish dir was created');
});

test('step 5: a source that now resolves elsewhere (same bytes, same mtime) ends source_changed', async (t) => {
  const { db, convertDirReal, mediaRoot, row, source } = await setup(t);
  const bookDir = path.dirname(source.abs);
  const { run } = fakeRun(async (args) => {
    await fs.rename(bookDir, `${bookDir}-moved`);
    await fs.symlink(`${bookDir}-moved`, bookDir, 'junction');
    return convertedFlac(args);
  });
  const { log } = fakeLogger();
  await runConversionJob({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, convertDirReal, row, isStopping: () => false });
  assert.equal(getConversion(db, REL_PATH)?.error, 'source_changed');
  assert.equal(getItemByRelPath(db, REL_PATH)?.playable, 0);
});

test('a failing internal fallback write (DB closed after stop()) only logs; cleanup and conversion_finished still run', async (t) => {
  const { db, convertDirReal, mediaRoot, row } = await setup(t);
  let stopping = false;
  const { run } = fakeRun(async (args) => {
    const result = await convertedFlac(args);
    db.close();
    stopping = true;
    return result;
  });
  const { removed, removeDir } = recordingRemoveDir();
  const { log, calls: logCalls } = fakeLogger();
  await assert.doesNotReject(runConversionJob({
    db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, removeDir, convertDirReal, row,
    isStopping: () => stopping,
  }));
  assert.equal(removed.length, 1, 'the job dir is removed in finally');
  assert.ok(path.basename(removed[0]).startsWith(`${row.storage_key}-`));
  await assert.rejects(fs.stat(removed[0]));
  const errors = logCalls.filter((c) => c.event === 'conversion_error');
  assert.equal(errors.length, 2, 'the failed interrupted write and the failed internal fallback write both log');
  const finished = logCalls.at(-1);
  assert.equal(finished?.event, 'conversion_finished');
  assert.equal(finished?.fields?.status, 'failed');
  assert.equal(finished?.fields?.error, 'internal');
});
