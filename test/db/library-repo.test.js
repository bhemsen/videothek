import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import {
  upsertItem,
  deleteItem,
  deleteItemsUnderDir,
  hasItemsUnderDir,
  getItemsByDir,
  upsertSeries,
  deleteOrphanedSeries,
} from '../../src/db/library-repo.js';

/** @returns {import('node:sqlite').DatabaseSync} an in-memory DB with 001+002 applied and FKs on */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/**
 * @param {Partial<import('../../src/db/library-repo.js').LibraryItemInput>} overrides
 * @returns {import('../../src/db/library-repo.js').LibraryItemInput}
 */
function makeItem(overrides = {}) {
  return {
    rel_path: 'Filme/Arrival (2016).mp4',
    dir: 'Filme',
    category: 'movies',
    kind: 'video',
    ext: 'mp4',
    title: 'Arrival',
    sort_title: 'arrival',
    year: 2016,
    playable: true,
    size: 1000,
    mtime_ms: 1_700_000_000_000,
    scan_version: 1,
    ...overrides,
  };
}

test('upsertItem inserts a new row and keeps its id across a size/mtime change', () => {
  const db = makeDb();
  try {
    const id1 = upsertItem(db, makeItem(), 1000);
    const id2 = upsertItem(db, makeItem({ size: 2000, mtime_ms: 1_700_000_001_000 }), 2000);

    assert.equal(id2, id1);
    const row = db.prepare('SELECT * FROM library_items WHERE id = ?').get(id1);
    assert.ok(row);
    assert.equal(row.size, 2000);
    assert.equal(row.mtime_ms, 1_700_000_001_000);
    assert.equal(row.added_at, 1000, 'added_at is set on insert only');
    assert.equal(row.scanned_at, 2000, 'scanned_at is refreshed on every upsert');
    assert.equal(row.playable, 1, 'boolean playable is stored as 0/1');
  } finally {
    db.close();
  }
});

test('deleteItem removes the row and AUTOINCREMENT never reuses its id', () => {
  const db = makeDb();
  try {
    const id1 = upsertItem(db, makeItem(), 1000);
    assert.equal(deleteItem(db, 'Filme/Arrival (2016).mp4'), true);
    assert.equal(db.prepare('SELECT * FROM library_items WHERE id = ?').get(id1), undefined);

    const id2 = upsertItem(db, makeItem({ rel_path: 'Filme/Other.mp4' }), 2000);
    assert.notEqual(id2, id1);
    assert.equal(deleteItem(db, 'Filme/Does-not-exist.mp4'), false);
  } finally {
    db.close();
  }
});

test('deleteItemsUnderDir deletes exactly the subtree, even with _ and % in names', () => {
  const db = makeDb();
  try {
    const keep = upsertItem(db, makeItem({ rel_path: 'Filme/Keep_100%.mp4', dir: 'Filme' }), 1);
    upsertItem(
      db,
      makeItem({ rel_path: 'Filme/Dark (2017)/Staffel 1/Dark_S01E01_100%.mp4', dir: 'Filme/Dark (2017)/Staffel 1' }),
      1
    );
    upsertItem(db, makeItem({ rel_path: 'Filme/Dark (2017)/poster.mp4', dir: 'Filme/Dark (2017)' }), 1);
    // A sibling whose name starts with the same prefix text must survive:
    // rel_path range bounds must not treat "Dark (2017) Extra/…" as under
    // "Dark (2017)".
    const sibling = upsertItem(
      db,
      makeItem({ rel_path: 'Filme/Dark (2017) Extra/file.mp4', dir: 'Filme/Dark (2017) Extra' }),
      1
    );

    const deleted = deleteItemsUnderDir(db, 'Filme/Dark (2017)');

    assert.equal(deleted, 2);
    assert.ok(db.prepare('SELECT id FROM library_items WHERE id = ?').get(keep));
    assert.ok(db.prepare('SELECT id FROM library_items WHERE id = ?').get(sibling));
    const remaining = db
      .prepare('SELECT count(*) AS n FROM library_items WHERE dir LIKE ?')
      .get('Filme/Dark (2017)%');
    assert.ok(remaining);
    assert.equal(remaining.n, 1, 'only the surviving sibling directory remains');
  } finally {
    db.close();
  }
});

test('hasItemsUnderDir reflects rows anywhere under a prefix', () => {
  const db = makeDb();
  try {
    assert.equal(hasItemsUnderDir(db, 'Filme'), false);
    upsertItem(db, makeItem({ rel_path: 'Filme/Sub/a.mp4', dir: 'Filme/Sub' }), 1);
    assert.equal(hasItemsUnderDir(db, 'Filme'), true);
    assert.equal(hasItemsUnderDir(db, 'Serien'), false);
  } finally {
    db.close();
  }
});

test('getItemsByDir loads only the exact directory, not its subdirectories', () => {
  const db = makeDb();
  try {
    upsertItem(db, makeItem({ rel_path: 'Filme/a.mp4', dir: 'Filme' }), 1);
    upsertItem(db, makeItem({ rel_path: 'Filme/b.mp4', dir: 'Filme' }), 1);
    upsertItem(db, makeItem({ rel_path: 'Filme/Sub/c.mp4', dir: 'Filme/Sub' }), 1);

    const rows = getItemsByDir(db, 'Filme');

    assert.deepEqual(
      rows.map((r) => r.rel_path).sort(),
      ['Filme/a.mp4', 'Filme/b.mp4']
    );
  } finally {
    db.close();
  }
});

test('upsertSeries keeps id and added_at across updates', () => {
  const db = makeDb();
  try {
    const id1 = upsertSeries(db, { series_key: 'Dark', title: 'Dark', sort_title: 'dark', year: 2017 }, 1000);
    const id2 = upsertSeries(
      db,
      { series_key: 'Dark', title: 'Dark', sort_title: 'dark', year: 2018 },
      2000
    );

    assert.equal(id2, id1);
    const row = db.prepare('SELECT * FROM library_series WHERE id = ?').get(id1);
    assert.ok(row);
    assert.equal(row.year, 2018);
    assert.equal(row.added_at, 1000, 'added_at is set on insert only');
  } finally {
    db.close();
  }
});

test('deleteOrphanedSeries removes a series only after its last episode is gone', () => {
  const db = makeDb();
  try {
    const seriesId = upsertSeries(db, { series_key: 'Dark', title: 'Dark', sort_title: 'dark', year: 2017 }, 1);
    upsertItem(
      db,
      makeItem({
        rel_path: 'Serien/Dark/S01E01.mp4',
        dir: 'Serien/Dark',
        category: 'series',
        series_id: seriesId,
        series_title: 'Dark',
        season: 1,
        episode: 1,
      }),
      1
    );
    upsertItem(
      db,
      makeItem({
        rel_path: 'Serien/Dark/S01E02.mp4',
        dir: 'Serien/Dark',
        category: 'series',
        series_id: seriesId,
        series_title: 'Dark',
        season: 1,
        episode: 2,
      }),
      1
    );

    assert.equal(deleteOrphanedSeries(db), 0, 'series still has episodes');
    deleteItem(db, 'Serien/Dark/S01E01.mp4');
    assert.equal(deleteOrphanedSeries(db), 0, 'one episode remains');
    deleteItem(db, 'Serien/Dark/S01E02.mp4');
    assert.equal(deleteOrphanedSeries(db), 1, 'last episode gone');
    assert.equal(db.prepare('SELECT * FROM library_series WHERE id = ?').get(seriesId), undefined);
  } finally {
    db.close();
  }
});

test('deleting an item cascades to a later phase table declared ON DELETE CASCADE', () => {
  const db = makeDb();
  try {
    db.exec(
      `CREATE TABLE test_cascade_child (
         item_id INTEGER PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE,
         note TEXT NOT NULL
       ) STRICT`
    );
    const id = upsertItem(db, makeItem(), 1);
    db.prepare('INSERT INTO test_cascade_child (item_id, note) VALUES (?, ?)').run(id, 'meta');

    deleteItem(db, 'Filme/Arrival (2016).mp4');

    assert.equal(
      db.prepare('SELECT * FROM test_cascade_child WHERE item_id = ?').get(id),
      undefined
    );
  } finally {
    db.close();
  }
});

test('002-library.sql applies after 001 and re-running migrate is a no-op', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const firstRun = migrate(db);
    assert.deepEqual(firstRun, [1, 2, 3, 4]);
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'library_items'").get()?.name,
      'library_items'
    );
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'library_series'").get()?.name,
      'library_series'
    );

    assert.deepEqual(migrate(db), [], 're-running migrate applies nothing');
  } finally {
    db.close();
  }
});
