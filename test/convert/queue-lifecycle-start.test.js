// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConversion } from '../../src/db/conversions.js';
import { WORK_AREA_NAME } from '../../src/convert/work-dir.js';
import { createConversionQueue } from '../../src/convert/queue.js';
import {
  REL_PATH, lifecycleFixture, makeTempDir, startQueue, stubCmd, enqueueSource, fakeConfig,
  waitUntil, countEvent, snapshotOutsideConvertDir, assertNothingOutsideConvertDir,
} from '../helpers/queue-lifecycle-setup.js';

/**
 * `start()`'s own checks (docs/specs/spec-conversion-core.md, Queue `start()`
 * steps 1-6, `test/convert/queue-lifecycle.test.js`'s bullets not yet
 * covered by issue #220): a leftover crash work area, an unwritable or
 * overlapping `CONVERT_DIR`, a symlinked ancestor into `MEDIA_ROOT` or the
 * public dir, a dangling ancestor, and an injected work-area wipe failure.
 * Planted-link cases against a running job live in
 * `queue-lifecycle-links.test.js`.
 */

/** Directory-link type per the spec's Verification convention (a junction needs no privileges on win32). */
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

const exists = (/** @type {string} */ p) => fs.lstat(p).then(() => true, () => false);

test('a leftover .videothek-work/x is wiped by start(), and the first job after it still runs (step 3 re-creates the work area)', async (t) => {
  const f = await lifecycleFixture(t);
  await enqueueSource(f);
  await fs.mkdir(path.join(f.convertDirReal, WORK_AREA_NAME, 'x'), { recursive: true });
  await fs.writeFile(path.join(f.convertDirReal, WORK_AREA_NAME, 'x', 'leftover.tmp'), 'stale');

  const queue = createConversionQueue({ db: f.db, config: fakeConfig(f, stubCmd('ok')), log: f.log, now: () => 1 });
  f.stops.push(() => queue.stop());
  assert.equal(await queue.start(), true);
  assert.equal(await exists(path.join(f.convertDirReal, WORK_AREA_NAME)), false, 'start() wiped the leftover work area');

  queue.kick();
  await waitUntil(() => countEvent(f.logCalls, 'conversion_finished') === 1);

  assert.equal(getConversion(f.db, REL_PATH)?.status, 'playable');
  assert.deepEqual(await fs.readdir(path.join(f.convertDirReal, WORK_AREA_NAME)), [], 'the per-job dir was removed again');
});

test('an ENOTDIR-blocked or an overlapping convertDir resolves false and writes nothing', async (t) => {
  /** @type {[string, (f: import('../helpers/queue-lifecycle-setup.js').LifecycleFixture) => Promise<string>, string][]} */
  const cases = [
    ['ENOTDIR-blocked (parent is a regular file)', async (f) => {
      const blocker = path.join(f.base, 'blocker');
      await fs.writeFile(blocker, 'not a directory');
      return path.join(blocker, 'converted');
    }, 'ENOTDIR'],
    ['overlapping MEDIA_ROOT', async (f) => path.join(f.mediaRoot, 'converted'), 'overlap'],
  ];
  for (const [name, makeConvertDir, code] of cases) {
    const f = await lifecycleFixture(t);
    const convertDir = await makeConvertDir(f);
    const before = await snapshotOutsideConvertDir(f);
    const queue = createConversionQueue({
      db: f.db, config: { ...fakeConfig(f, stubCmd('ok')), convertDir }, log: f.log, now: () => 1,
    });
    assert.equal(await queue.start(), false, name);
    assert.deepEqual(f.logCalls.find((c) => c.event === 'conversion_dir_unavailable')?.fields, { code }, name);
    await assertNothingOutsideConvertDir(f, before);
  }
});

test('a symlinked ancestor into MEDIA_ROOT is rejected as overlap before mkdir; MEDIA_ROOT is unchanged', async (t) => {
  const f = await lifecycleFixture(t);
  const link = path.join(f.base, 'link');
  await fs.symlink(f.mediaRoot, link, LINK_TYPE);
  const before = await snapshotOutsideConvertDir(f);
  const convertDir = path.join(link, 'converted');
  const queue = createConversionQueue({
    db: f.db, config: { ...fakeConfig(f, stubCmd('ok')), convertDir }, log: f.log, now: () => 1,
  });
  assert.equal(await queue.start(), false);
  assert.deepEqual(f.logCalls.find((c) => c.event === 'conversion_dir_unavailable')?.fields, { code: 'overlap' });
  assert.equal(await exists(path.join(f.mediaRoot, 'converted')), false, 'no converted/ was created under MEDIA_ROOT');
  await assertNothingOutsideConvertDir(f, before);
});

test('a symlink into an injected publicDir is rejected as public; the public dir is unchanged', async (t) => {
  const f = await lifecycleFixture(t);
  const publicDir = await makeTempDir(t, 'vt-public-');
  await fs.writeFile(path.join(publicDir, 'index.html'), '<html></html>');
  const pubLink = path.join(f.base, 'pub');
  await fs.symlink(publicDir, pubLink, LINK_TYPE);
  const beforePublic = await fs.readdir(publicDir);
  const before = await snapshotOutsideConvertDir(f);
  const convertDir = path.join(pubLink, 'converted');
  const queue = createConversionQueue({
    db: f.db, config: { ...fakeConfig(f, stubCmd('ok')), convertDir }, log: f.log, now: () => 1, publicDir,
  });
  assert.equal(await queue.start(), false);
  assert.deepEqual(f.logCalls.find((c) => c.event === 'conversion_dir_unavailable')?.fields, { code: 'public' });
  assert.deepEqual(await fs.readdir(publicDir), beforePublic);
  await assertNothingOutsideConvertDir(f, before);
});

test('a dangling symlink as the nearest existing ancestor fails start() with its realpath code; nothing is created (win32 skips on EPERM/ENOENT)', async (t) => {
  const f = await lifecycleFixture(t);
  const dangling = path.join(f.base, 'dangling');
  try {
    await fs.symlink(path.join(f.base, 'does-not-exist'), dangling, LINK_TYPE);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code !== 'EPERM' && code !== 'ENOENT') throw err;
    t.skip(`cannot create a directory link here (${code})`);
    return;
  }
  const before = await snapshotOutsideConvertDir(f);
  const convertDir = path.join(dangling, 'converted');
  const queue = createConversionQueue({
    db: f.db, config: { ...fakeConfig(f, stubCmd('ok')), convertDir }, log: f.log, now: () => 1,
  });
  assert.equal(await queue.start(), false);
  assert.deepEqual(f.logCalls.find((c) => c.event === 'conversion_dir_unavailable')?.fields, { code: 'ENOENT' });
  await assertNothingOutsideConvertDir(f, before);
});

test('an injected removeDir rejection of the work-area wipe fails start() with conversion_dir_unavailable', async (t) => {
  const f = await lifecycleFixture(t);
  await fs.mkdir(path.join(f.convertDirReal, WORK_AREA_NAME), { recursive: true });
  const removeDir = (/** @type {string} */ target) => (
    path.basename(target) === WORK_AREA_NAME
      ? Promise.reject(Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' }))
      : fs.rm(target, { recursive: true, force: true, maxRetries: 3 })
  );
  const queue = createConversionQueue({
    db: f.db, config: fakeConfig(f, stubCmd('ok')), log: f.log, now: () => 1, removeDir,
  });
  assert.equal(await queue.start(), false);
  assert.deepEqual(f.logCalls.find((c) => c.event === 'conversion_dir_unavailable')?.fields, { code: 'EBUSY' });
});
