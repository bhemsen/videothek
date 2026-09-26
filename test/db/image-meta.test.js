import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import {
  listItemsWithoutMeta,
  insertMetaStubs,
  listStaleMeta,
  saveMeta,
  getThumbSource,
} from '../../src/db/image-meta.js';
import { makeDb, insertItem } from '../helpers/image-meta-seed.js';

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
