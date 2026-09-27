// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverRoots, rootHealth } from '../../src/library/root-health.js';
import { createMediaTree, removeMediaTree, writeMediaFile, makeMediaDir } from '../helpers/media-tree.js';

test('discoverRoots lists only category-root directories, never a file, hidden name or unknown folder', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await makeMediaDir(root, 'Filme');
  await makeMediaDir(root, 'Serien');
  await makeMediaDir(root, 'Downloads');
  await makeMediaDir(root, '.Filme');
  await writeMediaFile(root, 'Musik'); // a plain file named like a category

  assert.deepEqual([...(await discoverRoots(root))].sort(), ['Filme', 'Serien']);
});

test('discoverRoots propagates an unreadable MEDIA_ROOT', async () => {
  await assert.rejects(discoverRoots(join('/', 'definitely-missing-media-root-xyz')));
});

test('rootHealth: missing, unreadable (not a directory), empty and healthy roots', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Serien'); // a file where a directory is expected
  await makeMediaDir(root, 'Filme');

  assert.equal(await rootHealth(root, 'Musik'), 'missing');
  assert.equal(await rootHealth(root, 'Serien'), 'unreadable');
  assert.equal(await rootHealth(root, 'Filme'), 'empty');
  await writeMediaFile(root, 'Filme/movie.webm');
  assert.equal(await rootHealth(root, 'Filme'), null);
});

test('rootHealth: only skipped entries left is empty; a non-media file is not', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/.DS_Store');
  await makeMediaDir(root, 'Filme/@eaDir');
  await makeMediaDir(root, 'Filme/#recycle');

  assert.equal(await rootHealth(root, 'Filme'), 'empty', 'hidden names and NAS/OS folders do not count');

  await writeMediaFile(root, 'Filme/info.nfo');
  assert.equal(await rootHealth(root, 'Filme'), null, 'the spec defines empty by the skip rules, not by indexable extensions');
});

test('rootHealth: a root holding only a symlink is empty', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const target = await writeMediaFile(root, 'elsewhere.webm');
  await makeMediaDir(root, 'Filme');
  try {
    await symlink(target, join(root, 'Filme', 'link.webm'));
  } catch {
    t.skip('symlink creation requires elevated privileges on this platform');
    return;
  }

  assert.equal(await rootHealth(root, 'Filme'), 'empty');
});
