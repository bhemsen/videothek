import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate, MigrationError } from '../../src/db/migrate.js';

/** @returns {string} a fresh temp migrations directory, removed by the caller */
function makeMigrationsDir() {
  return mkdtempSync(join(tmpdir(), 'videothek-migrations-'));
}

/**
 * @param {string} dir
 * @param {string} filename
 * @param {string} sql
 */
function writeMigration(dir, filename, sql) {
  writeFileSync(join(dir, filename), sql, 'utf8');
}

/** @returns {{ info: (event: string, fields?: object) => void, calls: { event: string, fields?: object }[] }} */
function createRecordingLogger() {
  /** @type {{ event: string, fields?: object }[]} */
  const calls = [];
  return { calls, info: (event, fields) => calls.push({ event, fields }) };
}

test('applies every migration ascending and records schema_migrations', () => {
  const dir = makeMigrationsDir();
  writeMigration(dir, '001-create-a.sql', 'CREATE TABLE a (id INTEGER);');
  writeMigration(dir, '002-create-b.sql', 'CREATE TABLE b (id INTEGER);');
  const db = new DatabaseSync(':memory:');
  const log = createRecordingLogger();

  try {
    const applied = migrate(db, { dir, log });

    assert.deepEqual(applied, [1, 2]);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").get()?.name, 'a');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").get()?.name, 'b');
    assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n, 2);
    assert.deepEqual(
      log.calls.map((c) => c.fields),
      [
        { version: 1, name: 'create-a' },
        { version: 2, name: 'create-b' },
      ]
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-running migrate is idempotent', () => {
  const dir = makeMigrationsDir();
  writeMigration(dir, '001-create-a.sql', 'CREATE TABLE a (id INTEGER);');
  const db = new DatabaseSync(':memory:');

  try {
    migrate(db, { dir });
    const second = migrate(db, { dir });

    assert.deepEqual(second, []);
    assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applies a gap below the highest already-applied version', () => {
  const dir = makeMigrationsDir();
  writeMigration(dir, '001-create-a.sql', 'CREATE TABLE a (id INTEGER);');
  writeMigration(dir, '003-create-c.sql', 'CREATE TABLE c (id INTEGER);');
  const db = new DatabaseSync(':memory:');

  try {
    assert.deepEqual(migrate(db, { dir }), [1, 3]);

    writeMigration(dir, '002-create-b.sql', 'CREATE TABLE b (id INTEGER);');
    assert.deepEqual(migrate(db, { dir }), [2]);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").get()?.name, 'b');
    assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n, 3);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a duplicate migration version throws before anything is applied', () => {
  const dir = makeMigrationsDir();
  writeMigration(dir, '004-a.sql', 'CREATE TABLE dup_a (id INTEGER);');
  writeMigration(dir, '004-b.sql', 'CREATE TABLE dup_b (id INTEGER);');
  const db = new DatabaseSync(':memory:');

  try {
    assert.throws(() => migrate(db, { dir }), MigrationError);
    assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n, 0);
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name IN ('dup_a', 'dup_b')").get(),
      undefined
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a migration file name that does not match the pattern throws before anything is applied', () => {
  const dir = makeMigrationsDir();
  writeMigration(dir, '001-create-a.sql', 'CREATE TABLE a (id INTEGER);');
  writeMigration(dir, '005_bad_name.sql', 'CREATE TABLE bad (id INTEGER);');
  const db = new DatabaseSync(':memory:');

  try {
    assert.throws(() => migrate(db, { dir }), MigrationError);
    assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('broken SQL rolls back its own transaction (incl. its schema_migrations row) without undoing earlier ones', () => {
  const dir = makeMigrationsDir();
  writeMigration(dir, '001-create-a.sql', 'CREATE TABLE a (id INTEGER);');
  // Fails partway through its own transaction, after creating `partial`, so
  // there is something for the migration's ROLLBACK to actually undo.
  writeMigration(dir, '002-broken.sql', 'CREATE TABLE partial (id INTEGER); THIS IS NOT VALID SQL;');
  const db = new DatabaseSync(':memory:');

  try {
    assert.throws(() => migrate(db, { dir }), MigrationError);
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").get()?.name, 'a');
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").get(),
      undefined
    );
    assert.deepEqual(
      db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version),
      [1]
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('003-progress.sql applies whether or not 002 was applied first (references only users)', () => {
  const dir = makeMigrationsDir();
  copyFileSync('src/db/migrations/001-users-sessions.sql', join(dir, '001-users-sessions.sql'));
  copyFileSync('src/db/migrations/003-progress.sql', join(dir, '003-progress.sql'));
  const db = new DatabaseSync(':memory:');
  try {
    assert.deepEqual(migrate(db, { dir }), [1, 3]);
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'progress'").get()?.name,
      'progress'
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('003 still applies after a higher version is already recorded (gap); re-run is a no-op', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT`
    );
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (5, ?, 0)').run('future');

    assert.deepEqual(migrate(db), [1, 2, 3, 4], 'gap below the already-recorded version 5 is filled');
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'progress'").get()?.name,
      'progress'
    );
    assert.deepEqual(migrate(db), [], 're-running migrate applies nothing');
  } finally {
    db.close();
  }
});

test('a migration whose SQL succeeds but whose schema_migrations insert fails rolls back the SQL changes too', () => {
  const dir = makeMigrationsDir();
  writeMigration(dir, '001-create-a.sql', 'CREATE TABLE a (id INTEGER);');
  // Valid SQL that itself inserts a conflicting schema_migrations row, so the
  // runner's own insertVersion() call fails on the UNIQUE version constraint
  // after the file's statements already ran.
  writeMigration(
    dir,
    '002-conflicting-insert.sql',
    "CREATE TABLE partial (id INTEGER); INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'x', 0);"
  );
  const db = new DatabaseSync(':memory:');

  try {
    assert.throws(() => migrate(db, { dir }), MigrationError);
    assert.equal(db.isTransaction, false);
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").get(),
      undefined
    );
    assert.deepEqual(
      db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version),
      [1]
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
