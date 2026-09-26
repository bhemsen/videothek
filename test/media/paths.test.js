import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveMediaPath } from '../../src/media/paths.js';

/** @param {string} prefix */
async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * @param {string} dir
 * @param {string} name
 */
async function writeFile(dir, name) {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, 'x');
  return filePath;
}

/** @param {string} dir */
async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/** @param {string} value */
function swapCase(value) {
  return [...value].map((ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase())).join('');
}

/**
 * @param {unknown} err
 * @returns {err is NodeJS.ErrnoException}
 */
function isErrnoException(err) {
  return err instanceof Error && 'code' in err;
}

test('resolveMediaPath: resolves paths inside the root', async (t) => {
  const root = await makeTempDir('vt-paths-');
  t.after(() => cleanup(root));
  await writeFile(root, 'movie.mp4');
  await fs.mkdir(path.join(root, 'sub'));
  await writeFile(path.join(root, 'sub'), 'episode.mp4');

  assert.equal(await resolveMediaPath(root, 'movie.mp4'), await fs.realpath(path.join(root, 'movie.mp4')));
  assert.equal(
    await resolveMediaPath(root, 'sub/episode.mp4'),
    await fs.realpath(path.join(root, 'sub', 'episode.mp4')),
  );
});

test('resolveMediaPath: rejects unsafe relative paths up front', async (t) => {
  const root = await makeTempDir('vt-paths-');
  t.after(() => cleanup(root));
  await writeFile(root, 'movie.mp4');

  const unsafe = [
    '..',
    '../escape.mp4',
    'sub/../../escape.mp4',
    '/etc/passwd',
    '\\Windows\\System32\\config',
    'C:\\secret.txt',
    'C:secret.txt',
    '\\\\server\\share\\file.txt',
    'movie\0.mp4',
    '',
  ];

  for (const relPath of unsafe) {
    assert.equal(await resolveMediaPath(root, relPath), null, `expected null for ${JSON.stringify(relPath)}`);
  }
});

test('resolveMediaPath: rejects a path to a missing file', async (t) => {
  const root = await makeTempDir('vt-paths-');
  t.after(() => cleanup(root));

  assert.equal(await resolveMediaPath(root, 'missing.mp4'), null);
});

test('resolveMediaPath: rejects a junction that escapes the root', async (t) => {
  const root = await makeTempDir('vt-paths-');
  const outside = await makeTempDir('vt-paths-outside-');
  t.after(async () => {
    await cleanup(root);
    await cleanup(outside);
  });
  await writeFile(outside, 'secret.txt');
  await fs.symlink(outside, path.join(root, 'escape'), 'junction');

  assert.equal(await resolveMediaPath(root, 'escape/secret.txt'), null);
});

test('resolveMediaPath: resolves a junction that stays inside the root', async (t) => {
  const root = await makeTempDir('vt-paths-');
  t.after(() => cleanup(root));
  const real = path.join(root, 'real');
  await fs.mkdir(real);
  await writeFile(real, 'movie.mp4');
  await fs.symlink(real, path.join(root, 'link'), 'junction');

  assert.equal(
    await resolveMediaPath(root, 'link/movie.mp4'),
    await fs.realpath(path.join(real, 'movie.mp4')),
  );
});

test('resolveMediaPath: rejects a sibling directory whose name prefixes the root', async (t) => {
  const base = await makeTempDir('vt-paths-');
  t.after(() => cleanup(base));
  const root = path.join(base, 'media');
  const evilSibling = path.join(base, 'media-evil');
  await fs.mkdir(root);
  await fs.mkdir(evilSibling);
  await writeFile(evilSibling, 'secret.txt');
  await fs.symlink(evilSibling, path.join(root, 'escape'), 'junction');

  assert.equal(await resolveMediaPath(root, 'escape/secret.txt'), null);
});

test('resolveMediaPath: MEDIA_ROOT itself behind a junction resolves', async (t) => {
  const base = await makeTempDir('vt-paths-');
  t.after(() => cleanup(base));
  const actualRoot = path.join(base, 'actual-root');
  const rootLink = path.join(base, 'root-link');
  await fs.mkdir(actualRoot);
  await writeFile(actualRoot, 'movie.mp4');
  await fs.symlink(actualRoot, rootLink, 'junction');

  assert.equal(
    await resolveMediaPath(rootLink, 'movie.mp4'),
    await fs.realpath(path.join(actualRoot, 'movie.mp4')),
  );
});

test(
  'resolveMediaPath: a differently-cased root still resolves on win32',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await makeTempDir('vt-paths-');
    t.after(() => cleanup(root));
    await writeFile(root, 'movie.mp4');

    assert.equal(
      await resolveMediaPath(swapCase(root), 'movie.mp4'),
      await fs.realpath(path.join(root, 'movie.mp4')),
    );
  },
);

test('resolveMediaPath: a file symlink escaping the root is rejected', async (t) => {
  const root = await makeTempDir('vt-paths-');
  const outside = await makeTempDir('vt-paths-outside-');
  t.after(async () => {
    await cleanup(root);
    await cleanup(outside);
  });
  const target = await writeFile(outside, 'secret.txt');
  const link = path.join(root, 'escape.txt');

  try {
    await fs.symlink(target, link, 'file');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'EPERM') {
      t.skip('file symlinks require elevated privileges on this platform');
      return;
    }
    throw err;
  }
  assert.equal(await resolveMediaPath(root, 'escape.txt'), null);
});

test('resolveMediaPath: a file symlink inside the root resolves', async (t) => {
  const root = await makeTempDir('vt-paths-');
  t.after(() => cleanup(root));
  const target = await writeFile(root, 'movie.mp4');
  const link = path.join(root, 'movie-link.mp4');

  try {
    await fs.symlink(target, link, 'file');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'EPERM') {
      t.skip('file symlinks require elevated privileges on this platform');
      return;
    }
    throw err;
  }
  assert.equal(await resolveMediaPath(root, 'movie-link.mp4'), await fs.realpath(target));
});
