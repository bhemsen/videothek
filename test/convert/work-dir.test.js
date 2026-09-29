// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  WORK_AREA_NAME,
  setupConvertDir,
  wipeWorkArea,
  createJobDir,
  createJobSubdirs,
  preparePublishDir,
} from '../../src/convert/work-dir.js';

/** Directory-link type per the spec's Verification convention (a junction needs no privileges on win32). */
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

/**
 * A fresh temp dir, realpath'd (macOS `/private/var`, win32 8.3 names) to stand in for `convertDirReal`.
 * @param {import('node:test').TestContext} t
 * @param {string} prefix
 */
async function makeTempDir(t, prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

const exists = (/** @type {string} */ p) => fs.lstat(p).then(() => true, () => false);
const rejecting = async () => Promise.reject(Object.assign(new Error('busy'), { code: 'ENOTEMPTY' }));

/** A real `removeDir` that also records every path it was called with. */
function recordingRemoveDir() {
  const calls = /** @type {string[]} */ ([]);
  const removeDir = async (/** @type {string} */ p) => {
    calls.push(p);
    await fs.rm(p, { recursive: true, force: true });
  };
  return { calls, removeDir };
}

/**
 * Creates a dangling directory link, or skips the test on win32 `EPERM`/`ENOENT` (spec Verification); false = skipped.
 * @param {import('node:test').TestContext} t
 * @param {string} target
 * @param {string} p
 */
async function link(t, target, p) {
  try {
    await fs.symlink(target, p, LINK_TYPE);
    return true;
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code !== 'EPERM' && code !== 'ENOENT') throw err;
    t.skip(`cannot create a directory link here (${code})`);
    return false;
  }
}

/**
 * A fresh mediaRoot/publicDir pair plus a not-yet-existing nested convertDir.
 * @param {import('node:test').TestContext} t
 */
async function makeBase(t) {
  const base = await makeTempDir(t, 'vt-workdir-');
  const mediaRoot = path.join(base, 'media');
  const publicDir = path.join(base, 'public');
  await fs.mkdir(mediaRoot);
  await fs.mkdir(publicDir);
  return { base, mediaRoot, publicDir, convertDir: path.join(base, 'data', 'converted') };
}

// --- setupConvertDir --------------------------------------------------

test('setupConvertDir: creates a nested CONVERT_DIR with no overlap, idempotently on a second run', async (t) => {
  const { mediaRoot, publicDir, convertDir } = await makeBase(t);
  const first = await setupConvertDir({ mediaRoot, convertDir, publicDir });
  const second = await setupConvertDir({ mediaRoot, convertDir, publicDir });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.ok && first.convertDirReal, await fs.realpath(convertDir));
  assert.equal(second.ok && second.convertDirReal, first.ok && first.convertDirReal);
});

test('setupConvertDir: rejects an overlapping or public-dir candidate, creating nothing', async (t) => {
  const cases = /** @type {const} */ ([
    ['inside MEDIA_ROOT', 'mediaRoot', 'overlap'],
    ['inside the public dir', 'publicDir', 'public'],
  ]);
  for (const [name, key, code] of cases) {
    const ctx = await makeBase(t);
    const convertDir = path.join(ctx[key], 'x');
    assert.deepEqual(await setupConvertDir({ ...ctx, convertDir }), { ok: false, code }, name);
    assert.equal(await exists(convertDir), false, name);
  }
});

test('setupConvertDir: rejects MEDIA_ROOT inside CONVERT_DIR', async (t) => {
  const { base, publicDir } = await makeBase(t);
  const convertDir = path.join(base, 'convert');
  const mediaRoot = path.join(convertDir, 'media');
  await fs.mkdir(mediaRoot, { recursive: true });
  assert.deepEqual(await setupConvertDir({ mediaRoot, convertDir, publicDir }), { ok: false, code: 'overlap' });
});

test('setupConvertDir: a missing MEDIA_ROOT or public dir fails at the first realpath', async (t) => {
  for (const key of /** @type {const} */ (['mediaRoot', 'publicDir'])) {
    const ctx = await makeBase(t);
    const result = await setupConvertDir({ ...ctx, [key]: path.join(ctx.base, 'missing') });
    assert.deepEqual(result, { ok: false, code: 'ENOENT' }, key);
  }
});

test('setupConvertDir: a dangling link ancestor fails realpath, never falls through to mkdir', async (t) => {
  const { base, mediaRoot, publicDir } = await makeBase(t);
  const dangling = path.join(base, 'dangling-link');
  if (!(await link(t, path.join(base, 'does-not-exist'), dangling))) return;
  const result = await setupConvertDir({ mediaRoot, convertDir: path.join(dangling, 'converted'), publicDir });
  assert.deepEqual(result, { ok: false, code: 'ENOENT' });
  assert.equal(await exists(path.join(base, 'does-not-exist')), false);
});

test('setupConvertDir: a linked ancestor resolving into MEDIA_ROOT is rejected before mkdir', async (t) => {
  const { base, mediaRoot, publicDir } = await makeBase(t);
  const dataLink = path.join(base, 'data-link');
  await fs.symlink(mediaRoot, dataLink, LINK_TYPE);
  const result = await setupConvertDir({ mediaRoot, convertDir: path.join(dataLink, 'converted'), publicDir });
  assert.deepEqual(result, { ok: false, code: 'overlap' });
  assert.equal(await exists(path.join(mediaRoot, 'converted')), false);
});

test('setupConvertDir: a file blocking an ancestor segment fails with ENOTDIR', async (t) => {
  const { base, mediaRoot, publicDir } = await makeBase(t);
  const blocker = path.join(base, 'blocker');
  await fs.writeFile(blocker, 'not a directory');
  const result = await setupConvertDir({ mediaRoot, convertDir: path.join(blocker, 'converted'), publicDir });
  assert.deepEqual(result, { ok: false, code: 'ENOTDIR' });
});

test('setupConvertDir: wipes a leftover work-area directory on success', async (t) => {
  const { mediaRoot, publicDir, convertDir } = await makeBase(t);
  await fs.mkdir(path.join(convertDir, WORK_AREA_NAME), { recursive: true });
  await fs.writeFile(path.join(convertDir, WORK_AREA_NAME, 'leftover.tmp'), 'x');
  const result = await setupConvertDir({ mediaRoot, convertDir, publicDir });
  assert.equal(result.ok, true);
  assert.equal(await exists(path.join(convertDir, WORK_AREA_NAME)), false);
});

test('setupConvertDir: calls the injected removeDir without a trailing separator; its rejection is the wipe failure', async (t) => {
  const { mediaRoot, publicDir, convertDir } = await makeBase(t);
  await fs.mkdir(path.join(convertDir, WORK_AREA_NAME), { recursive: true });
  const { calls, removeDir } = recordingRemoveDir();
  const result = await setupConvertDir({ mediaRoot, convertDir, publicDir, removeDir });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [path.join(await fs.realpath(convertDir), WORK_AREA_NAME)]);
  assert.ok(!calls[0].endsWith(path.sep));

  await fs.mkdir(path.join(convertDir, WORK_AREA_NAME), { recursive: true });
  const second = await setupConvertDir({ mediaRoot, convertDir, publicDir, removeDir: rejecting });
  assert.deepEqual(second, { ok: false, code: 'ENOTEMPTY' });
});

// --- wipeWorkArea -------------------------------------------------------

test('wipeWorkArea: a missing work area is a no-op', async (t) => {
  assert.deepEqual(await wipeWorkArea(await makeTempDir(t, 'vt-wipe-')), { ok: true });
});

test('wipeWorkArea: a real directory is passed whole to removeDir, and a rejection surfaces its code', async (t) => {
  const dir = await makeTempDir(t, 'vt-wipe-');
  const workArea = path.join(dir, WORK_AREA_NAME);
  await fs.mkdir(workArea);
  await fs.writeFile(path.join(workArea, 'a.tmp'), 'x');
  const { calls, removeDir } = recordingRemoveDir();
  assert.deepEqual(await wipeWorkArea(dir, removeDir), { ok: true });
  assert.deepEqual(calls, [workArea]);
  assert.equal(await exists(workArea), false);

  await fs.mkdir(workArea);
  assert.deepEqual(await wipeWorkArea(dir, rejecting), { ok: false, code: 'ENOTEMPTY' });
});

test('wipeWorkArea: a non-directory entry (link or plain file) is only unlinked, never passed to removeDir', async (t) => {
  const dir = await makeTempDir(t, 'vt-wipe-');
  const target = await makeTempDir(t, 'vt-wipe-target-');
  await fs.writeFile(path.join(target, 'keep.txt'), 'x');
  const workArea = path.join(dir, WORK_AREA_NAME);
  const removeDir = async () => {
    throw new Error('must not be called for a non-directory entry');
  };

  await fs.symlink(target, workArea, LINK_TYPE);
  assert.deepEqual(await wipeWorkArea(dir, removeDir), { ok: true });
  assert.equal(await exists(workArea), false);
  assert.equal(await exists(path.join(target, 'keep.txt')), true, 'unlink must not recurse into the link target');

  await fs.writeFile(workArea, 'x');
  assert.deepEqual(await wipeWorkArea(dir, removeDir), { ok: true });
  assert.equal(await exists(workArea), false);
});

// --- createJobDir / createJobSubdirs ---------------------------------------

test('createJobDir: creates a unique job dir plus out/ and tmp/', async (t) => {
  const convertDirReal = await makeTempDir(t, 'vt-jobdir-');
  const first = await createJobDir({ convertDirReal, storageKey: 'deadbeef' });
  const second = await createJobDir({ convertDirReal, storageKey: 'deadbeef' });
  assert.ok(first.ok && second.ok);
  assert.notEqual(first.jobDir, second.jobDir);
  assert.ok(path.basename(first.jobDir).startsWith('deadbeef-'));
  assert.equal(first.outDir, path.join(first.jobDir, 'out'));
  assert.equal(first.tmpDir, path.join(first.jobDir, 'tmp'));
  assert.equal((await fs.stat(first.outDir)).isDirectory(), true);
  assert.equal((await fs.stat(first.tmpDir)).isDirectory(), true);
  assert.equal(path.dirname(first.jobDir), path.join(convertDirReal, WORK_AREA_NAME));
});

test('createJobDir: a pre-planted work-area link is rejected as containment, whether it escapes or stays inside', async (t) => {
  for (const inside of [false, true]) {
    const convertDirReal = await makeTempDir(t, 'vt-jobdir-');
    const target = inside ? path.join(convertDirReal, 'decoy') : await makeTempDir(t, 'vt-jobdir-elsewhere-');
    if (inside) await fs.mkdir(target);
    await fs.symlink(target, path.join(convertDirReal, WORK_AREA_NAME), LINK_TYPE);
    const result = await createJobDir({ convertDirReal, storageKey: 'deadbeef' });
    assert.deepEqual(result, { ok: false, code: 'containment' }, `inside=${inside}`);
    assert.deepEqual(await fs.readdir(target), [], `inside=${inside}`);
  }
});

test('createJobDir / preparePublishDir: a file in the way fails mkdir; a failing mkdtemp surfaces its code', async (t) => {
  const convertDirReal = await makeTempDir(t, 'vt-jobdir-');
  await fs.writeFile(path.join(convertDirReal, WORK_AREA_NAME), 'x');
  await fs.writeFile(path.join(convertDirReal, 'feedface'), 'x');
  assert.deepEqual(await createJobDir({ convertDirReal, storageKey: 'deadbeef' }), { ok: false, code: 'EEXIST' });
  assert.deepEqual(await preparePublishDir({ convertDirReal, storageKey: 'feedface' }), { ok: false, code: 'EEXIST' });

  const other = await makeTempDir(t, 'vt-jobdir-');
  // A prefix inside a missing directory is the one deterministic way to fail `mkdtemp` itself.
  const result = await createJobDir({ convertDirReal: other, storageKey: path.join('missing', 'deadbeef') });
  assert.deepEqual(result, { ok: false, code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.join(other, WORK_AREA_NAME)), []);
});

test('createJobSubdirs: a failure after mkdtemp still carries jobDir for the caller to remove', async (t) => {
  const jobDir = await makeTempDir(t, 'vt-jobsub-');
  await fs.writeFile(path.join(jobDir, 'tmp'), 'x');
  assert.deepEqual(await createJobSubdirs(jobDir), { ok: false, code: 'EEXIST', jobDir });
  assert.equal((await fs.stat(path.join(jobDir, 'out'))).isDirectory(), true, 'out/ is created before tmp/');
});

// --- preparePublishDir ------------------------------------------------

test('preparePublishDir: creates the storage-key directory, and accepts it again for a re-publish', async (t) => {
  const convertDirReal = await makeTempDir(t, 'vt-publish-');
  const first = await preparePublishDir({ convertDirReal, storageKey: 'feedface' });
  const second = await preparePublishDir({ convertDirReal, storageKey: 'feedface' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.ok && first.publishDirReal, path.join(convertDirReal, 'feedface'));
});

test('preparePublishDir: a storage-key link elsewhere, or into the work area, fails as containment', async (t) => {
  const convertDirReal = await makeTempDir(t, 'vt-publish-');
  const elsewhere = await makeTempDir(t, 'vt-publish-elsewhere-');
  const containment = { ok: false, code: 'containment' };
  await fs.symlink(elsewhere, path.join(convertDirReal, 'feedface'), LINK_TYPE);
  assert.deepEqual(await preparePublishDir({ convertDirReal, storageKey: 'feedface' }), containment);
  assert.deepEqual(await fs.readdir(elsewhere), []);
  await fs.unlink(path.join(convertDirReal, 'feedface'));

  const jobResult = await createJobDir({ convertDirReal, storageKey: 'abc123' });
  assert.ok(jobResult.ok);
  await fs.symlink(jobResult.jobDir, path.join(convertDirReal, 'feedface'), LINK_TYPE);
  assert.deepEqual(await preparePublishDir({ convertDirReal, storageKey: 'feedface' }), containment);
});

test('createJobDir / preparePublishDir: a dangling link in place fails with an errno, never as success', async (t) => {
  const convertDirReal = await makeTempDir(t, 'vt-dangling-');
  const gone = path.join(convertDirReal, 'gone');
  if (!(await link(t, gone, path.join(convertDirReal, WORK_AREA_NAME)))) return;
  if (!(await link(t, gone, path.join(convertDirReal, 'feedface')))) return;
  const job = await createJobDir({ convertDirReal, storageKey: 'deadbeef' });
  const publish = await preparePublishDir({ convertDirReal, storageKey: 'feedface' });
  // win32 fails the recursive mkdir with ENOENT (checked); POSIX may report EEXIST instead.
  for (const result of [job, publish]) {
    assert.equal(result.ok, false);
    assert.ok(!result.ok && ['ENOENT', 'EEXIST'].includes(result.code), JSON.stringify(result));
  }
  assert.equal(await exists(gone), false);
});

test('createJobDir / preparePublishDir: a differently-cased CONVERT_DIR still resolves on win32', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const convertDirReal = (await makeTempDir(t, 'vt-case-')).toUpperCase();
  assert.equal((await createJobDir({ convertDirReal, storageKey: 'deadbeef' })).ok, true);
  assert.equal((await preparePublishDir({ convertDirReal, storageKey: 'feedface' })).ok, true);
});
