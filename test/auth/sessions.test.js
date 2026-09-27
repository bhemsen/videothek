import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDatabase } from '../../src/db/index.js';
import { insertUser } from '../../src/db/users.js';
import { createSessionStore } from '../../src/auth/sessions.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** @returns {{ db: import('node:sqlite').DatabaseSync, dataDir: string }} a fresh migrated DB */
function makeDb() {
  const dataDir = mkdtempSync(join(tmpdir(), 'videothek-session-store-'));
  const db = openDatabase(dataDir);
  migrate(db);
  return { db, dataDir };
}

/**
 * A controllable clock for deterministic expiry/refresh tests.
 * @param {number} [start]
 * @returns {{ now: () => number, advance: (ms: number) => void }}
 */
function fakeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

test('create + resolve round-trip returns the owning user', () => {
  const { db, dataDir } = makeDb();
  try {
    const user = insertUser(db, {
      username: 'alice',
      passwordHash: 'hash',
      role: 'user',
      createdAt: 1000,
    });
    const { now } = fakeClock();
    const store = createSessionStore({ db, now });

    const { token, sessionId, expiresAt } = store.create(user.id);
    assert.equal(expiresAt, now() + 30 * DAY_MS);

    const resolved = store.resolve(token);
    assert.deepEqual(resolved, {
      user: { id: user.id, username: 'alice', role: 'user' },
      sessionId,
      refreshedExpiresAt: null,
    });
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the stored session id is the SHA-256 hex of the token, never the token itself', () => {
  const { db, dataDir } = makeDb();
  try {
    const user = insertUser(db, {
      username: 'bob',
      passwordHash: 'hash',
      role: 'user',
      createdAt: 1000,
    });
    const store = createSessionStore({ db, now: fakeClock().now });

    const { token, sessionId } = store.create(user.id);
    assert.equal(sessionId, createHash('sha256').update(token).digest('hex'));
    assert.notEqual(sessionId, token);

    const row = /** @type {{ id: string }} */ (
      db.prepare('SELECT id FROM sessions').get()
    );
    assert.equal(row.id, sessionId);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('resolve returns null for an unknown token', () => {
  const { db, dataDir } = makeDb();
  try {
    const store = createSessionStore({ db, now: fakeClock().now });
    assert.equal(store.resolve('does-not-exist'), null);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('resolve returns null once the session has expired', () => {
  const { db, dataDir } = makeDb();
  try {
    const user = insertUser(db, {
      username: 'carol',
      passwordHash: 'hash',
      role: 'user',
      createdAt: 1000,
    });
    const { now, advance } = fakeClock();
    const store = createSessionStore({ db, now });
    const { token } = store.create(user.id);

    advance(30 * DAY_MS); // exactly at expiry (inclusive)
    assert.equal(store.resolve(token), null);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('resolve does not refresh a session with 29 days or more remaining', () => {
  const { db, dataDir } = makeDb();
  try {
    const user = insertUser(db, {
      username: 'dave',
      passwordHash: 'hash',
      role: 'user',
      createdAt: 1000,
    });
    const { now, advance } = fakeClock();
    const store = createSessionStore({ db, now });
    const { token, expiresAt } = store.create(user.id);

    advance(DAY_MS - 1000); // just under a day; 29 days + 1s remain
    const resolved = store.resolve(token);
    assert.equal(resolved?.refreshedExpiresAt, null);

    const row = /** @type {{ expires_at: number }} */ (
      db.prepare('SELECT expires_at FROM sessions WHERE id = ?').get(resolved.sessionId)
    );
    assert.equal(row.expires_at, expiresAt);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('resolve refreshes once fewer than 29 days remain, at most once per day', () => {
  const { db, dataDir } = makeDb();
  try {
    const user = insertUser(db, {
      username: 'erin',
      passwordHash: 'hash',
      role: 'user',
      createdAt: 1000,
    });
    const { now, advance } = fakeClock();
    const store = createSessionStore({ db, now });
    const { token } = store.create(user.id);

    advance(DAY_MS + 1000); // just over a day; under 29 days remain
    const first = store.resolve(token);
    assert.equal(first?.refreshedExpiresAt, now() + 30 * DAY_MS);

    // A second resolve moments later must not refresh again (sliding window
    // was just pushed back out to 30 days).
    advance(1000);
    const second = store.resolve(token);
    assert.equal(second?.refreshedExpiresAt, null);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('revoke deletes the session so it no longer resolves', () => {
  const { db, dataDir } = makeDb();
  try {
    const user = insertUser(db, {
      username: 'frank',
      passwordHash: 'hash',
      role: 'user',
      createdAt: 1000,
    });
    const store = createSessionStore({ db, now: fakeClock().now });
    const { token, sessionId } = store.create(user.id);

    store.revoke(sessionId);
    assert.equal(store.resolve(token), null);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('revokeUser deletes every session for a user and returns the count', () => {
  const { db, dataDir } = makeDb();
  try {
    const user = insertUser(db, {
      username: 'grace',
      passwordHash: 'hash',
      role: 'user',
      createdAt: 1000,
    });
    const store = createSessionStore({ db, now: fakeClock().now });
    const a = store.create(user.id);
    const b = store.create(user.id);

    assert.equal(store.revokeUser(user.id), 2);
    assert.equal(store.resolve(a.token), null);
    assert.equal(store.resolve(b.token), null);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('revokeUser with exceptSessionId keeps the caller\'s own current session', () => {
  const { db, dataDir } = makeDb();
  try {
    const user = insertUser(db, {
      username: 'heidi',
      passwordHash: 'hash',
      role: 'user',
      createdAt: 1000,
    });
    const store = createSessionStore({ db, now: fakeClock().now });
    const keep = store.create(user.id);
    const revoke1 = store.create(user.id);
    const revoke2 = store.create(user.id);

    const count = store.revokeUser(user.id, { exceptSessionId: keep.sessionId });
    assert.equal(count, 2);
    assert.ok(store.resolve(keep.token));
    assert.equal(store.resolve(revoke1.token), null);
    assert.equal(store.resolve(revoke2.token), null);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('purgeExpired removes only sessions whose expiry has been reached and returns the count', () => {
  const { db, dataDir } = makeDb();
  try {
    const user = insertUser(db, {
      username: 'ivan',
      passwordHash: 'hash',
      role: 'user',
      createdAt: 1000,
    });
    const { now, advance } = fakeClock();
    const store = createSessionStore({ db, now });
    const expired = store.create(user.id);
    advance(1);
    const stillValid = store.create(user.id);

    advance(30 * DAY_MS - 1); // expired session is now exactly due, stillValid is not yet

    assert.equal(store.purgeExpired(), 1);
    assert.equal(store.resolve(expired.token), null);
    assert.ok(store.resolve(stillValid.token));
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
