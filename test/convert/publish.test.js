// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConversion } from '../../src/db/conversions.js';
import { interpretAndPublish, recordFailure } from '../../src/convert/publish.js';
import { REL_PATH, fakeConfig, makeTempDir, convertedFlac, setup } from '../helpers/conversion-job-fixtures.js';

/**
 * @param {Awaited<ReturnType<typeof setup>>} fx
 * @param {import('node:test').TestContext} t
 * @param {{ path: string, size: number, mtimeMs: number }} recorded - the stat the job saw at step 1.
 */
async function run(fx, t, recorded) {
  const outDir = await makeTempDir(t, 'vt-publish-out-');
  const result = await convertedFlac({ outDir });
  const opts = /** @type {any} */ ({
    db: fx.db, config: fakeConfig(fx.mediaRoot, fx.convertDirReal), now: () => 7, row: fx.row, convertDirReal: fx.convertDirReal,
  });
  const source = { path: recorded.path, size: recorded.size, mtimeMs: recorded.mtimeMs };
  return interpretAndPublish(opts, { outDir, result, source });
}

test('interpretAndPublish publishes when the re-stat matches the recorded source stat', async (t) => {
  const fx = await setup(t);
  const outcome = await run(fx, t, { ...fx.source, path: await fs.realpath(fx.source.abs) });
  assert.deepEqual(outcome, { status: 'playable' });
  assert.equal(getConversion(fx.db, REL_PATH)?.status, 'playable');
  await fs.stat(path.join(fx.convertDirReal, fx.row.storage_key, 'audio.flac'));
});

test('interpretAndPublish ends source_changed when the source stat moved during the run', async (t) => {
  const fx = await setup(t);
  const outcome = await run(fx, t, { path: await fs.realpath(fx.source.abs), size: fx.source.size + 1, mtimeMs: fx.source.mtimeMs });
  assert.deepEqual(outcome, { status: 'failed', error: 'source_changed' });
  assert.equal(getConversion(fx.db, REL_PATH)?.error, 'source_changed');
});

test('interpretAndPublish ends source_missing when the source is gone before the re-stat', async (t) => {
  const fx = await setup(t);
  const recorded = { ...fx.source, path: await fs.realpath(fx.source.abs) };
  await fs.unlink(fx.source.abs);
  const outcome = await run(fx, t, recorded);
  assert.deepEqual(outcome, { status: 'failed', error: 'source_missing' });
});

test('recordFailure writes the failed end state and returns it', async (t) => {
  const fx = await setup(t);
  assert.deepEqual(recordFailure(fx.db, fx.row, () => 9, 'internal', 'EBOOM'), { status: 'failed', error: 'internal' });
  const stored = getConversion(fx.db, REL_PATH);
  assert.equal(stored?.status, 'failed');
  assert.equal(stored?.error_detail, 'EBOOM');
});
