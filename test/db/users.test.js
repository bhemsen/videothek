import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrate } from '../../src/db/index.js';
import {
  insertUser,
  getUserById,
  getUserByUsername,
  listUsers,
  countUsers,
  setPasswordHash,
  setRoleGuarded,
  deleteUserGuarded,
} from '../../src/db/users.js';
import { insertSession, getSessionWithUser } from '../../src/db/sessions.js';

/** @returns {{ db: import('node:sqlite').DatabaseSync, dataDir: string }} a fresh migrated DB */
function makeDb() {
  const dataDir = mkdtempSync(join(tmpdir(), 'videothek-users-'));
  const db = openDatabase(dataDir);
  migrate(db);
  return { db, dataDir };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} username
 * @param {'admin' | 'user'} [role]
 */
function makeUser(db, username, role = 'admin') {
  return insertUser(db, { username, passwordHash: 'hash', role, createdAt: 1000 });
}

test('insertUser returns the inserted row; getUserById/getUserByUsername find it', () => {
  const { db, dataDir } = makeDb();
  try {
    const user = insertUser(db, {
      username: 'alice',
      passwordHash: 'scrypt$x',
      role: 'admin',
      createdAt: 12345,
    });
    assert.equal(user.username, 'alice');
    assert.equal(user.password_hash, 'scrypt$x');
    assert.equal(user.role, 'admin');
    assert.equal(user.created_at, 12345);
    assert.ok(Number.isInteger(user.id));

    assert.deepEqual(getUserById(db, user.id), user);
    assert.deepEqual(getUserByUsername(db, 'alice'), user);
    assert.equal(getUserById(db, user.id + 999), undefined);
    assert.equal(getUserByUsername(db, 'nobody'), undefined);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('insertUser rejects a duplicate username', () => {
  const { db, dataDir } = makeDb();
  try {
    makeUser(db, 'bob');
    assert.throws(() => makeUser(db, 'bob'));
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('listUsers is ordered by username; countUsers matches', () => {
  const { db, dataDir } = makeDb();
  try {
    makeUser(db, 'carol', 'user');
    makeUser(db, 'alice', 'admin');
    makeUser(db, 'bob', 'user');

    assert.deepEqual(
      listUsers(db).map((u) => u.username),
      ['alice', 'bob', 'carol']
    );
    assert.equal(countUsers(db), 3);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('setPasswordHash updates an existing user and reports false for an unknown id', () => {
  const { db, dataDir } = makeDb();
  try {
    const user = makeUser(db, 'dave');

    assert.equal(setPasswordHash(db, user.id, 'new-hash'), true);
    assert.equal(getUserById(db, user.id)?.password_hash, 'new-hash');
    assert.equal(setPasswordHash(db, user.id + 999, 'x'), false);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('setRoleGuarded: not_found for an unknown id', () => {
  const { db, dataDir } = makeDb();
  try {
    assert.equal(setRoleGuarded(db, 999, 'user'), 'not_found');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('setRoleGuarded: refuses to demote the sole admin', () => {
  const { db, dataDir } = makeDb();
  try {
    const admin = makeUser(db, 'sole-admin', 'admin');

    assert.equal(setRoleGuarded(db, admin.id, 'user'), 'last_admin');
    assert.equal(getUserById(db, admin.id)?.role, 'admin');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('setRoleGuarded: allows demoting one of two admins, then refuses the second (concurrent demotion)', () => {
  const { db, dataDir } = makeDb();
  try {
    const a = makeUser(db, 'admin-a', 'admin');
    const b = makeUser(db, 'admin-b', 'admin');

    // First request demotes A while B is still an admin -> succeeds.
    assert.equal(setRoleGuarded(db, a.id, 'user'), 'ok');
    assert.equal(getUserById(db, a.id)?.role, 'user');

    // A second, overlapping request now tries to demote B too. The guard
    // re-reads the just-committed state (not a value cached before A's
    // demotion), so it correctly refuses.
    assert.equal(setRoleGuarded(db, b.id, 'user'), 'last_admin');
    assert.equal(getUserById(db, b.id)?.role, 'admin');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('setRoleGuarded: enforces the last-admin guard across separate connections to the same database', () => {
  const { db: dbA, dataDir } = makeDb();
  const dbB = openDatabase(dataDir);
  try {
    const a = makeUser(dbA, 'conn-admin-a', 'admin');
    const b = makeUser(dbA, 'conn-admin-b', 'admin');

    // Connection A demotes admin A and commits.
    assert.equal(setRoleGuarded(dbA, a.id, 'user'), 'ok');

    // Connection B (a different DatabaseSync handle, standing in for a
    // second concurrent request) sees the committed state and refuses to
    // demote the now-only admin.
    assert.equal(setRoleGuarded(dbB, b.id, 'user'), 'last_admin');
  } finally {
    dbA.close();
    dbB.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('setRoleGuarded: no-op role change (already that role) succeeds even for the sole admin', () => {
  const { db, dataDir } = makeDb();
  try {
    const admin = makeUser(db, 'unchanged', 'admin');
    assert.equal(setRoleGuarded(db, admin.id, 'admin'), 'ok');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('deleteUserGuarded: not_found for an unknown id', () => {
  const { db, dataDir } = makeDb();
  try {
    assert.equal(deleteUserGuarded(db, 999), 'not_found');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('deleteUserGuarded: refuses to delete the sole admin', () => {
  const { db, dataDir } = makeDb();
  try {
    const admin = makeUser(db, 'sole-admin-del', 'admin');

    assert.equal(deleteUserGuarded(db, admin.id), 'last_admin');
    assert.ok(getUserById(db, admin.id));
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('deleteUserGuarded: deletes a non-admin and cascades its sessions', () => {
  const { db, dataDir } = makeDb();
  try {
    makeUser(db, 'the-admin', 'admin');
    const user = makeUser(db, 'plain-user', 'user');
    insertSession(db, { id: 'sess-1', userId: user.id, createdAt: 1, expiresAt: 2 });

    assert.equal(deleteUserGuarded(db, user.id), 'ok');
    assert.equal(getUserById(db, user.id), undefined);
    assert.equal(getSessionWithUser(db, 'sess-1'), undefined);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('deleteUserGuarded: deletes one of two admins, then refuses the last one', () => {
  const { db, dataDir } = makeDb();
  try {
    const a = makeUser(db, 'del-admin-a', 'admin');
    const b = makeUser(db, 'del-admin-b', 'admin');

    assert.equal(deleteUserGuarded(db, a.id), 'ok');
    assert.equal(deleteUserGuarded(db, b.id), 'last_admin');
    assert.ok(getUserById(db, b.id));
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
