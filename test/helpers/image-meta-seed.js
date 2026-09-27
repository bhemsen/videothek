import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';

/**
 * Shared seeding fixtures for the `image-meta.js` test suite (split across
 * `test/db/image-meta.test.js` and `test/db/image-meta-folders.test.js`).
 */

export const REAL_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations');

/**
 * Copies the named shipped migration files into a fresh temp directory, so a
 * test controls exactly which migrations exist (independent of sibling
 * migrations such as 003/004 in the shared directory). Caller removes it.
 * @param {string[]} files - file names under `src/db/migrations/`
 * @returns {string} the temp directory
 */
export function makeMigrationsDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'videothek-image-meta-migrations-'));
  for (const file of files) copyFileSync(join(REAL_MIGRATIONS_DIR, file), join(dir, file));
  return dir;
}

export const IMAGE_META_MIGRATIONS = ['001-users-sessions.sql', '002-library.sql', '005-image-meta.sql'];

/** @returns {import('node:sqlite').DatabaseSync} an in-memory DB with exactly 001+002+005 applied, FKs on */
export function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const dir = makeMigrationsDir(IMAGE_META_MIGRATIONS);
  try {
    migrate(db, { dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return db;
}

let nextRelPath = 0;
const INSERT_ITEM_SQL = `INSERT INTO library_items (
  rel_path, dir, category, kind, ext, title, sort_title, playable, size, mtime_ms,
  scan_version, added_at, scanned_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1)`;

/**
 * Inserts a `library_items` row directly (every NOT NULL column of 002
 * filled), the way the sync/API tests seed the library without the scanner.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Partial<{ rel_path: string, dir: string, category: string, kind: string, ext: string,
 *   playable: number, size: number, mtime_ms: number }>} overrides
 * @returns {number} the inserted row's id
 */
export function insertItem(db, overrides = {}) {
  const it = {
    rel_path: `Bilder/img-${nextRelPath++}.jpg`,
    dir: 'Bilder',
    category: 'images',
    kind: 'image',
    ext: 'jpg',
    playable: 1,
    size: 1000,
    mtime_ms: 1_700_000_000_000,
    ...overrides,
  };
  const result = db
    .prepare(INSERT_ITEM_SQL)
    .run(it.rel_path, it.dir, it.category, it.kind, it.ext, it.rel_path, it.rel_path, it.playable, it.size, it.mtime_ms);
  return Number(result.lastInsertRowid);
}
