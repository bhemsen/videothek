// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { upsertItem } from '../../src/db/library-repo.js';
import { emptyStats, addDirStats, sweepPrefix } from '../../src/library/scan-stats.js';

/** @returns {import('node:sqlite').DatabaseSync} */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} relPath @param {string} dir */
function seedItem(db, relPath, dir) {
  upsertItem(
    db,
    { rel_path: relPath, dir, category: 'movies', kind: 'video', ext: 'webm', title: relPath, sort_title: relPath, playable: true, size: 1, mtime_ms: 1, scan_version: 1 },
    1
  );
}

test('emptyStats returns a fresh all-zero ScanStats every call', () => {
  const a = emptyStats();
  assert.deepEqual(a, {
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    failedDirs: 0,
    skippedSymlinks: 0,
    skippedUndecodable: 0,
    protectedRoots: 0,
    durationMs: 0,
  });
  a.added = 5;
  assert.equal(emptyStats().added, 0, 'each call returns an independent object');
});

test('addDirStats accumulates a DirSyncStats part into a running ScanStats total', () => {
  const target = emptyStats();
  target.failedDirs = 2; // fields DirSyncStats does not carry must survive untouched

  addDirStats(target, { added: 1, updated: 2, removed: 3, unchanged: 4, skippedSymlinks: 5, skippedUndecodable: 6 });
  addDirStats(target, { added: 1, updated: 0, removed: 0, unchanged: 0, skippedSymlinks: 0, skippedUndecodable: 0 });

  assert.deepEqual(target, {
    added: 2,
    updated: 2,
    removed: 3,
    unchanged: 4,
    failedDirs: 2,
    skippedSymlinks: 5,
    skippedUndecodable: 6,
    protectedRoots: 0,
    durationMs: 0,
  });
});

test('sweepPrefix deletes rows under unvisited directories, but not visited or protected ones', () => {
  const db = makeDb();
  seedItem(db, 'Filme/Seen/a.webm', 'Filme/Seen');
  seedItem(db, 'Filme/Gone/b.webm', 'Filme/Gone');
  seedItem(db, 'Filme/Failed/c.webm', 'Filme/Failed');
  const stats = emptyStats();

  sweepPrefix(db, 'Filme', new Set(['Filme/Seen']), ['Filme/Failed'], stats);

  assert.equal(stats.removed, 1);
  assert.ok(db.prepare('SELECT 1 FROM library_items WHERE rel_path = ?').get('Filme/Seen/a.webm'), 'a visited dir keeps its rows');
  assert.ok(db.prepare('SELECT 1 FROM library_items WHERE rel_path = ?').get('Filme/Failed/c.webm'), 'a protected prefix keeps its rows');
  assert.equal(db.prepare('SELECT 1 FROM library_items WHERE rel_path = ?').get('Filme/Gone/b.webm'), undefined, 'an unvisited, unprotected dir is swept');
});

test('sweepPrefix never touches a sibling directory whose name merely extends the prefix as text', () => {
  const db = makeDb();
  seedItem(db, 'Filme/Extra/x.webm', 'Filme/Extra');
  seedItem(db, 'Filme2/y.webm', 'Filme2');
  const stats = emptyStats();

  sweepPrefix(db, 'Filme', new Set(), [], stats);

  assert.equal(stats.removed, 1, 'only rows actually under "Filme" are swept');
  assert.ok(db.prepare('SELECT 1 FROM library_items WHERE rel_path = ?').get('Filme2/y.webm'), '"Filme2" is not "Filme"');
});
