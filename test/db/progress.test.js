import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { insertUser } from '../../src/db/users.js';
import { upsertItem, deleteItem } from '../../src/db/library-repo.js';
import {
  getProgressRow,
  upsertProgress,
  deleteProgress,
  listContinueRows,
  listStateRows,
  listSeriesProgressRows,
} from '../../src/db/progress.js';

/** @returns {import('node:sqlite').DatabaseSync} an in-memory DB with 001-003 applied and FKs on */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} username
 * @returns {number}
 */
function makeUser(db, username) {
  return insertUser(db, { username, passwordHash: 'x', role: 'user', createdAt: 1 }).id;
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

/**
 * @param {Partial<import('../../src/db/progress.js').UpsertProgressInput>} overrides
 * @returns {import('../../src/db/progress.js').UpsertProgressInput}
 */
function makeProgress(overrides = {}) {
  return {
    userId: 1,
    relPath: 'Filme/Arrival (2016).mp4',
    positionSeconds: 60,
    durationSeconds: 6000,
    finished: false,
    updatedAt: 1000,
    ...overrides,
  };
}

test('upsertProgress is last-write-wins on (user_id, rel_path)', () => {
  const db = makeDb();
  try {
    const userId = makeUser(db, 'alice');
    upsertProgress(db, makeProgress({ userId, positionSeconds: 60, updatedAt: 1000 }));
    const written = upsertProgress(
      db,
      makeProgress({ userId, positionSeconds: 900, finished: true, updatedAt: 2000 })
    );

    assert.equal(written.position_seconds, 900);
    assert.equal(written.finished, 1);
    const row = getProgressRow(db, userId, 'Filme/Arrival (2016).mp4');
    assert.ok(row);
    assert.equal(row.position_seconds, 900);
    assert.equal(row.duration_seconds, 6000);
    assert.equal(row.finished, 1);
    assert.equal(row.updated_at, 2000);
  } finally {
    db.close();
  }
});

test('getProgressRow returns undefined for no row', () => {
  const db = makeDb();
  try {
    const userId = makeUser(db, 'alice');
    assert.equal(getProgressRow(db, userId, 'Filme/Missing.mp4'), undefined);
  } finally {
    db.close();
  }
});

test('deleteProgress reports whether a row existed', () => {
  const db = makeDb();
  try {
    const userId = makeUser(db, 'alice');
    upsertProgress(db, makeProgress({ userId }));

    assert.equal(deleteProgress(db, userId, 'Filme/Arrival (2016).mp4'), true);
    assert.equal(getProgressRow(db, userId, 'Filme/Arrival (2016).mp4'), undefined);
    assert.equal(deleteProgress(db, userId, 'Filme/Arrival (2016).mp4'), false);
  } finally {
    db.close();
  }
});

test('deleting a library_items row keeps the progress row, which re-attaches under a new id', () => {
  const db = makeDb();
  try {
    const userId = makeUser(db, 'alice');
    const id1 = upsertItem(db, makeItem(), 1);
    upsertProgress(db, makeProgress({ userId, positionSeconds: 500 }));

    deleteItem(db, 'Filme/Arrival (2016).mp4');
    const surviving = getProgressRow(db, userId, 'Filme/Arrival (2016).mp4');
    assert.ok(surviving, 'progress row survives its item vanishing');
    assert.equal(surviving.position_seconds, 500);

    const id2 = upsertItem(db, makeItem(), 2);
    assert.notEqual(id2, id1, 'AUTOINCREMENT never reuses the freed id');
    const rows = listStateRows(db, { userId, categories: ['movies'], startThreshold: 30 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, id2, 'the re-attached row is served under the new id');
    assert.equal(rows[0].position_seconds, 500, 'progress itself was never touched');
  } finally {
    db.close();
  }
});

test('deleting a user deletes their progress rows (ON DELETE CASCADE)', () => {
  const db = makeDb();
  try {
    const alice = makeUser(db, 'alice');
    const bob = makeUser(db, 'bob');
    upsertProgress(db, makeProgress({ userId: alice }));
    upsertProgress(db, makeProgress({ userId: bob }));

    db.prepare('DELETE FROM users WHERE id = ?').run(alice);

    assert.equal(getProgressRow(db, alice, 'Filme/Arrival (2016).mp4'), undefined);
    assert.ok(getProgressRow(db, bob, 'Filme/Arrival (2016).mp4'), "bob's row is untouched");
  } finally {
    db.close();
  }
});

test('listContinueRows honours categories, threshold, playable and presence', () => {
  const db = makeDb();
  try {
    const userId = makeUser(db, 'alice');
    upsertItem(db, makeItem({ rel_path: 'Filme/Started.mp4', category: 'movies', playable: true }), 1);
    upsertItem(
      db,
      makeItem({ rel_path: 'Filme/NotPlayable.mp4', category: 'movies', playable: false }),
      1
    );
    upsertItem(
      db,
      makeItem({ rel_path: 'Musik/Album/Track.mp3', category: 'music', kind: 'audio', playable: true }),
      1
    );
    // Below threshold, finished, non-playable, wrong category, absent item:
    upsertProgress(db, makeProgress({ userId, relPath: 'Filme/Started.mp4', positionSeconds: 60, updatedAt: 100 }));
    upsertProgress(
      db,
      makeProgress({ userId, relPath: 'Filme/BelowThreshold.mp4', positionSeconds: 5, updatedAt: 200 })
    );
    upsertItem(db, makeItem({ rel_path: 'Filme/BelowThreshold.mp4' }), 1);
    upsertProgress(
      db,
      makeProgress({ userId, relPath: 'Filme/NotPlayable.mp4', positionSeconds: 60, updatedAt: 300 })
    );
    upsertProgress(
      db,
      makeProgress({
        userId,
        relPath: 'Filme/Finished.mp4',
        positionSeconds: 5900,
        finished: true,
        updatedAt: 400,
      })
    );
    upsertItem(db, makeItem({ rel_path: 'Filme/Finished.mp4' }), 1);
    upsertProgress(
      db,
      makeProgress({ userId, relPath: 'Musik/Album/Track.mp3', positionSeconds: 60, updatedAt: 500 })
    );
    upsertProgress(
      db,
      makeProgress({ userId, relPath: 'Filme/NeverIndexed.mp4', positionSeconds: 60, updatedAt: 600 })
    );

    const rows = listContinueRows(db, {
      userId,
      categories: ['movies'],
      startThreshold: 30,
      limit: 20,
    });

    assert.deepEqual(rows.map((r) => r.rel_path), ['Filme/Started.mp4']);
  } finally {
    db.close();
  }
});

test('listContinueRows orders newest first and applies limit', () => {
  const db = makeDb();
  try {
    const userId = makeUser(db, 'alice');
    for (const n of [1, 2, 3]) {
      upsertItem(db, makeItem({ rel_path: `Filme/${n}.mp4` }), 1);
      upsertProgress(
        db,
        makeProgress({ userId, relPath: `Filme/${n}.mp4`, positionSeconds: 60, updatedAt: n * 100 })
      );
    }

    const rows = listContinueRows(db, { userId, categories: ['movies'], startThreshold: 30, limit: 2 });

    assert.deepEqual(rows.map((r) => r.rel_path), ['Filme/3.mp4', 'Filme/2.mp4']);
  } finally {
    db.close();
  }
});

test('listStateRows includes finished rows with no threshold floor and excludes non-playable/absent', () => {
  const db = makeDb();
  try {
    const userId = makeUser(db, 'alice');
    upsertItem(db, makeItem({ rel_path: 'Filme/Finished.mp4' }), 1);
    upsertProgress(
      db,
      makeProgress({ userId, relPath: 'Filme/Finished.mp4', positionSeconds: 1, finished: true, updatedAt: 1 })
    );
    upsertItem(db, makeItem({ rel_path: 'Filme/NotPlayable.mp4', playable: false }), 1);
    upsertProgress(
      db,
      makeProgress({ userId, relPath: 'Filme/NotPlayable.mp4', positionSeconds: 60, finished: true, updatedAt: 2 })
    );
    upsertProgress(
      db,
      makeProgress({ userId, relPath: 'Filme/Absent.mp4', positionSeconds: 60, finished: true, updatedAt: 3 })
    );

    const rows = listStateRows(db, { userId, categories: ['movies'], startThreshold: 30 });

    assert.deepEqual(rows.map((r) => r.rel_path), ['Filme/Finished.mp4']);
  } finally {
    db.close();
  }
});

test('listSeriesProgressRows returns only present series-category rows, any state', () => {
  const db = makeDb();
  try {
    const userId = makeUser(db, 'alice');
    upsertItem(
      db,
      makeItem({ rel_path: 'Serien/Dark/S01E01.mp4', category: 'series', season: 1, episode: 1 }),
      1
    );
    upsertItem(db, makeItem({ rel_path: 'Filme/Movie.mp4', category: 'movies' }), 1);
    upsertProgress(
      db,
      makeProgress({ userId, relPath: 'Serien/Dark/S01E01.mp4', positionSeconds: 5, updatedAt: 1 })
    );
    upsertProgress(db, makeProgress({ userId, relPath: 'Filme/Movie.mp4', positionSeconds: 5, updatedAt: 1 }));
    upsertProgress(
      db,
      makeProgress({ userId, relPath: 'Serien/Dark/S01E02.mp4', positionSeconds: 5, updatedAt: 1 })
    );

    const rows = listSeriesProgressRows(db, userId);

    assert.deepEqual(rows.map((r) => r.rel_path), ['Serien/Dark/S01E01.mp4']);
  } finally {
    db.close();
  }
});
