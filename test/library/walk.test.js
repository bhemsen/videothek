// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { isSkippedName, listDirectory } from '../../src/library/walk.js';
import { createMediaTree, removeMediaTree, makeMediaDir, writeMediaFile } from '../helpers/media-tree.js';

/**
 * @param {unknown} err
 * @returns {err is NodeJS.ErrnoException}
 */
function isErrnoException(err) {
  return err instanceof Error && 'code' in err;
}

const SKIPPED_NAME_CASES = [
  ['.hidden', true],
  ['.mp4', true],
  ['@eaDir', true],
  ['@EADIR', true],
  ['#recycle', true],
  ['#RECYCLE', true],
  ['#snapshot', true],
  ['#Snapshot', true],
  ['$RECYCLE.BIN', true],
  ['$recycle.bin', true],
  ['System Volume Information', true],
  ['system volume information', true],
  ['lost+found', true],
  ['LOST+FOUND', true],
  ['Movie.mp4', false],
  ['Filme', false],
  ['lost+found2', false],
  ['', false],
];

for (const [name, expected] of SKIPPED_NAME_CASES) {
  test(`isSkippedName(${JSON.stringify(name)}) -> ${expected}`, () => {
    assert.equal(isSkippedName(/** @type {string} */ (name)), expected);
  });
}

test('listDirectory: lists regular files with their stat and subdirectories', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Movie.mp4');
  await makeMediaDir(root, 'Extras');

  const result = await listDirectory(root);

  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]?.name, 'Movie.mp4');
  assert.ok(result.files[0]?.stat, 'a successfully-stat\'d file carries a stat object');
  assert.equal(result.files[0]?.stat?.isFile(), true);
  assert.deepEqual(result.dirs, ['Extras']);
  assert.deepEqual(result.skipped, { symlinks: 0, undecodable: 0 });
});

test('listDirectory: skips files with an unknown or missing extension, uncounted, without stat-ing them', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Movie.nfo');
  await writeMediaFile(root, 'README');
  await writeMediaFile(root, 'Movie.mp4');

  const statted = /** @type {string[]} */ ([]);
  /** @param {string} absPath */
  const statFn = (absPath) => {
    statted.push(absPath);
    return fs.stat(absPath);
  };

  const result = await listDirectory(root, { statFn });

  assert.deepEqual(result.files.map((f) => f.name), ['Movie.mp4']);
  assert.deepEqual(result.skipped, { symlinks: 0, undecodable: 0 });
  assert.equal(statted.some((p) => p.endsWith('Movie.nfo')), false);
  assert.equal(statted.some((p) => p.endsWith('README')), false);
});

test('listDirectory: skips hidden files and directories entirely, uncounted', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, '.versteckt.mp4');
  await makeMediaDir(root, '.hidden-dir');
  await writeMediaFile(root, 'Movie.mp4');

  const result = await listDirectory(root);

  assert.deepEqual(result.files.map((f) => f.name), ['Movie.mp4']);
  assert.deepEqual(result.dirs, []);
  assert.deepEqual(result.skipped, { symlinks: 0, undecodable: 0 });
});

test('listDirectory: skips known NAS/OS system folders case-insensitively, uncounted', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const systemNames = [
    '@eaDir',
    '#recycle',
    '#SNAPSHOT',
    '$RECYCLE.BIN',
    'System Volume Information',
    'lost+found',
  ];
  for (const name of systemNames) {
    await makeMediaDir(root, name);
  }
  await makeMediaDir(root, 'Filme');

  const result = await listDirectory(root);

  assert.deepEqual(result.dirs, ['Filme']);
  assert.deepEqual(result.skipped, { symlinks: 0, undecodable: 0 });
});

test('listDirectory: skips names containing U+FFFD and counts them, for files and directories', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Movie �.mp4');
  await makeMediaDir(root, 'Folder �');
  await writeMediaFile(root, 'Movie.mp4');

  const result = await listDirectory(root);

  assert.deepEqual(result.files.map((f) => f.name), ['Movie.mp4']);
  assert.deepEqual(result.dirs, []);
  assert.deepEqual(result.skipped, { symlinks: 0, undecodable: 2 });
});

test('listDirectory: skips a symlinked directory (junction, no elevated privileges needed) and counts it', async (t) => {
  const root = await createMediaTree();
  const outside = await createMediaTree();
  t.after(async () => {
    await removeMediaTree(root);
    await removeMediaTree(outside);
  });
  await makeMediaDir(root, 'Filme');
  await fs.symlink(outside, `${root}/LinkedFolder`, 'junction');

  const result = await listDirectory(root);

  assert.deepEqual(result.dirs, ['Filme']);
  assert.deepEqual(result.skipped, { symlinks: 1, undecodable: 0 });
});

test('listDirectory: skips a symlinked file and counts it', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const target = await writeMediaFile(root, 'Movie.mp4');

  try {
    await fs.symlink(target, `${root}/Movie-link.mp4`, 'file');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'EPERM') {
      t.skip('file symlinks require elevated privileges on this platform');
      return;
    }
    throw err;
  }

  const result = await listDirectory(root);

  assert.deepEqual(result.files.map((f) => f.name), ['Movie.mp4']);
  assert.deepEqual(result.skipped, { symlinks: 1, undecodable: 0 });
});

test('listDirectory: a stat ENOENT (vanished between readdir and stat) drops the file silently', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Movie.mp4');
  await writeMediaFile(root, 'Gone.mp4');

  const enoent = Object.assign(new Error('gone'), { code: 'ENOENT' });
  /** @param {string} absPath */
  const statFn = (absPath) => {
    if (absPath.endsWith('Gone.mp4')) return Promise.reject(enoent);
    return fs.stat(absPath);
  };

  const result = await listDirectory(root, { statFn });

  assert.deepEqual(result.files.map((f) => f.name), ['Movie.mp4']);
  assert.deepEqual(result.skipped, { symlinks: 0, undecodable: 0 });
});

test('listDirectory: a non-ENOENT stat error is reported in files as { name, error }', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Movie.mp4');
  await writeMediaFile(root, 'Locked.mp4');

  const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  /** @param {string} absPath */
  const statFn = (absPath) => {
    if (absPath.endsWith('Locked.mp4')) return Promise.reject(eacces);
    return fs.stat(absPath);
  };

  const result = await listDirectory(root, { statFn });

  const locked = result.files.find((f) => f.name === 'Locked.mp4');
  assert.ok(locked);
  assert.equal(locked?.error, eacces);
  assert.equal(result.files.find((f) => f.name === 'Movie.mp4')?.stat !== undefined, true);
});
