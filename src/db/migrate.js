import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const FILENAME_PATTERN = /^(\d{3})-([a-z0-9-]+)\.sql$/;

/**
 * @typedef {{ info(event: string, fields?: Record<string, unknown>): void }} MigrationLogger
 * @typedef {{ version: number, name: string, path: string }} MigrationFile
 */

/** Thrown when a migration file is invalid or fails to apply. */
export class MigrationError extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

/**
 * Reads and validates every `.sql` file in `dir`, returning migration
 * descriptors sorted ascending by version. Throws before any migration is
 * applied when a file name does not match the required pattern or a version
 * number is used twice.
 * @param {string} dir
 * @returns {MigrationFile[]}
 */
function readMigrationFiles(dir) {
  /** @type {Map<number, string>} */
  const seenVersions = new Map();
  /** @type {MigrationFile[]} */
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.sql')) continue;
    const match = FILENAME_PATTERN.exec(entry);
    if (!match) {
      throw new MigrationError(`invalid migration file name: ${entry}`);
    }
    const version = Number(match[1]);
    const name = match[2];
    if (seenVersions.has(version)) {
      throw new MigrationError(
        `duplicate migration version ${match[1]}: ${seenVersions.get(version)} and ${entry}`
      );
    }
    seenVersions.set(version, entry);
    files.push({ version, name, path: join(dir, entry) });
  }
  files.sort((a, b) => a.version - b.version);
  return files;
}

/**
 * Applies every not-yet-applied migration found in `dir`, ascending by
 * version (including gaps below the highest already-applied version), each
 * inside its own `BEGIN IMMEDIATE` transaction that also records the
 * `schema_migrations` row. Rolls back and throws `MigrationError` on the
 * first failure, leaving already-applied migrations committed.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ dir?: string, log?: MigrationLogger }} [options]
 * @returns {number[]} versions applied during this call, ascending
 */
export function migrate(db, { dir = DEFAULT_DIR, log } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT
  `);

  const files = readMigrationFiles(dir);
  const appliedVersions = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version)
  );
  const insertVersion = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
  );

  /** @type {number[]} */
  const applied = [];
  for (const file of files) {
    if (appliedVersions.has(file.version)) continue;
    const sql = readFileSync(file.path, 'utf8');
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec(sql);
      insertVersion.run(file.version, file.name, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // No transaction to roll back, e.g. BEGIN itself failed; the
        // original error below is what matters.
      }
      const versionLabel = String(file.version).padStart(3, '0');
      throw new MigrationError(
        `migration ${versionLabel}-${file.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
    log?.info('migration_applied', { version: file.version, name: file.name });
    applied.push(file.version);
  }
  return applied;
}
