import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('re-running migrate is idempotent', () => {
  const dir = makeMigrationsDir();
  writeMigration(dir, '001-create-a.sql', 'CREATE TABLE a (id INTEGER);');
  const db = new DatabaseSync(':memory:');

  migrate(db, { dir });
  const second = migrate(db, { dir });

  assert.deepEqual(second, []);
  assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n, 1);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('applies a gap below the highest already-applied version', () => {
  const dir = makeMigrationsDir();
  writeMigration(dir, '001-create-a.sql', 'CREATE TABLE a (id INTEGER);');
  writeMigration(dir, '003-create-c.sql', 'CREATE TABLE c (id INTEGER);');
  const db = new DatabaseSync(':memory:');

  assert.deepEqual(migrate(db, { dir }), [1, 3]);

  writeMigration(dir, '002-create-b.sql', 'CREATE TABLE b (id INTEGER);');
  assert.deepEqual(migrate(db, { dir }), [2]);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").get()?.name, 'b');
  assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n, 3);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a duplicate migration version throws before anything is applied', () => {
  const dir = makeMigrationsDir();
  writeMigration(dir, '004-a.sql', 'CREATE TABLE dup_a (id INTEGER);');
  writeMigration(dir, '004-b.sql', 'CREATE TABLE dup_b (id INTEGER);');
  const db = new DatabaseSync(':memory:');

  assert.throws(() => migrate(db, { dir }), MigrationError);
  assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n, 0);
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE name IN ('dup_a', 'dup_b')").get(),
    undefined
  );

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a migration file name that does not match the pattern throws before anything is applied', () => {
  const dir = makeMigrationsDir();
  writeMigration(dir, '001-create-a.sql', 'CREATE TABLE a (id INTEGER);');
  writeMigration(dir, '005_bad_name.sql', 'CREATE TABLE bad (id INTEGER);');
  const db = new DatabaseSync(':memory:');

  assert.throws(() => migrate(db, { dir }), MigrationError);
  assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n, 0);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('broken SQL rolls back its own transaction (incl. its schema_migrations row) without undoing earlier ones', () => {
  const dir = makeMigrationsDir();
  writeMigration(dir, '001-create-a.sql', 'CREATE TABLE a (id INTEGER);');
  writeMigration(dir, '002-broken.sql', 'THIS IS NOT VALID SQL;');
  const db = new DatabaseSync(':memory:');

  assert.throws(() => migrate(db, { dir }), MigrationError);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").get()?.name, 'a');
  assert.deepEqual(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version),
    [1]
  );

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
