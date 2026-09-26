import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrate } from '../../src/db/index.js';
import { insertUser, getUserById } from '../../src/db/users.js';
import { insertSession, getSessionWithUser } from '../../src/db/sessions.js';
import { verifyPassword } from '../../src/auth/password.js';
import { createLogger } from '../../src/log.js';
import { resetPassword } from '../../src/cli/reset-password.js';

/** @returns {{ db: import('node:sqlite').DatabaseSync, dataDir: string }} a fresh migrated DB */
function makeDb() {
  const dataDir = mkdtempSync(join(tmpdir(), 'videothek-reset-password-'));
  const db = openDatabase(dataDir);
  migrate(db);
  return { db, dataDir };
}

/** @returns {import('../../src/config.js').Config} a fake Config; unused by resetPassword itself */
function fakeConfig() {
  return /** @type {any} */ ({
    mediaRoot: '',
    dataDir: '',
    host: '0.0.0.0',
    port: 8080,
    rescanIntervalMin: 15,
    adminUser: null,
    adminPassword: null,
  });
}

/**
 * A fake non-TTY input that delivers every queued line as ONE chunk on the
 * single `'data'` listener `createPromptReader` attaches for the whole
 * prompt sequence — reproducing exactly what a piped shell does when it
 * flushes several `printf`/`echo` lines together. This is a regression
 * guard: an earlier, non-buffering implementation extracted only the first
 * line from such a chunk and discarded the rest, leaving the second prompt
 * waiting forever on input that would never arrive.
 * @param {string[]} lines
 */
function fakeInput(lines) {
  const emitter = new EventEmitter();
  return {
    isTTY: false,
    setEncoding() {},
    setRawMode() {},
    resume() {},
    pause() {},
    /** @param {string} event @param {(chunk: unknown) => void} listener */
    on(event, listener) {
      emitter.on(event, listener);
      if (event === 'data') {
        const chunk = lines.map((line) => `${line}\n`).join('');
        queueMicrotask(() => emitter.emit('data', chunk));
      }
    },
  };
}

/** @returns {{ write(chunk: string): void, text: string }} */
function fakeOutput() {
  const output = {
    text: '',
    /** @param {string} chunk */
    write(chunk) {
      output.text += chunk;
    },
  };
  return output;
}

/** @returns {{ write(chunk: string): void }} */
function fakeLogStream() {
  return { write() {} };
}

test('success: sets the new hash, revokes every session, prints and logs', async () => {
  const { db, dataDir } = makeDb();
  try {
    const user = insertUser(db, {
      username: 'julia',
      passwordHash: 'scrypt$old',
      role: 'admin',
      createdAt: 1000,
    });
    insertSession(db, { id: 'sess-1', userId: user.id, createdAt: 1, expiresAt: 9999999999999 });
    insertSession(db, { id: 'sess-2', userId: user.id, createdAt: 1, expiresAt: 9999999999999 });

    const logLines = /** @type {unknown[]} */ ([]);
    const out = {
      write(/** @type {string} */ chunk) {
        logLines.push(JSON.parse(chunk));
      },
    };
    const log = createLogger({ out, err: fakeLogStream(), now: () => 0 });
    const output = fakeOutput();

    // normalizeUsername accepts stray whitespace/case; the argument need not
    // match the stored, already-normalized form exactly.
    const code = await resetPassword({
      args: [' Julia '],
      config: fakeConfig(),
      db,
      input: fakeInput(['NewPassw0rd', 'NewPassw0rd']),
      output,
      log,
      isTTY: false,
    });

    assert.equal(code, 0);
    const updated = getUserById(db, user.id);
    assert.equal(await verifyPassword('NewPassw0rd', updated?.password_hash ?? ''), true);
    assert.equal(getSessionWithUser(db, 'sess-1'), undefined);
    assert.equal(getSessionWithUser(db, 'sess-2'), undefined);
    assert.match(output.text, /Passwort für julia gesetzt, 2 Sitzung\(en\) beendet\./);
    assert.deepEqual(logLines, [
      { t: new Date(0).toISOString(), level: 'info', event: 'password_reset', user: 'julia', by: 'cli' },
    ]);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('unknown user: exits 1, reports the name, changes nothing, logs nothing', async () => {
  const { db, dataDir } = makeDb();
  try {
    const log = createLogger({ out: fakeLogStream(), err: fakeLogStream(), now: () => 0 });
    const logged = /** @type {unknown[]} */ ([]);
    log.info = (/** @type {string} */ event) => logged.push(event);
    const output = fakeOutput();

    const code = await resetPassword({
      args: ['ghost'],
      config: fakeConfig(),
      db,
      input: fakeInput([]),
      output,
      log,
      isTTY: false,
    });

    assert.equal(code, 1);
    assert.match(output.text, /Unbekannter Benutzer: ghost/);
    assert.equal(logged.length, 0);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('mismatch: exits 1, reports it, leaves the hash untouched', async () => {
  const { db, dataDir } = makeDb();
  try {
    const user = insertUser(db, {
      username: 'bob',
      passwordHash: 'scrypt$old',
      role: 'user',
      createdAt: 1000,
    });
    const log = createLogger({ out: fakeLogStream(), err: fakeLogStream(), now: () => 0 });
    const output = fakeOutput();

    const code = await resetPassword({
      args: ['bob'],
      config: fakeConfig(),
      db,
      input: fakeInput(['PasswordOne', 'PasswordTwo']),
      output,
      log,
      isTTY: false,
    });

    assert.equal(code, 1);
    assert.match(output.text, /Passwörter stimmen nicht überein\./);
    assert.equal(getUserById(db, user.id)?.password_hash, 'scrypt$old');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('invalid password (too short): exits 1, reports it, leaves the hash untouched', async () => {
  const { db, dataDir } = makeDb();
  try {
    const user = insertUser(db, {
      username: 'carol',
      passwordHash: 'scrypt$old',
      role: 'user',
      createdAt: 1000,
    });
    const log = createLogger({ out: fakeLogStream(), err: fakeLogStream(), now: () => 0 });
    const output = fakeOutput();

    const code = await resetPassword({
      args: ['carol'],
      config: fakeConfig(),
      db,
      input: fakeInput(['short1', 'short1']),
      output,
      log,
      isTTY: false,
    });

    assert.equal(code, 1);
    assert.match(output.text, /Das Passwort muss 8–256 Zeichen lang sein\./);
    assert.equal(getUserById(db, user.id)?.password_hash, 'scrypt$old');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('missing argument: exits 1 and reports usage without touching the db', async () => {
  const { db, dataDir } = makeDb();
  try {
    const log = createLogger({ out: fakeLogStream(), err: fakeLogStream(), now: () => 0 });
    const output = fakeOutput();

    const code = await resetPassword({
      args: [],
      config: fakeConfig(),
      db,
      input: fakeInput([]),
      output,
      log,
      isTTY: false,
    });

    assert.equal(code, 1);
    assert.match(output.text, /Benutzername fehlt/);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
