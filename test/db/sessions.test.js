import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrate } from '../../src/db/index.js';
import { insertUser } from '../../src/db/users.js';
import {
  insertSession,
  getSessionWithUser,
  setSessionExpiry,
  deleteSession,
  deleteUserSessions,
  deleteExpiredSessions,
} from '../../src/db/sessions.js';

/** @returns {{ db: import('node:sqlite').DatabaseSync, dataDir: string }} a fresh migrated DB */
function makeDb() {
  const dataDir = mkdtempSync(join(tmpdir(), 'videothek-sessions-'));
  const db = openDatabase(dataDir);
  migrate(db);
  return { db, dataDir };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} username
 */
function makeUser(db, username) {
  return insertUser(db, { username, passwordHash: 'hash', role: 'user', createdAt: 1000 });
}

test('insertSession + getSessionWithUser round-trip', () => {
  const { db, dataDir } = makeDb();
  try {
    const user = makeUser(db, 'alice');
    insertSession(db, { id: 'sess-1', userId: user.id, createdAt: 1000, expiresAt: 5000 });

    assert.deepEqual(getSessionWithUser(db, 'sess-1'), {
      id: 'sess-1',
      expiresAt: 5000,
      user: { id: user.id, username: 'alice', role: 'user' },
    });
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('getSessionWithUser returns undefined for an unknown id', () => {
  const { db, dataDir } = makeDb();
  try {
    assert.equal(getSessionWithUser(db, 'no-such-session'), undefined);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('setSessionExpiry updates the stored expiry', () => {
  const { db, dataDir } = makeDb();
  try {
    const user = makeUser(db, 'bob');
    insertSession(db, { id: 'sess-1', userId: user.id, createdAt: 1000, expiresAt: 5000 });

    setSessionExpiry(db, 'sess-1', 9999);

    assert.equal(getSessionWithUser(db, 'sess-1')?.expiresAt, 9999);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('deleteSession removes the row', () => {
  const { db, dataDir } = makeDb();
  try {
    const user = makeUser(db, 'carol');
    insertSession(db, { id: 'sess-1', userId: user.id, createdAt: 1000, expiresAt: 5000 });

    deleteSession(db, 'sess-1');

    assert.equal(getSessionWithUser(db, 'sess-1'), undefined);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('deleteUserSessions removes every session for a user and returns the count', () => {
  const { db, dataDir } = makeDb();
  try {
    const user = makeUser(db, 'dave');
    const other = makeUser(db, 'erin');
    insertSession(db, { id: 'sess-1', userId: user.id, createdAt: 1, expiresAt: 2 });
    insertSession(db, { id: 'sess-2', userId: user.id, createdAt: 1, expiresAt: 2 });
    insertSession(db, { id: 'sess-other', userId: other.id, createdAt: 1, expiresAt: 2 });

    assert.equal(deleteUserSessions(db, user.id), 2);
    assert.equal(getSessionWithUser(db, 'sess-1'), undefined);
    assert.equal(getSessionWithUser(db, 'sess-2'), undefined);
    assert.ok(getSessionWithUser(db, 'sess-other'));
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('deleteUserSessions with exceptId keeps the excluded session and returns the removed count', () => {
  const { db, dataDir } = makeDb();
  try {
    const user = makeUser(db, 'frank');
    insertSession(db, { id: 'keep-me', userId: user.id, createdAt: 1, expiresAt: 2 });
    insertSession(db, { id: 'revoke-1', userId: user.id, createdAt: 1, expiresAt: 2 });
    insertSession(db, { id: 'revoke-2', userId: user.id, createdAt: 1, expiresAt: 2 });

    assert.equal(deleteUserSessions(db, user.id, 'keep-me'), 2);
    assert.ok(getSessionWithUser(db, 'keep-me'));
    assert.equal(getSessionWithUser(db, 'revoke-1'), undefined);
    assert.equal(getSessionWithUser(db, 'revoke-2'), undefined);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('deleteExpiredSessions purges only sessions whose expiry has been reached', () => {
  const { db, dataDir } = makeDb();
  try {
    const user = makeUser(db, 'grace');
    insertSession(db, { id: 'expired-1', userId: user.id, createdAt: 1, expiresAt: 1000 });
    insertSession(db, { id: 'expired-2', userId: user.id, createdAt: 1, expiresAt: 2000 });
    insertSession(db, { id: 'still-valid', userId: user.id, createdAt: 1, expiresAt: 5000 });

    assert.equal(deleteExpiredSessions(db, 2000), 2);
    assert.equal(getSessionWithUser(db, 'expired-1'), undefined);
    assert.equal(getSessionWithUser(db, 'expired-2'), undefined);
    assert.ok(getSessionWithUser(db, 'still-valid'));
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
