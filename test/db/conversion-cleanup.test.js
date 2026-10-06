import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import {
  getConversion,
  enqueueConversion,
  publishConversion,
  cancelQueuedConversion,
} from '../../src/db/conversions.js';

const MIGRATIONS_DIR = 'src/db/migrations';

/** @returns {import('node:sqlite').DatabaseSync} an in-memory DB with every migration applied */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
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

/** @returns {string} a fresh temp migrations directory, removed by the caller */
function makeMigrationsDir() {
  return mkdtempSync(join(tmpdir(), 'videothek-cleanup-migrations-'));
}

/** @param {string} dir @param {...string} names */
function copyMigrations(dir, ...names) {
  for (const name of names) copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
}

test('007-conversion-cleanup.sql applies on a Phase-7 DB; existing rows get sidecars = [] and missing_since = NULL', () => {
  const dir = makeMigrationsDir();
  copyMigrations(dir, ...readdirSync(MIGRATIONS_DIR).filter((f) => f <= '006-conversions.sql'));
  const db = new DatabaseSync(':memory:');
  try {
    assert.deepEqual(migrate(db, { dir }), [1, 2, 3, 4, 5, 6]);
    db.exec(
      `INSERT INTO conversions (rel_path, storage_key, target, status, source_size, source_mtime_ms, queued_at)
       VALUES ('old.mkv', '${'e'.repeat(64)}', 'web', 'queued', 1, 1, 1)`
    );

    copyMigrations(dir, '007-conversion-cleanup.sql');
    assert.deepEqual(migrate(db, { dir }), [7]);
    const row = getConversion(db, 'old.mkv');
    assert.equal(row?.sidecars, '[]');
    assert.equal(row?.missing_since, null);
    assert.deepEqual(migrate(db, { dir }), [], 're-running 007 is a no-op');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enqueueConversion clears missing_since and keeps sidecars until a new publish replaces them', () => {
  const db = makeDb();
  try {
    enqueue(db);
    publishConversion(db, { relPath: 'Filme/Arrival (2016).mkv', outputRel: 'k/web.mp4', outputSize: 1, notes: '[]', sidecars: '["a.vtt"]', now: 5 });
    db.prepare("UPDATE conversions SET missing_since = 99 WHERE rel_path = 'Filme/Arrival (2016).mkv'").run();
    assert.equal(getConversion(db, 'Filme/Arrival (2016).mkv')?.missing_since, 99);

    enqueue(db, { now: 10 });
    const row = getConversion(db, 'Filme/Arrival (2016).mkv');
    assert.equal(row?.missing_since, null);
    assert.equal(row?.sidecars, '["a.vtt"]');
  } finally {
    db.close();
  }
});

test('publishConversion persists the sidecars JSON', () => {
  const db = makeDb();
  try {
    enqueue(db);
    publishConversion(db, { relPath: 'Filme/Arrival (2016).mkv', outputRel: 'k/web.mp4', outputSize: 1, notes: '[]', sidecars: '["a.vtt","b.vtt"]', now: 5 });
    assert.equal(getConversion(db, 'Filme/Arrival (2016).mkv')?.sidecars, '["a.vtt","b.vtt"]');
  } finally {
    db.close();
  }
});

test('cancelQueuedConversion ends only queued rows and reports whether it changed one', () => {
  const db = makeDb();
  try {
    enqueue(db, { relPath: 'q.mkv', storageKey: 'a'.repeat(64) });
    enqueue(db, { relPath: 'c.mkv', storageKey: 'b'.repeat(64) });
    db.prepare("UPDATE conversions SET status = 'converting', started_at = 2 WHERE rel_path = 'c.mkv'").run();

    assert.equal(cancelQueuedConversion(db, { relPath: 'q.mkv', now: 50 }), true);
    const q = getConversion(db, 'q.mkv');
    assert.equal(q?.status, 'failed');
    assert.equal(q?.error, 'cancelled');
    assert.equal(q?.error_detail, null);
    assert.equal(q?.finished_at, 50);

    assert.equal(cancelQueuedConversion(db, { relPath: 'q.mkv', now: 60 }), false, 'already failed');
    assert.equal(cancelQueuedConversion(db, { relPath: 'c.mkv', now: 60 }), false, 'converting is untouched');
    assert.equal(getConversion(db, 'c.mkv')?.status, 'converting');
    assert.equal(cancelQueuedConversion(db, { relPath: 'none.mkv', now: 60 }), false);
  } finally {
    db.close();
  }
});
