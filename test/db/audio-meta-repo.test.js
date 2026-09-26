import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { upsertItem } from '../../src/db/library-repo.js';
import {
  listStaleAudioItems,
  upsertAudioMeta,
  listAudioRows,
  listGroupRows,
  getAudioRow,
} from '../../src/db/audio-meta-repo.js';

const REAL_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations');

// Stand-in for the not-yet-merged Phase 4 progress migration (003, issue
// #51): only its table needs to exist to prove 004 applies the same whether
// or not 003 has run — 004 references only 002's `library_items`.
const SYNTHETIC_PROGRESS_SQL = `
  CREATE TABLE progress (
    user_id INTEGER NOT NULL,
    rel_path TEXT NOT NULL,
    position_seconds INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER,
    finished INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, rel_path)
  ) STRICT;
`;

/**
 * @param {{ withProgress: boolean }} options
 * @returns {string} a fresh temp migrations dir with 001, 002, 004 (and,
 *   when requested, a synthetic 003) copied/written into it
 */
function makeMigrationsDir({ withProgress }) {
  const dir = mkdtempSync(join(tmpdir(), 'videothek-audio-meta-migrations-'));
  copyFileSync(join(REAL_MIGRATIONS_DIR, '001-users-sessions.sql'), join(dir, '001-users-sessions.sql'));
  copyFileSync(join(REAL_MIGRATIONS_DIR, '002-library.sql'), join(dir, '002-library.sql'));
  if (withProgress) {
    writeFileSync(join(dir, '003-progress.sql'), SYNTHETIC_PROGRESS_SQL, 'utf8');
  }
  copyFileSync(join(REAL_MIGRATIONS_DIR, '004-audio-meta.sql'), join(dir, '004-audio-meta.sql'));
  return dir;
}

for (const withProgress of [false, true]) {
  test(`004-audio-meta.sql applies on a DB at 002 ${withProgress ? 'with' : 'without'} 003`, () => {
    const dir = makeMigrationsDir({ withProgress });
    const db = new DatabaseSync(':memory:');
    try {
      const applied = migrate(db, { dir });
      assert.deepEqual(applied, withProgress ? [1, 2, 3, 4] : [1, 2, 4]);
      assert.equal(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'audio_meta'").get()?.name,
        'audio_meta'
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/** @returns {import('node:sqlite').DatabaseSync} an in-memory DB with 001+002(+004) applied and FKs on */
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

test('deleting a library_items row cascades to its audio_meta row', () => {
  const db = makeDb();
  try {
    const id = upsertItem(db, makeItem(), 1000);
    upsertAudioMeta(db, makeAudioMeta(id));
    assert.ok(db.prepare('SELECT * FROM audio_meta WHERE item_id = ?').get(id));

    db.prepare('DELETE FROM library_items WHERE id = ?').run(id);

    assert.equal(db.prepare('SELECT * FROM audio_meta WHERE item_id = ?').get(id), undefined);
  } finally {
    db.close();
  }
});

test('upsertAudioMeta inserts then updates the same item_id row via ON CONFLICT', () => {
  const db = makeDb();
  try {
    const id = upsertItem(db, makeItem(), 1000);
    upsertAudioMeta(db, makeAudioMeta(id, { title: 'Erste Version', duration_ms: 1000 }));
    upsertAudioMeta(db, makeAudioMeta(id, { title: 'Zweite Version', duration_ms: 2000 }));

    const row = db.prepare('SELECT * FROM audio_meta WHERE item_id = ?').get(id);
    assert.equal(row?.title, 'Zweite Version');
    assert.equal(row?.duration_ms, 2000);
    assert.equal(db.prepare('SELECT count(*) AS n FROM audio_meta').get()?.n, 1);
  } finally {
    db.close();
  }
});

test('upsertAudioMeta stores omitted nullable fields as null, and rejects a bad tag_format', () => {
  const db = makeDb();
  try {
    const id = upsertItem(db, makeItem({ rel_path: 'Musik/Unbekannt/Ohne Tags/01.m4a', ext: 'm4a' }), 1000);
    upsertAudioMeta(db, { item_id: id, meta_version: 1, source_mtime_ms: 1000, source_size: 1000, group_key: 'Musik/Unbekannt/Ohne Tags', title: '01', disc_no: 1 });

    const row = db.prepare('SELECT * FROM audio_meta WHERE item_id = ?').get(id);
    assert.equal(row?.group_title, null);
    assert.equal(row?.tag_format, null);
    assert.equal(row?.duration_ms, null);
    assert.throws(() =>
      upsertAudioMeta(db, makeAudioMeta(id, { tag_format: /** @type {'flac'} */ ('mp4') }))
    );
  } finally {
    db.close();
  }
});

test('listStaleAudioItems selects missing, version-bumped, size-changed and mtime-changed rows, skipping up-to-date ones', () => {
  const db = makeDb();
  try {
    const missing = upsertItem(db, makeItem({ rel_path: 'Musik/A.mp3' }), 1000);
    const current = upsertItem(db, makeItem({ rel_path: 'Musik/B.mp3' }), 1000);
    upsertAudioMeta(db, makeAudioMeta(current, { meta_version: 2 }));
    const staleVersion = upsertItem(db, makeItem({ rel_path: 'Musik/C.mp3' }), 1000);
    upsertAudioMeta(db, makeAudioMeta(staleVersion, { meta_version: 1 }));
    const staleSize = upsertItem(db, makeItem({ rel_path: 'Musik/D.mp3', size: 2000 }), 1000);
    upsertAudioMeta(db, makeAudioMeta(staleSize, { meta_version: 2, source_size: 1000 }));
    const staleMtime = upsertItem(db, makeItem({ rel_path: 'Musik/E.mp3', mtime_ms: 1_700_000_002_000 }), 1000);
    upsertAudioMeta(db, makeAudioMeta(staleMtime, { meta_version: 2, source_mtime_ms: 1_700_000_000_000 }));

    const staleIds = listStaleAudioItems(db, 2).map((r) => r.id).sort((a, b) => a - b);

    assert.deepEqual(staleIds, [missing, staleVersion, staleSize, staleMtime].sort((a, b) => a - b));
  } finally {
    db.close();
  }
});

test('listStaleAudioItems only considers music/audiobooks categories', () => {
  const db = makeDb();
  try {
    const movie = upsertItem(
      db,
      makeItem({ rel_path: 'Filme/Film.mp4', dir: 'Filme', category: 'movies', kind: 'video', ext: 'mp4' }),
      1000
    );
    const audiobook = upsertItem(
      db,
      makeItem({ rel_path: 'Hörbücher/Kurzgeschichte.mp3', dir: 'Hörbücher', category: 'audiobooks' }),
      1000
    );

    const staleIds = listStaleAudioItems(db, 1).map((r) => r.id);

    assert.ok(!staleIds.includes(movie));
    assert.ok(staleIds.includes(audiobook));
  } finally {
    db.close();
  }
});

test('listAudioRows returns the joined camelCase shape for one category, excluding pending and other-category items', () => {
  const db = makeDb();
  try {
    const track = upsertItem(db, makeItem(), 1000);
    upsertAudioMeta(db, makeAudioMeta(track));
    const noMetaYet = upsertItem(db, makeItem({ rel_path: 'Musik/NoMeta.mp3' }), 1000);
    const audiobookItem = upsertItem(
      db,
      makeItem({ rel_path: 'Hörbücher/Buch/01.mp3', dir: 'Hörbücher/Buch', category: 'audiobooks' }),
      1000
    );
    upsertAudioMeta(db, makeAudioMeta(audiobookItem, { group_key: 'Hörbücher/Buch' }));

    const rows = listAudioRows(db, 'music');

    assert.deepEqual(rows.map((r) => r.id), [track]);
    assert.ok(!rows.some((r) => r.id === noMetaYet));
    assert.deepEqual(rows[0], {
      id: track,
      relPath: 'Musik/Die Beispiele/Unterwegs/01 Titel.mp3',
      dir: 'Musik/Die Beispiele/Unterwegs',
      category: 'music',
      ext: 'mp3',
      playable: true,
      groupKey: 'Musik/Die Beispiele/Unterwegs',
      groupTitle: 'Unterwegs',
      groupArtist: 'Die Beispiele',
      title: 'Titel',
      trackNo: 1,
      discNo: 1,
      tagArtist: 'Die Beispiele',
      tagAlbumArtist: 'Die Beispiele',
      tagAlbum: 'Unterwegs',
      tagYear: 2020,
      durationMs: 120_000,
    });
  } finally {
    db.close();
  }
});

test('listGroupRows returns every member of one group by group_key, ignoring other groups', () => {
  const db = makeDb();
  try {
    const t1 = upsertItem(db, makeItem({ rel_path: 'Musik/Die Beispiele/Unterwegs/01 Titel.mp3' }), 1000);
    upsertAudioMeta(db, makeAudioMeta(t1, { track_no: 1 }));
    const t2 = upsertItem(db, makeItem({ rel_path: 'Musik/Die Beispiele/Unterwegs/02 Titel.mp3' }), 1000);
    upsertAudioMeta(db, makeAudioMeta(t2, { track_no: 2 }));
    const otherAlbum = upsertItem(
      db,
      makeItem({ rel_path: 'Musik/Klangwerk/Anders/01.mp3', dir: 'Musik/Klangwerk/Anders' }),
      1000
    );
    upsertAudioMeta(db, makeAudioMeta(otherAlbum, { group_key: 'Musik/Klangwerk/Anders' }));

    const rows = listGroupRows(db, 'Musik/Die Beispiele/Unterwegs');

    assert.deepEqual(rows.map((r) => r.id), [t1, t2]);
    assert.ok(rows.every((r) => r.groupKey === 'Musik/Die Beispiele/Unterwegs'));
  } finally {
    db.close();
  }
});

test('getAudioRow returns the joined row for one item id, or undefined when there is none', () => {
  const db = makeDb();
  try {
    const id = upsertItem(db, makeItem(), 1000);
    upsertAudioMeta(db, makeAudioMeta(id));
    const noMetaId = upsertItem(db, makeItem({ rel_path: 'Musik/NoMeta2.mp3' }), 1000);

    assert.equal(getAudioRow(db, id)?.title, 'Titel');
    assert.equal(getAudioRow(db, noMetaId), undefined);
    assert.equal(getAudioRow(db, 999_999), undefined);
  } finally {
    db.close();
  }
});
