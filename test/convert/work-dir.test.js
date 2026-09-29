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
  preparePublishDir,
} from '../../src/convert/work-dir.js';

/** @param {string} prefix */
async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** @param {string} dir */
async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

/** @param {string} p */
async function exists(p) {
  return fs.lstat(p).then(
    () => true,
    () => false,
  );
}

/** A fresh mediaRoot/publicDir pair plus a not-yet-existing nested convertDir. */
async function makeBase() {
  const base = await makeTempDir('vt-workdir-');
  const mediaRoot = path.join(base, 'media');
  const publicDir = path.join(base, 'public');
  await fs.mkdir(mediaRoot);
  await fs.mkdir(publicDir);
  return { base, mediaRoot, publicDir, convertDir: path.join(base, 'data', 'converted') };
}

// --- setupConvertDir --------------------------------------------------

test('setupConvertDir: creates a nested CONVERT_DIR with no overlap, idempotently on a second run', async (t) => {
  const { base, mediaRoot, publicDir, convertDir } = await makeBase();
  t.after(() => cleanup(base));
  const first = await setupConvertDir({ mediaRoot, convertDir, publicDir });
  const second = await setupConvertDir({ mediaRoot, convertDir, publicDir });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.ok && first.convertDirReal, await fs.realpath(convertDir));
  assert.equal(second.ok && second.convertDirReal, first.ok && first.convertDirReal);
});

test('setupConvertDir: rejects an overlapping or public-dir candidate, creating nothing', async (t) => {
  const cases = /** @type {const} */ ([
    ['inside MEDIA_ROOT', (/** @type {Awaited<ReturnType<typeof makeBase>>} */ b) => path.join(b.mediaRoot, 'x'), 'overlap'],
    ['inside the public dir', (/** @type {Awaited<ReturnType<typeof makeBase>>} */ b) => path.join(b.publicDir, 'x'), 'public'],
  ]);
  for (const [name, pick, code] of cases) {
    const ctx = await makeBase();
    t.after(() => cleanup(ctx.base));
    const convertDir = pick(ctx);
    const result = await setupConvertDir({ ...ctx, convertDir });
    assert.deepEqual(result, { ok: false, code }, name);
    assert.equal(await exists(convertDir), false, name);
  }
});

test('setupConvertDir: rejects MEDIA_ROOT inside CONVERT_DIR', async (t) => {
  const { base, publicDir } = await makeBase();
  t.after(() => cleanup(base));
  const convertDir = path.join(base, 'convert');
  const mediaRoot = path.join(convertDir, 'media');
  await fs.mkdir(mediaRoot, { recursive: true });
  assert.deepEqual(await setupConvertDir({ mediaRoot, convertDir, publicDir }), { ok: false, code: 'overlap' });
});

test('setupConvertDir: a missing MEDIA_ROOT or public dir fails at the first realpath', async (t) => {
  for (const key of /** @type {const} */ (['mediaRoot', 'publicDir'])) {
    const ctx = await makeBase();
    t.after(() => cleanup(ctx.base));
    const result = await setupConvertDir({ ...ctx, [key]: path.join(ctx.base, 'missing') });
    assert.deepEqual(result, { ok: false, code: 'ENOENT' }, key);
  }
});

test('setupConvertDir: a dangling symlink ancestor fails realpath, never falls through to mkdir', async (t) => {
  const { base, mediaRoot, publicDir } = await makeBase();
  t.after(() => cleanup(base));
  const link = path.join(base, 'dangling-link');
  await fs.symlink(path.join(base, 'does-not-exist'), link, 'junction');
  const result = await setupConvertDir({ mediaRoot, convertDir: path.join(link, 'converted'), publicDir });
  assert.deepEqual(result, { ok: false, code: 'ENOENT' });
});

test('setupConvertDir: a symlinked ancestor resolving into MEDIA_ROOT is rejected before mkdir', async (t) => {
  const { base, mediaRoot, publicDir } = await makeBase();
  t.after(() => cleanup(base));
  const link = path.join(base, 'data-link');
  await fs.symlink(mediaRoot, link, 'junction');
  const result = await setupConvertDir({ mediaRoot, convertDir: path.join(link, 'converted'), publicDir });
  assert.deepEqual(result, { ok: false, code: 'overlap' });
  assert.equal(await exists(path.join(mediaRoot, 'converted')), false);
});

test('setupConvertDir: a file blocking an ancestor segment fails with ENOTDIR', async (t) => {
  const { base, mediaRoot, publicDir } = await makeBase();
  t.after(() => cleanup(base));
  const blocker = path.join(base, 'blocker');
  await fs.writeFile(blocker, 'not a directory');
  const result = await setupConvertDir({ mediaRoot, convertDir: path.join(blocker, 'converted'), publicDir });
  assert.deepEqual(result, { ok: false, code: 'ENOTDIR' });
});

test('setupConvertDir: wipes a leftover work-area directory on success', async (t) => {
  const { base, mediaRoot, publicDir, convertDir } = await makeBase();
  t.after(() => cleanup(base));
  await fs.mkdir(path.join(convertDir, WORK_AREA_NAME), { recursive: true });
  await fs.writeFile(path.join(convertDir, WORK_AREA_NAME, 'leftover.tmp'), 'x');
  const result = await setupConvertDir({ mediaRoot, convertDir, publicDir });
  assert.equal(result.ok, true);
  assert.equal(await exists(path.join(convertDir, WORK_AREA_NAME)), false);
});

test('setupConvertDir: calls the injected removeDir without a trailing separator; its rejection is the wipe failure', async (t) => {
  const { base, mediaRoot, publicDir, convertDir } = await makeBase();
  t.after(() => cleanup(base));
  await fs.mkdir(path.join(convertDir, WORK_AREA_NAME), { recursive: true });
  /** @type {string[]} */
  const calls = [];
  const removeDir = async (/** @type {string} */ p) => {
    calls.push(p);
    await fs.rm(p, { recursive: true, force: true });
  };
  const result = await setupConvertDir({ mediaRoot, convertDir, publicDir, removeDir });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [path.join(await fs.realpath(convertDir), WORK_AREA_NAME)]);
  assert.ok(!calls[0].endsWith(path.sep));

  await fs.mkdir(path.join(convertDir, WORK_AREA_NAME), { recursive: true });
  const rejecting = async () => {
    throw Object.assign(new Error('busy'), { code: 'ENOTEMPTY' });
  };
  const second = await setupConvertDir({ mediaRoot, convertDir, publicDir, removeDir: rejecting });
  assert.deepEqual(second, { ok: false, code: 'ENOTEMPTY' });
});

// --- wipeWorkArea -------------------------------------------------------

test('wipeWorkArea: a missing work area is a no-op', async (t) => {
  const dir = await makeTempDir('vt-wipe-');
  t.after(() => cleanup(dir));
  assert.deepEqual(await wipeWorkArea(dir), { ok: true });
});

test('wipeWorkArea: a real directory is passed whole to removeDir, and a rejection surfaces its code', async (t) => {
  const dir = await makeTempDir('vt-wipe-');
  t.after(() => cleanup(dir));
  const workArea = path.join(dir, WORK_AREA_NAME);
  await fs.mkdir(workArea);
  await fs.writeFile(path.join(workArea, 'a.tmp'), 'x');
  /** @type {string[]} */
  const calls = [];
  const removeDir = async (/** @type {string} */ p) => {
    calls.push(p);
    await fs.rm(p, { recursive: true, force: true });
  };
  assert.deepEqual(await wipeWorkArea(dir, removeDir), { ok: true });
  assert.deepEqual(calls, [workArea]);
  assert.equal(await exists(workArea), false);

  await fs.mkdir(workArea);
  const rejecting = async () => {
    throw Object.assign(new Error('busy'), { code: 'ENOTEMPTY' });
  };
  assert.deepEqual(await wipeWorkArea(dir, rejecting), { ok: false, code: 'ENOTEMPTY' });
});

test('wipeWorkArea: a non-directory entry (symlink or plain file) is only unlinked, never passed to removeDir', async (t) => {
  const dir = await makeTempDir('vt-wipe-');
  const target = await makeTempDir('vt-wipe-target-');
  t.after(async () => {
    await cleanup(dir);
    await cleanup(target);
  });
  await fs.writeFile(path.join(target, 'keep.txt'), 'x');
  const workArea = path.join(dir, WORK_AREA_NAME);
  const removeDir = async () => {
    throw new Error('must not be called for a non-directory entry');
  };

  await fs.symlink(target, workArea, 'junction');
  assert.deepEqual(await wipeWorkArea(dir, removeDir), { ok: true });
  assert.equal(await exists(workArea), false);
  assert.equal(await exists(path.join(target, 'keep.txt')), true, 'unlink must not recurse into the link target');

  await fs.writeFile(workArea, 'x');
  assert.deepEqual(await wipeWorkArea(dir, removeDir), { ok: true });
  assert.equal(await exists(workArea), false);
});

// --- createJobDir ---------------------------------------------------------

test('createJobDir: creates a unique job dir plus out/ and tmp/', async (t) => {
  const convertDirReal = await makeTempDir('vt-jobdir-');
  t.after(() => cleanup(convertDirReal));
  const first = await createJobDir({ convertDirReal, storageKey: 'deadbeef' });
  const second = await createJobDir({ convertDirReal, storageKey: 'deadbeef' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.notEqual(first.jobDir, second.jobDir);
  assert.ok(path.basename(first.jobDir).startsWith('deadbeef-'));
  assert.equal(first.outDir, path.join(first.jobDir, 'out'));
  assert.equal(first.tmpDir, path.join(first.jobDir, 'tmp'));
  assert.equal((await fs.stat(first.outDir)).isDirectory(), true);
  assert.equal((await fs.stat(first.tmpDir)).isDirectory(), true);
  assert.equal(path.dirname(first.jobDir), path.join(convertDirReal, WORK_AREA_NAME));
});

test('createJobDir: a pre-planted work-area junction is rejected as containment, whether it escapes or stays inside', async (t) => {
  for (const inside of [false, true]) {
    const convertDirReal = await makeTempDir('vt-jobdir-');
    const target = inside ? path.join(convertDirReal, 'decoy') : await makeTempDir('vt-jobdir-elsewhere-');
    if (inside) await fs.mkdir(target);
    await fs.symlink(target, path.join(convertDirReal, WORK_AREA_NAME), 'junction');
    const result = await createJobDir({ convertDirReal, storageKey: 'deadbeef' });
    assert.deepEqual(result, { ok: false, code: 'containment' }, `inside=${inside}`);
    assert.deepEqual(await fs.readdir(target), [], `inside=${inside}`);
    await cleanup(convertDirReal);
    if (!inside) await cleanup(target);
  }
});

test(
  'createJobDir: a differently-cased CONVERT_DIR still resolves on win32',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const convertDirReal = await makeTempDir('vt-jobdir-');
    t.after(() => cleanup(convertDirReal));
    const result = await createJobDir({ convertDirReal: convertDirReal.toUpperCase(), storageKey: 'deadbeef' });
    assert.equal(result.ok, true);
  },
);

// --- preparePublishDir ------------------------------------------------

test('preparePublishDir: creates the storage-key directory, and accepts it again for a re-publish', async (t) => {
  const convertDirReal = await makeTempDir('vt-publish-');
  t.after(() => cleanup(convertDirReal));
  const first = await preparePublishDir({ convertDirReal, storageKey: 'feedface' });
  const second = await preparePublishDir({ convertDirReal, storageKey: 'feedface' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.ok && first.publishDirReal, path.join(convertDirReal, 'feedface'));
});

test('preparePublishDir: a storage-key junction elsewhere, or into the work area, fails as containment', async (t) => {
  const convertDirReal = await makeTempDir('vt-publish-');
  t.after(() => cleanup(convertDirReal));
  const elsewhere = await makeTempDir('vt-publish-elsewhere-');
  await fs.symlink(elsewhere, path.join(convertDirReal, 'feedface'), 'junction');
  assert.deepEqual(await preparePublishDir({ convertDirReal, storageKey: 'feedface' }), {
    ok: false,
    code: 'containment',
  });
  await cleanup(elsewhere);
  await fs.unlink(path.join(convertDirReal, 'feedface'));

  const jobResult = await createJobDir({ convertDirReal, storageKey: 'abc123' });
  assert.equal(jobResult.ok, true);
  if (!jobResult.ok) return;
  await fs.symlink(jobResult.jobDir, path.join(convertDirReal, 'feedface'), 'junction');
  assert.deepEqual(await preparePublishDir({ convertDirReal, storageKey: 'feedface' }), {
    ok: false,
    code: 'containment',
  });
});

test(
  'preparePublishDir: a differently-cased CONVERT_DIR still resolves on win32',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const convertDirReal = await makeTempDir('vt-publish-');
    t.after(() => cleanup(convertDirReal));
    const result = await preparePublishDir({
      convertDirReal: convertDirReal.toUpperCase(),
      storageKey: 'feedface',
    });
    assert.equal(result.ok, true);
  },
);
