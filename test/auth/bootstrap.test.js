import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDatabase } from '../../src/db/index.js';
import { countUsers, getUserByUsername } from '../../src/db/users.js';
import { verifyPassword } from '../../src/auth/password.js';
import { BootstrapError, ensureAdmin } from '../../src/auth/bootstrap.js';

/** @returns {{ db: import('node:sqlite').DatabaseSync, dataDir: string }} a fresh migrated DB */
function makeDb() {
  const dataDir = mkdtempSync(join(tmpdir(), 'videothek-bootstrap-'));
  const db = openDatabase(dataDir);
  migrate(db);
  return { db, dataDir };
}

/** @returns {{ log: import('../../src/log.js').Logger, calls: { level: string, event: string, fields?: Record<string, unknown> }[] }} */
function fakeLog() {
  /** @type {{ level: string, event: string, fields?: Record<string, unknown> }[]} */
  const calls = [];
  return {
    calls,
    log: {
      info: (event, fields) => calls.push({ level: 'info', event, fields }),
      warn: (event, fields) => calls.push({ level: 'warn', event, fields }),
      error: (event, fields) => calls.push({ level: 'error', event, fields }),
    },
  };
}

test('creates the first admin on an empty database and hashes the password', async () => {
  const { db, dataDir } = makeDb();
  try {
    const { log, calls } = fakeLog();

    const result = await ensureAdmin({
      db,
      adminUser: 'Julia',
      adminPassword: 'correct-horse-battery',
      log,
      now: () => 1000,
    });

    assert.equal(result, 'created');
    const user = getUserByUsername(db, 'julia');
    assert.ok(user);
    assert.equal(user?.role, 'admin');
    assert.equal(user?.created_at, 1000);
    assert.ok(await verifyPassword('correct-horse-battery', /** @type {string} */ (user?.password_hash)));

    assert.deepEqual(
      calls.map((c) => c.event),
      ['admin_bootstrapped']
    );
    assert.equal(calls[0].fields?.user, 'julia');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('throws BootstrapError and logs admin_missing when both variables are missing', async () => {
  const { db, dataDir } = makeDb();
  try {
    const { log, calls } = fakeLog();

    await assert.rejects(
      () => ensureAdmin({ db, adminUser: null, adminPassword: null, log, now: () => 1000 }),
      BootstrapError
    );

    assert.equal(countUsers(db), 0);
    assert.deepEqual(
      calls.map((c) => c.event),
      ['admin_missing']
    );
    assert.equal(calls[0].level, 'error');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('throws BootstrapError when the admin username is invalid', async () => {
  const { db, dataDir } = makeDb();
  try {
    const { log } = fakeLog();

    await assert.rejects(
      () =>
        ensureAdmin({
          db,
          adminUser: 'not a valid username!',
          adminPassword: 'correct-horse-battery',
          log,
          now: () => 1000,
        }),
      BootstrapError
    );
    assert.equal(countUsers(db), 0);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('throws BootstrapError when the admin password is too short', async () => {
  const { db, dataDir } = makeDb();
  try {
    const { log } = fakeLog();

    await assert.rejects(
      () => ensureAdmin({ db, adminUser: 'julia', adminPassword: 'short', log, now: () => 1000 }),
      BootstrapError
    );
    assert.equal(countUsers(db), 0);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a second start does not create a second admin, even with the variables set', async () => {
  const { db, dataDir } = makeDb();
  try {
    const { log: firstLog } = fakeLog();
    await ensureAdmin({
      db,
      adminUser: 'julia',
      adminPassword: 'correct-horse-battery',
      log: firstLog,
      now: () => 1000,
    });
    assert.equal(countUsers(db), 1);

    const { log, calls } = fakeLog();
    const result = await ensureAdmin({
      db,
      adminUser: 'julia',
      adminPassword: 'correct-horse-battery',
      log,
      now: () => 2000,
    });

    assert.equal(result, 'skipped');
    assert.equal(countUsers(db), 1);
    assert.deepEqual(
      calls.map((c) => c.event),
      ['admin_env_ignored']
    );
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('skips silently (no admin_env_ignored) when users exist and the variables are unset', async () => {
  const { db, dataDir } = makeDb();
  try {
    const { log: firstLog } = fakeLog();
    await ensureAdmin({
      db,
      adminUser: 'julia',
      adminPassword: 'correct-horse-battery',
      log: firstLog,
      now: () => 1000,
    });

    const { log, calls } = fakeLog();
    const result = await ensureAdmin({
      db,
      adminUser: null,
      adminPassword: null,
      log,
      now: () => 2000,
    });

    assert.equal(result, 'skipped');
    assert.equal(calls.length, 0);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
