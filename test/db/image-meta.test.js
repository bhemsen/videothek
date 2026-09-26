import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import {
  listItemsWithoutMeta,
  insertMetaStubs,
  listStaleMeta,
  saveMeta,
  folderExists,
  listFolderItems,
  listSubtreeFolderCounts,
  findFolderCover,
  getThumbSource,
} from '../../src/db/image-meta.js';

/** @returns {import('node:sqlite').DatabaseSync} an in-memory DB with 001+002+005 applied, FKs on */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

let nextRelPath = 0;
const INSERT_ITEM_SQL = `INSERT INTO library_items (
  rel_path, dir, category, kind, ext, title, sort_title, playable, size, mtime_ms,
  scan_version, added_at, scanned_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1)`;

/**
 * Inserts a `library_items` row directly (every NOT NULL column of 002
 * filled), the way the sync/API tests seed the library without the scanner.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Partial<{ rel_path: string, dir: string, category: string, kind: string, ext: string,
 *   playable: number, size: number, mtime_ms: number }>} overrides
 * @returns {number} the inserted row's id
 */
function insertItem(db, overrides = {}) {
  const it = {
    rel_path: `Bilder/img-${nextRelPath++}.jpg`,
    dir: 'Bilder',
    category: 'images',
    kind: 'image',
    ext: 'jpg',
    playable: 1,
    size: 1000,
    mtime_ms: 1_700_000_000_000,
    ...overrides,
  };
  const result = db
    .prepare(INSERT_ITEM_SQL)
    .run(it.rel_path, it.dir, it.category, it.kind, it.ext, it.rel_path, it.rel_path, it.playable, it.size, it.mtime_ms);
  return Number(result.lastInsertRowid);
}

test('005-image-meta.sql applies after 002 (also when 003/004 are absent) and image_meta is STRICT', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.deepEqual(migrate(db), [1, 2, 5]);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'image_meta'").get()?.name, 'image_meta');
    const id = insertItem(db);
    insertMetaStubs(db, [{ itemId: id, folder: '' }]);
    assert.throws(() => {
      db.prepare('UPDATE image_meta SET orientation = ? WHERE item_id = ?').run('not-a-number', id);
    }, 'STRICT rejects a non-coercible value in an INTEGER column');
  } finally {
    db.close();
  }
});

test('insertMetaStubs inserts one stub per row; ON CONFLICT DO NOTHING never overwrites an existing one', () => {
  const db = makeDb();
  try {
    const id1 = insertItem(db);
    const id2 = insertItem(db);
    insertMetaStubs(db, [{ itemId: id1, folder: 'A' }, { itemId: id2, folder: 'B' }]);
    insertMetaStubs(db, []); // no-op, opens no transaction
    assert.deepEqual(
      db.prepare('SELECT item_id, folder, source_size, meta_version FROM image_meta ORDER BY item_id').all().map((r) => ({ ...r })),
      [
        { item_id: id1, folder: 'A', source_size: null, meta_version: null },
        { item_id: id2, folder: 'B', source_size: null, meta_version: null },
      ]
    );
    insertMetaStubs(db, [{ itemId: id1, folder: 'CHANGED' }]);
    assert.equal(db.prepare('SELECT folder FROM image_meta WHERE item_id = ?').get(id1)?.folder, 'A', 'an existing stub is left untouched');
  } finally {
    db.close();
  }
});

test('listItemsWithoutMeta returns images items without a meta row, respecting the category filter and cursor', () => {
  const db = makeDb();
  try {
    const img1 = insertItem(db, { rel_path: 'Bilder/a.jpg' });
    const img2 = insertItem(db, { rel_path: 'Bilder/b.jpg' });
    insertItem(db, { rel_path: 'Filme/a.mp4', dir: 'Filme', category: 'movies', kind: 'video', ext: 'mp4' });
    assert.deepEqual(listItemsWithoutMeta(db, 0, 10).map((r) => r.id), [img1, img2]);
    assert.deepEqual(listItemsWithoutMeta(db, img1, 10).map((r) => r.id), [img2], 'afterId cursor excludes earlier ids');
    assert.equal(listItemsWithoutMeta(db, 0, 1).length, 1, 'limit is respected');
    insertMetaStubs(db, [{ itemId: img1, folder: '' }]);
    assert.deepEqual(listItemsWithoutMeta(db, 0, 10).map((r) => r.id), [img2], 'a stubbed item drops out');
  } finally {
    db.close();
  }
});

test('listStaleMeta flags a row missing a header, then a size, mtime or meta_version mismatch, and clears once fresh', () => {
  const db = makeDb();
  try {
    const id = insertItem(db, { size: 1000, mtime_ms: 111 });
    insertMetaStubs(db, [{ itemId: id, folder: '' }]);
    assert.deepEqual(listStaleMeta(db, 0, 10, 1).map((r) => r.itemId), [id], 'no header yet');
    saveMeta(db, id, { takenAt: null, orientation: null, thumbOffset: null, thumbLength: null, sourceSize: 1000, sourceMtimeMs: 111, metaVersion: 1 });
    assert.deepEqual(listStaleMeta(db, 0, 10, 1), [], 'fresh row is not stale');
    db.prepare('UPDATE library_items SET size = 2000 WHERE id = ?').run(id);
    assert.deepEqual(listStaleMeta(db, 0, 10, 1).map((r) => r.itemId), [id], 'size mismatch is stale');
    db.prepare('UPDATE library_items SET size = 1000, mtime_ms = 222 WHERE id = ?').run(id);
    assert.deepEqual(listStaleMeta(db, 0, 10, 1).map((r) => r.itemId), [id], 'mtime mismatch is stale');
    db.prepare('UPDATE library_items SET mtime_ms = 111 WHERE id = ?').run(id);
    assert.deepEqual(listStaleMeta(db, 0, 10, 1), [], 'fresh again at meta_version 1');
    assert.deepEqual(listStaleMeta(db, 0, 10, 2).map((r) => r.itemId), [id], 'a bumped meta_version is stale');
  } finally {
    db.close();
  }
});

test('saveMeta overwrites every header field of an existing stub', () => {
  const db = makeDb();
  try {
    const id = insertItem(db);
    insertMetaStubs(db, [{ itemId: id, folder: 'A' }]);
    saveMeta(db, id, { takenAt: '2024-07-14T09:14:00', orientation: 6, thumbOffset: 512, thumbLength: 4096, sourceSize: 1000, sourceMtimeMs: 1_700_000_000_000, metaVersion: 1 });
    const row = db.prepare('SELECT * FROM image_meta WHERE item_id = ?').get(id);
    assert.equal(row?.folder, 'A', 'folder is untouched by saveMeta');
    assert.equal(row?.taken_at, '2024-07-14T09:14:00');
    assert.equal(row?.orientation, 6);
    assert.equal(row?.thumb_offset, 512);
    assert.equal(row?.thumb_length, 4096);
    assert.equal(row?.meta_version, 1);
  } finally {
    db.close();
  }
});

test('deleting a library_items row cascades to its image_meta row', () => {
  const db = makeDb();
  try {
    const id = insertItem(db);
    insertMetaStubs(db, [{ itemId: id, folder: 'A' }]);
    db.prepare('DELETE FROM library_items WHERE id = ?').run(id);
    assert.equal(db.prepare('SELECT * FROM image_meta WHERE item_id = ?').get(id), undefined);
  } finally {
    db.close();
  }
});

test('folderExists: root always exists, exact and subtree matches use exact ranges even with _ and % in names', () => {
  const db = makeDb();
  try {
    assert.equal(folderExists(db, ''), true, 'root exists even in an empty library');
    assert.equal(folderExists(db, 'Urlaub'), false);
    const italien = insertItem(db, { rel_path: 'Bilder/Urlaub/Italien/a.jpg', dir: 'Bilder/Urlaub/Italien' });
    insertMetaStubs(db, [{ itemId: italien, folder: 'Urlaub/Italien' }]);
    assert.equal(folderExists(db, 'Urlaub/Italien'), true, 'exact match');
    assert.equal(folderExists(db, 'Urlaub'), true, 'ancestor exists via the subtree range');
    assert.equal(folderExists(db, 'Urlaub/Ital'), false, 'a prefix that is not a real segment does not match');
    const extra = insertItem(db, { rel_path: 'Bilder/Urlaub Extra/b.jpg', dir: 'Bilder/Urlaub Extra' });
    insertMetaStubs(db, [{ itemId: extra, folder: 'Urlaub Extra' }]);
    assert.equal(folderExists(db, 'Urlaub Extra'), true);
    const weird = insertItem(db, { rel_path: 'Bilder/A_B%C/c.jpg', dir: 'Bilder/A_B%C' });
    insertMetaStubs(db, [{ itemId: weird, folder: 'A_B%C' }]);
    assert.equal(folderExists(db, 'A_B%C'), true, 'literal _ and % are matched exactly, not as LIKE wildcards');
    assert.equal(folderExists(db, 'A'), false, 'A_B%C does not start with A/, so A itself does not exist');
  } finally {
    db.close();
  }
});

test('listFolderItems loads only direct children, unsorted, with the full ItemRow shape', () => {
  const db = makeDb();
  try {
    const a1 = insertItem(db, { rel_path: 'Bilder/A/a1.jpg', dir: 'Bilder/A' });
    const a2 = insertItem(db, { rel_path: 'Bilder/A/a2.jpg', dir: 'Bilder/A', kind: 'video', ext: 'mp4', playable: 0 });
    const nested = insertItem(db, { rel_path: 'Bilder/A/Sub/n.jpg', dir: 'Bilder/A/Sub' });
    insertMetaStubs(db, [{ itemId: a1, folder: 'A' }, { itemId: a2, folder: 'A' }, { itemId: nested, folder: 'A/Sub' }]);
    const items = listFolderItems(db, 'A');
    assert.deepEqual(items.map((r) => r.id).sort(), [a1, a2].sort());
    const video = items.find((r) => r.id === a2);
    assert.equal(video?.kind, 'video');
    assert.equal(video?.playable, false, 'playable is boolean, not 0/1');
    const image = items.find((r) => r.id === a1);
    assert.equal(image?.takenAt, null);
    assert.equal(image?.thumbOffset, null);
  } finally {
    db.close();
  }
});

test('listSubtreeFolderCounts aggregates per exact folder below key, root treated as prefix ""', () => {
  const db = makeDb();
  try {
    const y1 = insertItem(db, { rel_path: 'Bilder/X/Y/1.jpg', dir: 'Bilder/X/Y' });
    const y2 = insertItem(db, { rel_path: 'Bilder/X/Y/2.jpg', dir: 'Bilder/X/Y' });
    const z1 = insertItem(db, { rel_path: 'Bilder/X/Z/1.jpg', dir: 'Bilder/X/Z' });
    const direct = insertItem(db, { rel_path: 'Bilder/X/1.jpg', dir: 'Bilder/X' });
    insertMetaStubs(db, [
      { itemId: y1, folder: 'X/Y' },
      { itemId: y2, folder: 'X/Y' },
      { itemId: z1, folder: 'X/Z' },
      { itemId: direct, folder: 'X' },
    ]);
    /** @param {{ folder: string }} a @param {{ folder: string }} b */
    const byFolder = (a, b) => a.folder.localeCompare(b.folder);
    assert.deepEqual(listSubtreeFolderCounts(db, 'X').map((r) => ({ ...r })).sort(byFolder), [
      { folder: 'X/Y', count: 2 },
      { folder: 'X/Z', count: 1 },
    ]);
    assert.deepEqual(listSubtreeFolderCounts(db, '').map((r) => ({ ...r })).sort(byFolder), [
      { folder: 'X', count: 1 },
      { folder: 'X/Y', count: 2 },
      { folder: 'X/Z', count: 1 },
    ]);
  } finally {
    db.close();
  }
});

test('findFolderCover picks the first playable image in (folder, rel_path) binary order across the whole subtree', () => {
  const db = makeDb();
  try {
    const b = insertItem(db, { rel_path: 'Bilder/A/b.jpg', dir: 'Bilder/A' });
    const a = insertItem(db, { rel_path: 'Bilder/A/a.jpg', dir: 'Bilder/A' });
    const nonPlayable = insertItem(db, { rel_path: 'Bilder/A/000.heic', dir: 'Bilder/A', playable: 0 });
    const video = insertItem(db, { rel_path: 'Bilder/A/001.mp4', dir: 'Bilder/A', kind: 'video', ext: 'mp4' });
    const deeper = insertItem(db, { rel_path: 'Bilder/A/Sub/c.jpg', dir: 'Bilder/A/Sub' });
    const sibling = insertItem(db, { rel_path: 'Bilder/A Extra/000.jpg', dir: 'Bilder/A Extra' });
    insertMetaStubs(db, [
      { itemId: b, folder: 'A' },
      { itemId: a, folder: 'A' },
      { itemId: nonPlayable, folder: 'A' },
      { itemId: video, folder: 'A' },
      { itemId: deeper, folder: 'A/Sub' },
      { itemId: sibling, folder: 'A Extra' },
    ]);
    assert.equal(findFolderCover(db, 'A')?.id, a, 'lowest rel_path among playable images in folder A itself wins');
    assert.equal(findFolderCover(db, 'A/Sub')?.id, deeper);
    assert.equal(findFolderCover(db, 'Nope'), null);
  } finally {
    db.close();
  }
});

test('getThumbSource returns pre-check fields for any item, null meta fields before a stub, and null for an unknown id', () => {
  const db = makeDb();
  try {
    assert.equal(getThumbSource(db, 999), null);
    const movie = insertItem(db, { rel_path: 'Filme/a.mp4', dir: 'Filme', category: 'movies', kind: 'video', ext: 'mp4' });
    const movieSource = getThumbSource(db, movie);
    assert.equal(movieSource?.category, 'movies');
    assert.equal(movieSource?.thumbOffset, null, 'no image_meta row exists for a non-images item');
    const img = insertItem(db);
    assert.equal(getThumbSource(db, img)?.thumbOffset, null, 'indexed but not yet synced');
    insertMetaStubs(db, [{ itemId: img, folder: '' }]);
    saveMeta(db, img, { takenAt: null, orientation: 6, thumbOffset: 512, thumbLength: 4096, sourceSize: 1000, sourceMtimeMs: 1_700_000_000_000, metaVersion: 1 });
    const source = getThumbSource(db, img);
    assert.equal(source?.kind, 'image');
    assert.equal(source?.playable, true);
    assert.equal(source?.thumbOffset, 512);
    assert.equal(source?.thumbLength, 4096);
    assert.equal(source?.sourceSize, 1000);
  } finally {
    db.close();
  }
});
