import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGalleryView } from '../../src/library/gallery.js';
import { makeItem, freshThumbFields } from './gallery-test-helpers.js';

test('buildGalleryView thumb marker: freshness', async (t) => {
  await t.test('embedded: playable image with a fresh recorded thumbnail', () => {
    const row = makeItem({ ...freshThumbFields(), orientation: 6 });
    const view = buildGalleryView({ key: '', items: [row], folders: [] });
    assert.equal(view.items[0].thumb, 'embedded');
    assert.equal(view.items[0].thumbOrientation, 6);
  });

  await t.test('a stale source (size mismatch) falls back to original', () => {
    const row = makeItem({ ...freshThumbFields(), sourceSize: 999, orientation: 6 });
    const view = buildGalleryView({ key: '', items: [row], folders: [] });
    assert.equal(view.items[0].thumb, 'original');
    assert.equal(view.items[0].thumbOrientation, 1);
  });

  await t.test('a stale source (mtime mismatch) falls back to original', () => {
    const row = makeItem({ ...freshThumbFields(), sourceMtimeMs: 1, orientation: 6 });
    const view = buildGalleryView({ key: '', items: [row], folders: [] });
    assert.equal(view.items[0].thumb, 'original');
  });

  await t.test('no recorded thumbnail falls back to original', () => {
    const row = makeItem({ thumbOffset: null, thumbLength: null });
    const view = buildGalleryView({ key: '', items: [row], folders: [] });
    assert.equal(view.items[0].thumb, 'original');
  });
});

test('buildGalleryView thumb marker: kind and orientation', async (t) => {
  await t.test('a non-playable image never gets a thumb marker', () => {
    const row = makeItem({ ...freshThumbFields(), playable: false });
    const view = buildGalleryView({ key: '', items: [row], folders: [] });
    assert.equal(view.items[0].thumb, null);
    assert.equal(view.items[0].thumbOrientation, 1);
  });

  await t.test('a video item never gets a thumb marker', () => {
    const row = makeItem({ ...freshThumbFields(), kind: 'video' });
    const view = buildGalleryView({ key: '', items: [row], folders: [] });
    assert.equal(view.items[0].thumb, null);
  });

  await t.test('a missing orientation on an embedded thumbnail defaults to 1', () => {
    const row = makeItem({ ...freshThumbFields(), orientation: null });
    const view = buildGalleryView({ key: '', items: [row], folders: [] });
    assert.equal(view.items[0].thumb, 'embedded');
    assert.equal(view.items[0].thumbOrientation, 1);
  });

  await t.test('a non-embedded item always reports orientation 1', () => {
    const row = makeItem({ orientation: 5 });
    const view = buildGalleryView({ key: '', items: [row], folders: [] });
    assert.equal(view.items[0].thumb, 'original');
    assert.equal(view.items[0].thumbOrientation, 1);
  });
});
