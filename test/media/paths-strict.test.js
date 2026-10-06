// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveMediaPath, resolveMediaPathStrict } from '../../src/media/paths.js';

/** @param {string} prefix */
async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('resolveMediaPathStrict: missing file, unsafe path and an escaping symlink yield null', async () => {
  const root = await makeTempDir('vt-strict-');
  const outside = await makeTempDir('vt-strict-out-');
  try {
    await fs.writeFile(path.join(root, 'a.txt'), 'x');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'x');
    assert.equal(await resolveMediaPathStrict(root, 'a.txt'), await fs.realpath(path.join(root, 'a.txt')));
    assert.equal(await resolveMediaPathStrict(root, 'missing.txt'), null);
    assert.equal(await resolveMediaPathStrict(root, '../a.txt'), null);
    assert.equal(await resolveMediaPathStrict(root, 'a.txt/child'), null, 'ENOTDIR counts as missing');
    if (await tryLink(outside, path.join(root, 'escape'))) {
      assert.equal(await resolveMediaPathStrict(root, 'escape/secret.txt'), null);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('resolveMediaPathStrict rethrows a non-ENOENT errno (self-referencing symlink -> ELOOP); resolveMediaPath still yields null', async (t) => {
  const root = await makeTempDir('vt-strict-loop-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const loop = path.join(root, 'loop');
  let linked = true;
  try {
    await fs.symlink('loop', loop);
  } catch {
    linked = false;
  }
  if (!linked) return t.skip('symlink creation not permitted');
  await assert.rejects(resolveMediaPathStrict(root, 'loop'), (err) => /** @type {any} */ (err).code === 'ELOOP');
  assert.equal(await resolveMediaPath(root, 'loop'), null);
});

/**
 * @param {string} target
 * @param {string} link
 * @returns {Promise<boolean>} whether a directory link (junction on win32) could be created
 */
async function tryLink(target, link) {
  try {
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}
