// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConversion } from '../../src/db/conversions.js';
import { getItemByRelPath } from '../../src/db/library-repo.js';
import { WORK_AREA_NAME } from '../../src/convert/work-dir.js';
import { createConversionQueue } from '../../src/convert/queue.js';
import {
  REL_PATH, lifecycleFixture, makeTempDir, startQueue, stubCmd, enqueueSource, fakeConfig,
  waitUntil, countEvent,
} from '../helpers/queue-lifecycle-setup.js';

/**
 * Planted work-area and storage symlinks against the real stub/queue
 * (docs/specs/archive/spec-conversion-core.md, Queue `start()` step 6 and Job steps
 * 3/6/7, `test/convert/queue-lifecycle.test.js`'s bullets not yet covered by
 * issue #220): each case's link target is an outside temp dir holding one
 * file, and every assertion proves that file untouched. `start()`-only
 * checks (unwritable/overlapping `CONVERT_DIR`, symlinked ancestors) live in
 * `queue-lifecycle-start.test.js`.
 */

/** Directory-link type per the spec's Verification convention (a junction needs no privileges on win32). */
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

/**
 * A fresh outside temp dir with exactly one file in it, for a planted link's target.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<string>}
 */
async function makeGuardedTarget(t) {
  const target = await makeTempDir(t, 'vt-links-target-');
  await fs.writeFile(path.join(target, 'keep.txt'), 'do not touch');
  return target;
}

test('.videothek-work as a symlink to a non-empty target before start(): the link is removed, the target is untouched, and the first job still runs', async (t) => {
  const f = await lifecycleFixture(t);
  await enqueueSource(f);
  const target = await makeGuardedTarget(t);
  await fs.mkdir(f.convertDirReal, { recursive: true });
  await fs.symlink(target, path.join(f.convertDirReal, WORK_AREA_NAME), LINK_TYPE);

  await startQueue(f, stubCmd('ok'));
  await waitUntil(() => countEvent(f.logCalls, 'conversion_finished') === 1);

  assert.deepEqual(await fs.readdir(target), ['keep.txt'], 'the outside target is untouched');
  assert.equal(getConversion(f.db, REL_PATH)?.status, 'playable');
  assert.equal(getItemByRelPath(f.db, REL_PATH)?.playable, 1);
});

test('.videothek-work swapped for a symlink to the target after start() and before the first job: the job ends storage_failed and nothing is created in the target', async (t) => {
  const f = await lifecycleFixture(t);
  await enqueueSource(f);
  const target = await makeGuardedTarget(t);

  const queue = createConversionQueue({ db: f.db, config: fakeConfig(f, stubCmd('ok')), log: f.log, now: () => 1 });
  f.stops.push(() => queue.stop());
  assert.equal(await queue.start(), true);
  await fs.symlink(target, path.join(f.convertDirReal, WORK_AREA_NAME), LINK_TYPE);

  queue.kick();
  await waitUntil(() => countEvent(f.logCalls, 'conversion_finished') === 1);

  const row = getConversion(f.db, REL_PATH);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.error, 'storage_failed');
  assert.equal(getItemByRelPath(f.db, REL_PATH)?.playable, 0);
  assert.deepEqual(await fs.readdir(target), ['keep.txt'], 'nothing was created in the target');
});

test('<convertDir>/<storage_key> pre-planted as a symlink to the target: the job ends storage_failed, the target is unchanged, and the row/flag stay unset', async (t) => {
  const f = await lifecycleFixture(t);
  const { key } = await enqueueSource(f);
  const target = await makeGuardedTarget(t);

  const queue = createConversionQueue({ db: f.db, config: fakeConfig(f, stubCmd('ok')), log: f.log, now: () => 1 });
  f.stops.push(() => queue.stop());
  assert.equal(await queue.start(), true);
  await fs.symlink(target, path.join(f.convertDirReal, key), LINK_TYPE);

  queue.kick();
  await waitUntil(() => countEvent(f.logCalls, 'conversion_finished') === 1);

  const row = getConversion(f.db, REL_PATH);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.error, 'storage_failed');
  assert.equal(getItemByRelPath(f.db, REL_PATH)?.playable, 0, 'library_items.playable stays 0');
  assert.deepEqual(await fs.readdir(target), ['keep.txt']);
});

test('links planted in out/ and tmp/ between --hold started and go: after cleanup the target is unchanged', async (t) => {
  const f = await lifecycleFixture(t);
  await enqueueSource(f);
  const holdDir = await makeTempDir(t, 'vt-links-hold-');
  const target = await makeGuardedTarget(t);

  await startQueue(f, stubCmd('ok', ['--hold', holdDir]));
  await waitUntil(() => existsSync(path.join(holdDir, 'started')));

  const [jobDirName] = await fs.readdir(path.join(f.convertDirReal, WORK_AREA_NAME));
  const jobDir = path.join(f.convertDirReal, WORK_AREA_NAME, jobDirName);
  await fs.symlink(target, path.join(jobDir, 'out', 'evil'), LINK_TYPE);
  await fs.symlink(target, path.join(jobDir, 'tmp', 'evil'), LINK_TYPE);

  await fs.writeFile(path.join(holdDir, 'go'), '');
  await waitUntil(() => countEvent(f.logCalls, 'conversion_finished') === 1);

  assert.deepEqual(await fs.readdir(target), ['keep.txt'], 'the outside target is untouched after cleanup');
  assert.equal(getConversion(f.db, REL_PATH)?.status, 'playable', 'the job itself still completes normally');
});
