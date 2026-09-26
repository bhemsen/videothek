import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childFolders, buildGalleryView } from '../../src/library/gallery.js';
import { makeItem, freshThumbFields } from './gallery-test-helpers.js';

test('childFolders', async (t) => {
  await t.test('aggregates a multi-level subtree into direct children with summed counts', () => {
    const folderCounts = [
      { folder: 'Urlaub 2024', count: 2 },
      { folder: 'Urlaub 2024/Italien', count: 9 },
      { folder: 'Urlaub 2024/Italien/Tag 1 – Rom', count: 1 },
      { folder: 'Urlaub 2024/Italien/Tag 2 – Florenz', count: 1 },
      { folder: 'Familie', count: 2 },
    ];
    const result = childFolders('', folderCounts);
    const byKey = Object.fromEntries(result.map((f) => [f.key, f]));
    assert.equal(result.length, 2);
    assert.deepEqual(byKey['Urlaub 2024'], { key: 'Urlaub 2024', name: 'Urlaub 2024', count: 13 });
    assert.deepEqual(byKey['Familie'], { key: 'Familie', name: 'Familie', count: 2 });
  });

  await t.test('aggregates below a non-root key', () => {
    const folderCounts = [
      { folder: 'Urlaub 2024/Italien', count: 9 },
      { folder: 'Urlaub 2024/Italien/Tag 1 – Rom', count: 1 },
      { folder: 'Urlaub 2024/Italien/Tag 2 – Florenz', count: 1 },
    ];
    const result = childFolders('Urlaub 2024', folderCounts);
    assert.deepEqual(result, [{ key: 'Urlaub 2024/Italien', name: 'Italien', count: 11 }]);
  });

  await t.test('ignores a folder equal to key and siblings outside its subtree', () => {
    const result = childFolders('Urlaub 2024', [
      { folder: 'Urlaub 2024', count: 5 },
      { folder: 'Familie', count: 3 },
    ]);
    assert.deepEqual(result, []);
  });

  await t.test('returns an empty list for an empty input', () => {
    assert.deepEqual(childFolders('', []), []);
  });
});

test('buildGalleryView breadcrumb and name', async (t) => {
  await t.test('root: empty name, empty breadcrumb', () => {
    const view = buildGalleryView({ key: '', items: [], folders: [] });
    assert.equal(view.name, '');
    assert.deepEqual(view.breadcrumb, []);
    assert.equal(view.key, '');
  });

  await t.test('a top-level folder has no ancestors between root and itself', () => {
    const view = buildGalleryView({ key: 'Urlaub 2024', items: [], folders: [] });
    assert.equal(view.name, 'Urlaub 2024');
    assert.deepEqual(view.breadcrumb, []);
  });

  await t.test('a deep folder lists ancestors, excluding root and current', () => {
    const view = buildGalleryView({
      key: 'Urlaub 2024/Italien/Tag 1 – Rom',
      items: [],
      folders: [],
    });
    assert.equal(view.name, 'Tag 1 – Rom');
    assert.deepEqual(view.breadcrumb, [
      { key: 'Urlaub 2024', name: 'Urlaub 2024' },
      { key: 'Urlaub 2024/Italien', name: 'Italien' },
    ]);
  });
});

test('buildGalleryView item sort', async (t) => {
  await t.test('takenAt ascending is the primary key', () => {
    const items = [
      makeItem({ id: 1, relPath: 'Bilder/z.jpg', takenAt: '2024-07-14T10:28:00' }),
      makeItem({ id: 2, relPath: 'Bilder/a.jpg', takenAt: '2024-07-14T09:14:00' }),
    ];
    const view = buildGalleryView({ key: '', items, folders: [] });
    assert.deepEqual(view.items.map((i) => i.id), [2, 1]);
  });

  await t.test('a missing takenAt falls back to mtime formatted YYYY-MM-DDTHH:MM:SS local time', () => {
    const mtimeMs = new Date(2024, 0, 15, 9, 5, 3).getTime();
    const view = buildGalleryView({
      key: '',
      items: [makeItem({ id: 1, relPath: 'Bilder/x.jpg', takenAt: null, mtimeMs })],
      folders: [],
    });
    assert.match(view.items[0].takenAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    assert.equal(view.items[0].takenAt, '2024-01-15T09:05:03');
  });

  await t.test('equal takenAt ties break on the natural, case-insensitive collator name', () => {
    const items = [
      makeItem({ id: 1, relPath: 'Bilder/Screenshot 10.png', takenAt: '2024-01-01T00:00:00' }),
      makeItem({ id: 2, relPath: 'Bilder/Screenshot 2.png', takenAt: '2024-01-01T00:00:00' }),
    ];
    const view = buildGalleryView({ key: '', items, folders: [] });
    assert.deepEqual(view.items.map((i) => i.name), ['Screenshot 2.png', 'Screenshot 10.png']);
  });

  await t.test('id is the final tie-break', () => {
    const items = [
      makeItem({ id: 2, relPath: 'Bilder/same.jpg', takenAt: '2024-01-01T00:00:00' }),
      makeItem({ id: 1, relPath: 'Bilder/same.jpg', takenAt: '2024-01-01T00:00:00' }),
    ];
    const view = buildGalleryView({ key: '', items, folders: [] });
    assert.deepEqual(view.items.map((i) => i.id), [1, 2]);
  });

  await t.test('item name is the last path segment of relPath', () => {
    const row = makeItem({ relPath: 'Bilder/Urlaub 2024/Italien/IMG_0412.jpg' });
    const view = buildGalleryView({ key: 'Urlaub 2024/Italien', items: [row], folders: [] });
    assert.equal(view.items[0].name, 'IMG_0412.jpg');
  });
});

test('buildGalleryView folder sort', async (t) => {
  await t.test('folders sort by the natural, case-insensitive collator on name', () => {
    const folders = [
      { key: 'Zebra', name: 'Zebra', count: 1, coverRow: null },
      { key: 'apple', name: 'apple', count: 1, coverRow: null },
      { key: 'Banane 10', name: 'Banane 10', count: 1, coverRow: null },
      { key: 'Banane 2', name: 'Banane 2', count: 1, coverRow: null },
    ];
    const view = buildGalleryView({ key: '', items: [], folders });
    assert.deepEqual(
      view.folders.map((f) => f.name),
      ['apple', 'Banane 2', 'Banane 10', 'Zebra'],
    );
  });

  await t.test('folders tie-break on key (binary) when names collate equal', () => {
    const folders = [
      { key: 'B/x', name: 'Ordner', count: 1, coverRow: null },
      { key: 'A/x', name: 'Ordner', count: 2, coverRow: null },
    ];
    const view = buildGalleryView({ key: '', items: [], folders });
    assert.deepEqual(
      view.folders.map((f) => f.key),
      ['A/x', 'B/x'],
    );
  });
});

test('buildGalleryView folder cover', async (t) => {
  await t.test('a cover follows the same thumb-marker rules as an item', () => {
    const coverRow = makeItem({
      id: 42,
      ...freshThumbFields(),
      orientation: 3,
      mtimeMs: 1700000000000,
    });
    const view = buildGalleryView({
      key: '',
      items: [],
      folders: [{ key: 'a', name: 'a', count: 1, coverRow }],
    });
    assert.deepEqual(view.folders[0].cover, {
      id: 42,
      thumb: 'embedded',
      thumbOrientation: 3,
      version: 1700000000000,
    });
  });

  await t.test('no cover row means no cover', () => {
    const view = buildGalleryView({
      key: '',
      items: [],
      folders: [{ key: 'b', name: 'b', count: 0, coverRow: null }],
    });
    assert.equal(view.folders[0].cover, null);
  });
});

test('buildGalleryView never contains a URL string', () => {
  const row = makeItem({ id: 1, ...freshThumbFields() });
  const view = buildGalleryView({
    key: 'a',
    items: [row],
    folders: [{ key: 'a/b', name: 'b', count: 1, coverRow: row }],
  });
  const json = JSON.stringify(view);
  assert.doesNotMatch(json, /\/media\//);
  assert.doesNotMatch(json, /https?:\/\//);
});

test('version equals mtimeMs for both items and folder covers', () => {
  const row = makeItem({ mtimeMs: 123456 });
  const view = buildGalleryView({
    key: '',
    items: [row],
    folders: [{ key: 'x', name: 'x', count: 1, coverRow: row }],
  });
  assert.equal(view.items[0].version, 123456);
  assert.equal(view.folders[0].cover?.version, 123456);
});
