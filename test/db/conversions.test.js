import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { upsertItem } from '../../src/db/library-repo.js';
import {
  getConversion,
  getFreshConversion,
  enqueueConversion,
  claimNextConversion,
  recordSourceStat,
  publishConversion,
  failConversion,
  failInterruptedConversions,
  getConversionUsage,
} from '../../src/db/conversions.js';

const MIGRATIONS_DIR = 'src/db/migrations';

/** @returns {import('node:sqlite').DatabaseSync} an in-memory DB with every migration applied, FKs on */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** @param {import('node:sqlite').DatabaseSync} db @param {Partial<import('../../src/db/library-repo.js').LibraryItemInput>} overrides @returns {number} the item's id */
function makeItem(db, overrides = {}) {
  return upsertItem(
    db,
    {
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
    },
    1000
  );
}

/** @param {import('node:sqlite').DatabaseSync} db @param {Partial<Parameters<typeof enqueueConversion>[1]>} overrides */
function enqueue(db, overrides = {}) {
  enqueueConversion(db, {
    relPath: 'Filme/Arrival (2016).mkv',
    storageKey: 'a'.repeat(64),
    target: 'web',
    sourceSize: 1000,
    sourceMtimeMs: 1_700_000_000_000,
    now: 1,
    ...overrides,
  });
}

test('getConversion is undefined for an unknown path; enqueueConversion inserts a queued row; re-queueing resets notes, clears error fields, keeps output', () => {
  const db = makeDb();
  try {
    assert.equal(getConversion(db, 'nope'), undefined);

    enqueue(db, { now: 10 });
    let row = getConversion(db, 'Filme/Arrival (2016).mkv');
    assert.equal(row?.status, 'queued');
    assert.equal(row?.target, 'web');
    assert.equal(row?.notes, '[]');
    assert.equal(row?.queued_at, 10);

    // Simulate a finished run with an output and a failure, then re-queue.
    publishConversion(db, { relPath: row.rel_path, outputRel: 'x/web.mp4', outputSize: 5, notes: '["n"]', now: 20 });
    row = getConversion(db, 'Filme/Arrival (2016).mkv');
    assert.equal(row?.notes, '["n"]');

    enqueue(db, { now: 30, sourceSize: 2000, sourceMtimeMs: 1_700_000_002_000 });
    row = getConversion(db, 'Filme/Arrival (2016).mkv');
    assert.equal(row?.status, 'queued');
    assert.equal(row?.notes, '[]', 're-queueing resets notes to []');
    assert.equal(row?.error, null);
    assert.equal(row?.started_at, null);
    assert.equal(row?.finished_at, null);
    assert.equal(row?.source_size, 2000);
    assert.equal(row?.output_rel, 'x/web.mp4', 'a prior output stays until the new run replaces it');
    assert.equal(row?.output_size, 5);
    assert.equal(row?.queued_at, 30);
  } finally {
    db.close();
  }
});

test('claimNextConversion is FIFO by queued_at, ties broken by rel_path, claims at most one row, and also claims rows absent from library_items', () => {
  const db = makeDb();
  try {
    // None of 'b', 'a', 'z' has a library_items row at all, so this also covers
    // claiming a queued row whose rel_path is absent from library_items.
    enqueueConversion(db, { relPath: 'b', storageKey: 'b'.repeat(64), target: 'web', sourceSize: 1, sourceMtimeMs: 1, now: 5 });
    enqueueConversion(db, { relPath: 'a', storageKey: 'c'.repeat(64), target: 'web', sourceSize: 1, sourceMtimeMs: 1, now: 5 });
    enqueueConversion(db, { relPath: 'z', storageKey: 'd'.repeat(64), target: 'web', sourceSize: 1, sourceMtimeMs: 1, now: 1 });

    // 'z' has the smallest queued_at, so it goes first regardless of its path.
    const first = claimNextConversion(db, 100);
    assert.equal(first?.rel_path, 'z');
    assert.equal(first?.status, 'converting');
    assert.equal(first?.started_at, 100);

    // 'a' and 'b' tie on queued_at = 5; the lexicographically smaller path wins.
    assert.equal(claimNextConversion(db, 101)?.rel_path, 'a');
    assert.equal(claimNextConversion(db, 102)?.rel_path, 'b');
    assert.equal(claimNextConversion(db, 103), undefined, 'nothing left to claim');
  } finally {
    db.close();
  }
});

test('recordSourceStat overwrites the recorded source size/mtime; reports false for an unknown path', () => {
  const db = makeDb();
  try {
    enqueue(db);
    assert.equal(recordSourceStat(db, 'Filme/Arrival (2016).mkv', 4000, 9999), true);
    assert.equal(getConversion(db, 'Filme/Arrival (2016).mkv')?.source_size, 4000);
    assert.equal(getConversion(db, 'Filme/Arrival (2016).mkv')?.source_mtime_ms, 9999);
    assert.equal(recordSourceStat(db, 'nope', 1, 1), false);
  } finally {
    db.close();
  }
});

test('publishConversion sets library_items.playable = 1 only for a matching size/mtime, leaving it 0 when the source changed since the recorded stat', () => {
  const db = makeDb();
  try {
    makeItem(db, { size: 1000, mtime_ms: 1_700_000_000_000, playable: false });
    enqueue(db); // records source_size/source_mtime_ms = 1000 / 1_700_000_000_000
    publishConversion(db, { relPath: 'Filme/Arrival (2016).mkv', outputRel: 'key/web.mp4', outputSize: 123, notes: '[]', now: 50 });

    let row = getConversion(db, 'Filme/Arrival (2016).mkv');
    assert.equal(row?.status, 'playable');
    assert.equal(row?.output_rel, 'key/web.mp4');
    let item = db.prepare('SELECT playable FROM library_items WHERE rel_path = ?').get('Filme/Arrival (2016).mkv');
    assert.equal(item?.playable, 1);

    // A second item whose source changes (the scanner re-upserts it) between enqueue and publish.
    makeItem(db, { rel_path: 'changed.mkv', size: 1000, mtime_ms: 1, playable: false });
    enqueueConversion(db, { relPath: 'changed.mkv', storageKey: 'e'.repeat(64), target: 'web', sourceSize: 1000, sourceMtimeMs: 1, now: 1 });
    makeItem(db, { rel_path: 'changed.mkv', size: 2000, mtime_ms: 5, playable: false });
    publishConversion(db, { relPath: 'changed.mkv', outputRel: 'key2/web.mp4', outputSize: 1, notes: '[]', now: 50 });

    row = getConversion(db, 'changed.mkv');
    assert.equal(row?.status, 'playable', 'the row itself still publishes');
    item = db.prepare('SELECT playable FROM library_items WHERE rel_path = ?').get('changed.mkv');
    assert.equal(item?.playable, 0, 'a changed source stays not playable even though the row published');
  } finally {
    db.close();
  }
});

test('failConversion marks the row failed with the given reason', () => {
  const db = makeDb();
  try {
    enqueue(db);
    failConversion(db, { relPath: 'Filme/Arrival (2016).mkv', error: 'converter_unavailable', detail: 'ENOENT', now: 77 });
    const row = getConversion(db, 'Filme/Arrival (2016).mkv');
    assert.equal(row?.status, 'failed');
    assert.equal(row?.error, 'converter_unavailable');
    assert.equal(row?.error_detail, 'ENOENT');
    assert.equal(row?.finished_at, 77);
  } finally {
    db.close();
  }
});

test('failInterruptedConversions touches only converting rows and reports their count', () => {
  const db = makeDb();
  try {
    enqueueConversion(db, { relPath: 'queued-one', storageKey: 'a'.repeat(64), target: 'web', sourceSize: 1, sourceMtimeMs: 1, now: 1 });
    enqueueConversion(db, { relPath: 'converting-one', storageKey: 'b'.repeat(64), target: 'web', sourceSize: 1, sourceMtimeMs: 1, now: 1 });
    enqueueConversion(db, { relPath: 'converting-two', storageKey: 'c'.repeat(64), target: 'web', sourceSize: 1, sourceMtimeMs: 1, now: 1 });
    db.prepare("UPDATE conversions SET status = 'converting', started_at = 5 WHERE rel_path IN ('converting-one', 'converting-two')").run();
    publishConversion(db, { relPath: 'queued-one', outputRel: 'x', outputSize: 1, notes: '[]', now: 9 });
    // queued-one is now 'playable', not 'queued' -> re-queue a fresh untouched one.
    enqueueConversion(db, { relPath: 'still-queued', storageKey: 'd'.repeat(64), target: 'web', sourceSize: 1, sourceMtimeMs: 1, now: 1 });

    const count = failInterruptedConversions(db, 100);

    assert.equal(count, 2);
    assert.equal(getConversion(db, 'converting-one')?.status, 'failed');
    assert.equal(getConversion(db, 'converting-one')?.error, 'interrupted');
    assert.equal(getConversion(db, 'converting-one')?.finished_at, 100);
    assert.equal(getConversion(db, 'converting-two')?.status, 'failed');
    assert.equal(getConversion(db, 'still-queued')?.status, 'queued', 'a queued row is left alone');
    assert.equal(getConversion(db, 'queued-one')?.status, 'playable', 'a playable row is left alone');
  } finally {
    db.close();
  }
});

test('getFreshConversion: only a playable row whose source stat still matches the item counts as fresh', () => {
  const db = makeDb();
  try {
    makeItem(db, { size: 1000, mtime_ms: 1_700_000_000_000 });
    enqueue(db);
    assert.equal(getFreshConversion(db, { rel_path: 'Filme/Arrival (2016).mkv', size: 1000, mtime_ms: 1_700_000_000_000 }), undefined, 'still queued, not playable yet');

    publishConversion(db, { relPath: 'Filme/Arrival (2016).mkv', outputRel: 'key/web.mp4', outputSize: 1, notes: '[]', now: 5 });

    assert.ok(getFreshConversion(db, { rel_path: 'Filme/Arrival (2016).mkv', size: 1000, mtime_ms: 1_700_000_000_000 }));
    assert.equal(
      getFreshConversion(db, { rel_path: 'Filme/Arrival (2016).mkv', size: 999, mtime_ms: 1_700_000_000_000 }),
      undefined,
      'a stale size/mtime is not fresh'
    );
  } finally {
    db.close();
  }
});

test('getConversionUsage sums bytes/count over every published copy, including one whose item has vanished; 0/0 when nothing is published', () => {
  const db = makeDb();
  try {
    assert.deepEqual(getConversionUsage(db), { bytes: 0, count: 0 });

    makeItem(db, { rel_path: 'a.mkv', size: 10, mtime_ms: 1 });
    enqueueConversion(db, { relPath: 'a.mkv', storageKey: 'a'.repeat(64), target: 'web', sourceSize: 10, sourceMtimeMs: 1, now: 1 });
    publishConversion(db, { relPath: 'a.mkv', outputRel: 'a/web.mp4', outputSize: 100, notes: '[]', now: 2 });

    // A row whose item was never indexed (or has since been deleted) still counts.
    enqueueConversion(db, { relPath: 'vanished.mkv', storageKey: 'b'.repeat(64), target: 'web', sourceSize: 20, sourceMtimeMs: 1, now: 1 });
    publishConversion(db, { relPath: 'vanished.mkv', outputRel: 'b/web.mp4', outputSize: 250, notes: '[]', now: 2 });

    // A queued row with no output yet must not count.
    enqueueConversion(db, { relPath: 'still-queued.mkv', storageKey: 'c'.repeat(64), target: 'web', sourceSize: 1, sourceMtimeMs: 1, now: 1 });

    assert.deepEqual(getConversionUsage(db), { bytes: 350, count: 2 });
  } finally {
    db.close();
  }
});

/** @returns {string} a fresh temp migrations directory, removed by the caller */
function makeMigrationsDir() {
  return mkdtempSync(join(tmpdir(), 'videothek-conversions-migrations-'));
}

/** @param {string} dir @param {...string} names migration filenames to copy from the real migrations dir */
function copyMigrations(dir, ...names) {
  for (const name of names) copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
}

test('006-conversions.sql applies on a DB already at 005; re-running it is a no-op', () => {
  const dir = makeMigrationsDir();
  const all = readdirSync(MIGRATIONS_DIR).filter((f) => f <= '005-image-meta.sql');
  copyMigrations(dir, ...all);
  const db = new DatabaseSync(':memory:');
  try {
    assert.deepEqual(migrate(db, { dir }), [1, 2, 3, 4, 5]);

    copyMigrations(dir, '006-conversions.sql');
    assert.deepEqual(migrate(db, { dir }), [6]);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'conversions'").get()?.name, 'conversions');
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'conversions_queue'").get()?.name,
      'conversions_queue'
    );

    assert.deepEqual(migrate(db, { dir }), [], 're-running 006 is a no-op');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('006-conversions.sql applies as a gap below an already-recorded higher version', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT'
    );
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (99, ?, 0)').run('future');

    const applied = migrate(db); // default dir: the real migrations, 006 included
    assert.equal(applied.includes(6), true, '006 is applied despite a higher recorded version');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'conversions'").get()?.name, 'conversions');

    assert.deepEqual(migrate(db), [], 're-running migrate applies nothing further');
  } finally {
    db.close();
  }
});
