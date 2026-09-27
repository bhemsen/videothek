import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations');
const FILENAME_PATTERN = /^(\d{3})-[a-z0-9-]+\.sql$/;

test('migrate(db) on a clean database applies every NNN-*.sql file present in src/db/migrations', () => {
  const expectedVersions = readdirSync(MIGRATIONS_DIR)
    .map((entry) => FILENAME_PATTERN.exec(entry))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);
  assert.ok(expectedVersions.length > 0, 'sanity: the migrations directory is not empty');

  const db = new DatabaseSync(':memory:');
  try {
    assert.deepEqual(migrate(db), expectedVersions);
    assert.deepEqual(
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version),
      expectedVersions
    );
  } finally {
    db.close();
  }
});
