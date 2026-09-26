import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export { migrate, MigrationError } from './migrate.js';

/**
 * Opens (creating the data directory and the database file if needed) the
 * single SQLite database used by the app, with the connection pragmas the
 * constitution requires already applied.
 * @param {string} dataDir
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'videothek.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

/**
 * Checks whether the database connection is responsive. Never throws.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
export function ping(db) {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}
