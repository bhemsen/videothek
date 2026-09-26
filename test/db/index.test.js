import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate as migrateDirect } from '../../src/db/migrate.js';
import { migrate, openDatabase, ping } from '../../src/db/index.js';

/** @returns {string} a fresh temp directory, removed by the caller */
function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'videothek-db-'));
}

test('openDatabase creates the data dir (incl. missing parents) and the db file', () => {
  const root = makeTempDir();
  const dataDir = join(root, 'nested', 'data');
  const db = openDatabase(dataDir);
  try {
    assert.ok(existsSync(join(dataDir, 'videothek.db')));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('openDatabase applies the required connection pragmas', () => {
  const dataDir = makeTempDir();
  const db = openDatabase(dataDir);
  try {
    assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
    assert.equal(db.prepare('PRAGMA busy_timeout').get()?.timeout, 5000);
    // synchronous: OFF=0, NORMAL=1, FULL=2, EXTRA=3
    assert.equal(db.prepare('PRAGMA synchronous').get()?.synchronous, 1);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('ping returns true for a healthy open database', () => {
  const dataDir = makeTempDir();
  const db = openDatabase(dataDir);
  try {
    assert.equal(ping(db), true);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('ping returns false instead of throwing once the database is closed', () => {
  const dataDir = makeTempDir();
  const db = openDatabase(dataDir);
  db.close();
  assert.equal(ping(db), false);
  rmSync(dataDir, { recursive: true, force: true });
});

test('index.js re-exports migrate from migrate.js', () => {
  assert.equal(migrate, migrateDirect);
});
