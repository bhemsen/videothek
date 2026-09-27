// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeMediaFile } from '../helpers/media-tree.js';
import { setup, loadRow } from '../helpers/scanner-fixtures.js';

/**
 * H9: the `images` category admits `['image', 'video']` kinds
 * (`src/library/categories.js`). Runs the real scanner end to end
 * (`createScanner` -> `requestFull()` -> `idle()`) over a small temp tree so
 * the admitted-kind widening is exercised through the same path production
 * uses, not just `kindsFor()` in isolation.
 */

test('images: a video under Bilder/ is indexed with category images, kind video', async (t) => {
  const { root, db, scanner } = await setup(t);
  await writeMediaFile(root, 'Bilder/clip.mp4');
  await writeMediaFile(root, 'Bilder/clip.webm');

  scanner.requestFull();
  await scanner.idle();

  const mp4 = loadRow(db, 'Bilder/clip.mp4');
  assert.ok(mp4, '.mp4 under Bilder/ is indexed');
  assert.equal(mp4.category, 'images');
  assert.equal(mp4.kind, 'video');

  const webm = loadRow(db, 'Bilder/clip.webm');
  assert.ok(webm, '.webm under Bilder/ is indexed');
  assert.equal(webm.category, 'images');
  assert.equal(webm.kind, 'video');
});

test('images: a non-playable video (.mov) under Bilder/ is indexed but not playable', async (t) => {
  const { root, db, scanner } = await setup(t);
  await writeMediaFile(root, 'Bilder/clip.mov');

  scanner.requestFull();
  await scanner.idle();

  const row = loadRow(db, 'Bilder/clip.mov');
  assert.ok(row, '.mov under Bilder/ is indexed');
  assert.equal(row.category, 'images');
  assert.equal(row.kind, 'video');
  assert.equal(row.playable, 0);
});

test('images: non-displayable image formats (.svg, .heic) under Bilder/ are indexed but not playable', async (t) => {
  const { root, db, scanner } = await setup(t);
  await writeMediaFile(root, 'Bilder/icon.svg');
  await writeMediaFile(root, 'Bilder/photo.heic');

  scanner.requestFull();
  await scanner.idle();

  const svg = loadRow(db, 'Bilder/icon.svg');
  assert.ok(svg, '.svg under Bilder/ is indexed');
  assert.equal(svg.category, 'images');
  assert.equal(svg.kind, 'image');
  assert.equal(svg.playable, 0);

  const heic = loadRow(db, 'Bilder/photo.heic');
  assert.ok(heic, '.heic under Bilder/ is indexed');
  assert.equal(heic.category, 'images');
  assert.equal(heic.kind, 'image');
  assert.equal(heic.playable, 0);
});

test('images: a displayable image (.jfif) under Bilder/ is indexed and playable', async (t) => {
  const { root, db, scanner } = await setup(t);
  await writeMediaFile(root, 'Bilder/photo.jfif');

  scanner.requestFull();
  await scanner.idle();

  const row = loadRow(db, 'Bilder/photo.jfif');
  assert.ok(row, '.jfif under Bilder/ is indexed');
  assert.equal(row.category, 'images');
  assert.equal(row.kind, 'image');
  assert.equal(row.playable, 1);
});

test('images: a video under Musik/ is still ignored (audio is the only admitted kind there)', async (t) => {
  const { root, db, scanner } = await setup(t);
  await writeMediaFile(root, 'Musik/clip.mp4');

  scanner.requestFull();
  await scanner.idle();

  assert.equal(loadRow(db, 'Musik/clip.mp4'), undefined);
});
