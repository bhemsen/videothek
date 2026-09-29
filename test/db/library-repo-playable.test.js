/**
 * Tests for the effective `playable` flag computed by `UPSERT_ITEM_SQL`
 * (`src/db/library-repo.js`): `item.playable` (direct play) OR a fresh
 * `conversions` row (`status = 'playable'`, matching `source_size`/
 * `source_mtime_ms`). Conversion rows are inserted with a raw SQL statement
 * here, not via `src/db/conversions.js`, so these tests exercise only
 * `upsertItem`'s own SQL — `src/db/conversions.js` has its own tests
 * (`test/db/conversions.test.js`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { upsertItem, deleteItem } from '../../src/db/library-repo.js';

/** @returns {import('node:sqlite').DatabaseSync} an in-memory DB with every migration applied, FKs on */
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
    rel_path: 'Filme/Arrival (2016).mkv',
    dir: 'Filme',
    category: 'movies',
    kind: 'video',
    ext: 'mkv',
    title: 'Arrival',
    sort_title: 'arrival',
    playable: false,
    size: 1000,
    mtime_ms: 1_700_000_000_000,
    scan_version: 1,
    ...overrides,
  };
}

/**
 * Inserts a `conversions` row directly (bypassing `src/db/conversions.js`),
 * so these tests control `status`/`source_size`/`source_mtime_ms`
 * independently of that module's own write paths.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ rel_path?: string, status?: string, source_size?: number, source_mtime_ms?: number }} overrides
 */
function insertConversion(db, overrides = {}) {
  const row = {
    rel_path: 'Filme/Arrival (2016).mkv',
    storage_key: 'a'.repeat(64),
    target: 'web',
    status: 'playable',
    source_size: 1000,
    source_mtime_ms: 1_700_000_000_000,
    queued_at: 1,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO conversions (rel_path, storage_key, target, status, source_size, source_mtime_ms, queued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(row.rel_path, row.storage_key, row.target, row.status, row.source_size, row.source_mtime_ms, row.queued_at);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @returns {number} 0 or 1
 */
function playableOf(db, id) {
  const row = /** @type {{ playable: number }} */ (
    db.prepare('SELECT playable FROM library_items WHERE id = ?').get(id)
  );
  return row.playable;
}

test('upsertItem: a fresh playable conversion makes an otherwise not-playable source playable', () => {
  const db = makeDb();
  try {
    insertConversion(db);
    const id = upsertItem(db, makeItem(), 1000);
    assert.equal(playableOf(db, id), 1);
  } finally {
    db.close();
  }
});

test('upsertItem: a source that plays directly stays playable with no conversion row at all', () => {
  const db = makeDb();
  try {
    const id = upsertItem(db, makeItem({ playable: true }), 1000);
    assert.equal(playableOf(db, id), 1);
  } finally {
    db.close();
  }
});

test('upsertItem: a changed size falls back to the source flag (0)', () => {
  const db = makeDb();
  try {
    insertConversion(db, { source_size: 1000 });
    const id = upsertItem(db, makeItem({ size: 2000 }), 1000);
    assert.equal(playableOf(db, id), 0);
  } finally {
    db.close();
  }
});

test('upsertItem: a changed mtime falls back to the source flag (0)', () => {
  const db = makeDb();
  try {
    insertConversion(db, { source_mtime_ms: 1_700_000_000_000 });
    const id = upsertItem(db, makeItem({ mtime_ms: 1_700_000_001_000 }), 1000);
    assert.equal(playableOf(db, id), 0);
  } finally {
    db.close();
  }
});

test('upsertItem: a deleted and re-inserted row with the same size/mtime is playable again', () => {
  const db = makeDb();
  try {
    insertConversion(db);
    const id1 = upsertItem(db, makeItem(), 1000);
    assert.equal(deleteItem(db, 'Filme/Arrival (2016).mkv'), true);

    const id2 = upsertItem(db, makeItem(), 2000);

    assert.notEqual(id2, id1, 'a fresh insert after delete gets a new id');
    assert.equal(playableOf(db, id2), 1);
  } finally {
    db.close();
  }
});

test('upsertItem: a failed conversion row does not make the item playable', () => {
  const db = makeDb();
  try {
    insertConversion(db, { status: 'failed' });
    const id = upsertItem(db, makeItem(), 1000);
    assert.equal(playableOf(db, id), 0);
  } finally {
    db.close();
  }
});

test('upsertItem: a queued conversion row does not make the item playable', () => {
  const db = makeDb();
  try {
    insertConversion(db, { status: 'queued' });
    const id = upsertItem(db, makeItem(), 1000);
    assert.equal(playableOf(db, id), 0);
  } finally {
    db.close();
  }
});

test('upsertItem: ON CONFLICT recomputes playable rather than preserving a stale value', () => {
  const db = makeDb();
  try {
    const id1 = upsertItem(db, makeItem(), 1000);
    assert.equal(playableOf(db, id1), 0, 'no conversion row yet, source not playable');

    insertConversion(db);
    const id2 = upsertItem(db, makeItem(), 2000);

    assert.equal(id2, id1, 'same rel_path keeps its id across the rescan');
    assert.equal(playableOf(db, id1), 1, 'a rescan picks up the now-fresh conversion');
  } finally {
    db.close();
  }
});
