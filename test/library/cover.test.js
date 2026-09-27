// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { findCover } from '../../src/library/cover.js';
import { resolveMediaPath } from '../../src/media/paths.js';
import { createMediaTree, removeMediaTree, makeMediaDir, writeMediaFile } from '../helpers/media-tree.js';

/** @param {unknown} err @returns {err is NodeJS.ErrnoException} */
function isErrnoException(err) {
  return err instanceof Error && 'code' in err;
}

/** A stub `readPicture` that always answers the same fixed ref (or `null`).
 * @param {{ offset: number, length: number, mime: string } | null} [ref] */
function stubReadPicture(ref = null) {
  return async () => ref;
}

/**
 * @param {Partial<import('../../src/library/cover.js').CoverRow>} overrides
 * @returns {import('../../src/library/cover.js').CoverRow}
 */
function makeRow(overrides = {}) {
  return {
    relPath: 'Musik/Die Beispiele/Unterwegs/01 Titel.mp3',
    dir: 'Musik/Die Beispiele/Unterwegs',
    ext: 'mp3',
    groupKey: 'Musik/Die Beispiele/Unterwegs',
    groupTitle: 'Unterwegs',
    ...overrides,
  };
}

test('findCover: real album directory — name priority cover > folder > front, then extension priority jpg > jpeg > png > webp', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const dir = 'Musik/Die Beispiele/Unterwegs';
  await makeMediaDir(root, dir);
  await writeMediaFile(root, `${dir}/front.png`);
  const row = makeRow();
  const readPicture = stubReadPicture();

  assert.equal(
    (await findCover({ mediaRoot: root, row, resolvePath: resolveMediaPath, readPicture }))?.path,
    path.join(root, dir, 'front.png'),
  );

  await writeMediaFile(root, `${dir}/folder.jpg`);
  assert.equal(
    (await findCover({ mediaRoot: root, row, resolvePath: resolveMediaPath, readPicture }))?.path,
    path.join(root, dir, 'folder.jpg'),
    'folder beats front regardless of extension',
  );

  await writeMediaFile(root, `${dir}/cover.webp`);
  assert.equal(
    (await findCover({ mediaRoot: root, row, resolvePath: resolveMediaPath, readPicture }))?.path,
    path.join(root, dir, 'cover.webp'),
    'cover beats folder even with a lower-priority extension',
  );

  await writeMediaFile(root, `${dir}/Cover.JPG`);
  const result = await findCover({ mediaRoot: root, row, resolvePath: resolveMediaPath, readPicture });
  assert.equal(result?.path, path.join(root, dir, 'Cover.JPG'), 'jpg beats webp for the same base name, case-insensitively');
});

test('findCover: disc-folder directory is tried before the group directory', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const groupDir = 'Musik/Die Beispiele/Doppelalbum';
  const discDir = `${groupDir}/CD 1`;
  await makeMediaDir(root, discDir);
  await writeMediaFile(root, `${groupDir}/cover.png`);
  const row = makeRow({ relPath: `${discDir}/01 Titel.mp3`, dir: discDir, groupKey: groupDir, groupTitle: 'Doppelalbum' });
  const readPicture = stubReadPicture();

  const groupOnly = await findCover({ mediaRoot: root, row, resolvePath: resolveMediaPath, readPicture });
  assert.equal(groupOnly?.path, path.join(root, groupDir, 'cover.png'), 'falls back to the group directory');

  await writeMediaFile(root, `${discDir}/cover.jpg`);
  const discFirst = await findCover({ mediaRoot: root, row, resolvePath: resolveMediaPath, readPicture });
  assert.equal(discFirst?.path, path.join(root, discDir, 'cover.jpg'), 'the disc folder itself wins once it has its own cover');
});

test('findCover: sidecar image for a pseudo-album (music) and a single-file book (audiobooks)', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const readPicture = stubReadPicture();

  await writeMediaFile(root, 'Musik/Einzeltrack.mp3');
  await writeMediaFile(root, 'Musik/Einzeltrack.png');
  const pseudoAlbumRow = makeRow({ relPath: 'Musik/Einzeltrack.mp3', dir: 'Musik', groupKey: 'Musik', groupTitle: null });
  const pseudoResult = await findCover({ mediaRoot: root, row: pseudoAlbumRow, resolvePath: resolveMediaPath, readPicture });
  assert.equal(pseudoResult?.path, path.join(root, 'Musik/Einzeltrack.png'));

  await writeMediaFile(root, 'Hörbücher/Jules Beispiel/Kurzgeschichte.mp3');
  await writeMediaFile(root, 'Hörbücher/Jules Beispiel/Kurzgeschichte.jpg');
  const singleFileRow = makeRow({
    relPath: 'Hörbücher/Jules Beispiel/Kurzgeschichte.mp3',
    dir: 'Hörbücher/Jules Beispiel',
    ext: 'mp3',
    groupKey: 'Hörbücher/Jules Beispiel/Kurzgeschichte.mp3',
    groupTitle: 'Kurzgeschichte',
  });
  const bookResult = await findCover({ mediaRoot: root, row: singleFileRow, resolvePath: resolveMediaPath, readPicture });
  assert.equal(bookResult?.path, path.join(root, 'Hörbücher/Jules Beispiel/Kurzgeschichte.jpg'));
});

test('findCover: a folder image beats the embedded picture; the embedded picture is used only once no folder image exists', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const dir = 'Musik/Die Beispiele/Unterwegs';
  await makeMediaDir(root, dir);
  const itemPath = await writeMediaFile(root, `${dir}/01 Titel.mp3`);
  const row = makeRow();
  const ref = { offset: 10, length: 20, mime: 'image/jpeg' };

  const noFolder = await findCover({ mediaRoot: root, row, resolvePath: resolveMediaPath, readPicture: stubReadPicture(ref) });
  assert.deepEqual(noFolder, { kind: 'slice', path: itemPath, ...ref });

  await writeMediaFile(root, `${dir}/cover.jpg`);
  const withFolder = await findCover({ mediaRoot: root, row, resolvePath: resolveMediaPath, readPicture: stubReadPicture(ref) });
  assert.equal(withFolder?.path, path.join(root, dir, 'cover.jpg'));
  assert.equal(withFolder && 'kind' in withFolder ? withFolder.kind : undefined, 'file');
});

test('findCover: null when nothing matches (no folder image, no sidecar, no embedded picture)', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const dir = 'Musik/Die Beispiele/Unterwegs';
  await makeMediaDir(root, dir);
  await writeMediaFile(root, `${dir}/01 Titel.mp3`);
  const result = await findCover({ mediaRoot: root, row: makeRow(), resolvePath: resolveMediaPath, readPicture: stubReadPicture(null) });
  assert.equal(result, null);
});

test('findCover: a cover file that is a symlink escaping MEDIA_ROOT is never used', async (t) => {
  const root = await createMediaTree();
  const outside = await createMediaTree('vt-cover-outside-');
  t.after(async () => {
    await removeMediaTree(root);
    await removeMediaTree(outside);
  });
  const dir = 'Musik/Die Beispiele/Unterwegs';
  await makeMediaDir(root, dir);
  const secret = await writeMediaFile(outside, 'secret.jpg', { content: 'not a real cover' });
  const link = path.join(root, dir, 'cover.jpg');

  const fs = await import('node:fs/promises');
  try {
    await fs.symlink(secret, link, 'file');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'EPERM') {
      t.skip('file symlinks require elevated privileges on this platform');
      return;
    }
    throw err;
  }

  const result = await findCover({ mediaRoot: root, row: makeRow(), resolvePath: resolveMediaPath, readPicture: stubReadPicture(null) });
  assert.equal(result, null, '404 when nothing else exists — the symlinked cover is skipped, not resolved');
});
