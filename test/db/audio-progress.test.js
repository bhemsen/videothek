import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { insertUser } from '../../src/db/users.js';
import { upsertItem } from '../../src/db/library-repo.js';
import { upsertAudioMeta } from '../../src/db/audio-meta-repo.js';
import { upsertProgress } from '../../src/db/progress.js';
import { listAudioProgress, getLatestMusicResume } from '../../src/db/audio-progress.js';

/** @returns {import('node:sqlite').DatabaseSync} an in-memory DB with 001-004 applied and FKs on */
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
    rel_path: 'Musik/Die Beispiele/Unterwegs/01 Titel.mp3',
    dir: 'Musik/Die Beispiele/Unterwegs',
    category: 'music',
    kind: 'audio',
    ext: 'mp3',
    title: 'Titel',
    sort_title: 'titel',
    playable: true,
    size: 1000,
    mtime_ms: 1_700_000_000_000,
    scan_version: 1,
    ...overrides,
  };
}

/**
 * @param {number} itemId
 * @param {Partial<import('../../src/db/audio-meta-repo.js').AudioMetaInput>} overrides
 * @returns {import('../../src/db/audio-meta-repo.js').AudioMetaInput}
 */
function makeAudioMeta(itemId, overrides = {}) {
  return {
    item_id: itemId,
    meta_version: 1,
    source_mtime_ms: 1_700_000_000_000,
    source_size: 1000,
    group_key: 'Musik/Die Beispiele/Unterwegs',
    group_title: 'Unterwegs',
    group_artist: 'Die Beispiele',
    title: 'Titel',
    track_no: 1,
    disc_no: 1,
    tag_artist: 'Die Beispiele',
    tag_album_artist: 'Die Beispiele',
    tag_album: 'Unterwegs',
    tag_year: 2020,
    duration_ms: 120_000,
    tag_format: 'id3v2',
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
    relPath: 'Musik/Die Beispiele/Unterwegs/01 Titel.mp3',
    positionSeconds: 40,
    durationSeconds: 120,
    finished: false,
    updatedAt: 1000,
    ...overrides,
  };
}

test('listAudioProgress returns the joined shape in epoch ms, ordered by item id', () => {
  const db = makeDb();
  try {
    const userId = makeUser(db, 'alice');
    const id = upsertItem(db, makeItem(), 1);
    upsertProgress(
      db,
      makeProgress({ userId, positionSeconds: 40, durationSeconds: 120, finished: false, updatedAt: 1_700_000_000_123 })
    );

    const rows = listAudioProgress(db, userId, 'music');

    assert.deepEqual(rows, [
      { itemId: id, position: 40, duration: 120, finished: 0, updatedAt: 1_700_000_000_123 },
    ]);
  } finally {
    db.close();
  }
});

test('listAudioProgress filters by category and ignores absent items and other users', () => {
  const db = makeDb();
  try {
    const userId = makeUser(db, 'alice');
    const other = makeUser(db, 'bob');
    const musicId = upsertItem(db, makeItem({ rel_path: 'Musik/A.mp3' }), 1);
    const bookId = upsertItem(
      db,
      makeItem({ rel_path: 'Hörbücher/Buch/01.mp3', dir: 'Hörbücher/Buch', category: 'audiobooks' }),
      1
    );
    upsertProgress(db, makeProgress({ userId, relPath: 'Musik/A.mp3', updatedAt: 1 }));
    upsertProgress(
      db,
      makeProgress({ userId, relPath: 'Hörbücher/Buch/01.mp3', updatedAt: 2 })
    );
    upsertProgress(
      db,
      makeProgress({ userId: other, relPath: 'Musik/A.mp3', updatedAt: 3 })
    );
    // No library_items row for this rel_path: must not appear.
    upsertProgress(
      db,
      makeProgress({ userId, relPath: 'Musik/NeverIndexed.mp3', updatedAt: 4 })
    );

    const musicRows = listAudioProgress(db, userId, 'music');
    const bookRows = listAudioProgress(db, userId, 'audiobooks');

    assert.deepEqual(musicRows.map((r) => r.itemId), [musicId]);
    assert.deepEqual(bookRows.map((r) => r.itemId), [bookId]);
  } finally {
    db.close();
  }
});

test('listAudioProgress includes finished and non-playable rows (no filter besides category)', () => {
  const db = makeDb();
  try {
    const userId = makeUser(db, 'alice');
    const finishedId = upsertItem(db, makeItem({ rel_path: 'Musik/Finished.mp3' }), 1);
    const notPlayableId = upsertItem(
      db,
      makeItem({ rel_path: 'Musik/NotPlayable.mp3', playable: false }),
      1
    );
    upsertProgress(
      db,
      makeProgress({ userId, relPath: 'Musik/Finished.mp3', finished: true, updatedAt: 1 })
    );
    upsertProgress(
      db,
      makeProgress({ userId, relPath: 'Musik/NotPlayable.mp3', updatedAt: 2 })
    );

    const rows = listAudioProgress(db, userId, 'music');

    assert.deepEqual(
      rows.map((r) => r.itemId).sort((a, b) => a - b),
      [finishedId, notPlayableId].sort((a, b) => a - b)
    );
  } finally {
    db.close();
  }
});

test('getLatestMusicResume returns a row at or above the threshold, not below it (bound parameter, no literal 30)', () => {
  const db = makeDb();
  try {
    const userId = makeUser(db, 'alice');
    const id = upsertItem(db, makeItem(), 1);
    upsertAudioMeta(db, makeAudioMeta(id));
    upsertProgress(db, makeProgress({ userId, positionSeconds: 40, updatedAt: 1000 }));

    assert.deepEqual(getLatestMusicResume(db, { userId, startThreshold: 30 }), {
      itemId: id,
      groupKey: 'Musik/Die Beispiele/Unterwegs',
      position: 40,
      duration: 120,
      updatedAt: 1000,
    });
    assert.equal(getLatestMusicResume(db, { userId, startThreshold: 45 }), null);
  } finally {
    db.close();
  }
});

test('getLatestMusicResume excludes finished rows', () => {
  const db = makeDb();
  try {
    const userId = makeUser(db, 'alice');
    const id = upsertItem(db, makeItem(), 1);
    upsertAudioMeta(db, makeAudioMeta(id));
    upsertProgress(db, makeProgress({ userId, positionSeconds: 115, finished: true, updatedAt: 1000 }));

    assert.equal(getLatestMusicResume(db, { userId, startThreshold: 30 }), null);
  } finally {
    db.close();
  }
});

test('getLatestMusicResume excludes non-playable items', () => {
  const db = makeDb();
  try {
    const userId = makeUser(db, 'alice');
    const id = upsertItem(db, makeItem({ playable: false }), 1);
    upsertAudioMeta(db, makeAudioMeta(id));
    upsertProgress(db, makeProgress({ userId, positionSeconds: 40, updatedAt: 1000 }));

    assert.equal(getLatestMusicResume(db, { userId, startThreshold: 30 }), null);
  } finally {
    db.close();
  }
});

test('getLatestMusicResume excludes items without an audio_meta row and non-music categories', () => {
  const db = makeDb();
  try {
    const userId = makeUser(db, 'alice');
    const noMetaId = upsertItem(db, makeItem({ rel_path: 'Musik/NoMeta.mp3' }), 1);
    upsertProgress(db, makeProgress({ userId, relPath: 'Musik/NoMeta.mp3', positionSeconds: 40, updatedAt: 1000 }));

    const bookId = upsertItem(
      db,
      makeItem({ rel_path: 'Hörbücher/Buch/01.mp3', dir: 'Hörbücher/Buch', category: 'audiobooks' }),
      1
    );
    upsertAudioMeta(db, makeAudioMeta(bookId, { group_key: 'Hörbücher/Buch' }));
    upsertProgress(
      db,
      makeProgress({ userId, relPath: 'Hörbücher/Buch/01.mp3', positionSeconds: 40, updatedAt: 2000 })
    );

    assert.equal(getLatestMusicResume(db, { userId, startThreshold: 30 }), null);
    assert.ok(noMetaId);
    assert.ok(bookId);
  } finally {
    db.close();
  }
});

test('getLatestMusicResume orders by max updated_at, tie broken by the higher item id', () => {
  const db = makeDb();
  try {
    const userId = makeUser(db, 'alice');
    const older = upsertItem(db, makeItem({ rel_path: 'Musik/Older.mp3' }), 1);
    upsertAudioMeta(db, makeAudioMeta(older, { group_key: 'Musik/Older' }));
    upsertProgress(db, makeProgress({ userId, relPath: 'Musik/Older.mp3', positionSeconds: 40, updatedAt: 500 }));

    const newer = upsertItem(db, makeItem({ rel_path: 'Musik/Newer.mp3' }), 1);
    upsertAudioMeta(db, makeAudioMeta(newer, { group_key: 'Musik/Newer' }));
    upsertProgress(db, makeProgress({ userId, relPath: 'Musik/Newer.mp3', positionSeconds: 40, updatedAt: 1500 }));

    assert.equal(getLatestMusicResume(db, { userId, startThreshold: 30 })?.itemId, newer);

    // Tie on updated_at: the higher library_items id wins.
    const tieA = upsertItem(db, makeItem({ rel_path: 'Musik/TieA.mp3' }), 1);
    upsertAudioMeta(db, makeAudioMeta(tieA, { group_key: 'Musik/TieA' }));
    upsertProgress(db, makeProgress({ userId, relPath: 'Musik/TieA.mp3', positionSeconds: 40, updatedAt: 9000 }));
    const tieB = upsertItem(db, makeItem({ rel_path: 'Musik/TieB.mp3' }), 1);
    upsertAudioMeta(db, makeAudioMeta(tieB, { group_key: 'Musik/TieB' }));
    upsertProgress(db, makeProgress({ userId, relPath: 'Musik/TieB.mp3', positionSeconds: 40, updatedAt: 9000 }));

    assert.ok(tieB > tieA);
    assert.equal(getLatestMusicResume(db, { userId, startThreshold: 30 })?.itemId, tieB);
  } finally {
    db.close();
  }
});

test('getLatestMusicResume isolates users', () => {
  const db = makeDb();
  try {
    const alice = makeUser(db, 'alice');
    const bob = makeUser(db, 'bob');
    const id = upsertItem(db, makeItem(), 1);
    upsertAudioMeta(db, makeAudioMeta(id));
    upsertProgress(db, makeProgress({ userId: alice, positionSeconds: 40, updatedAt: 1000 }));

    assert.equal(getLatestMusicResume(db, { userId: alice, startThreshold: 30 })?.itemId, id);
    assert.equal(getLatestMusicResume(db, { userId: bob, startThreshold: 30 }), null);
  } finally {
    db.close();
  }
});
