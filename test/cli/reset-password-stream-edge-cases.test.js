/**
 * Regression tests for `createPromptReader`'s handling of an input stream
 * that ends before a full line/keystroke sequence is delivered — split out
 * from `reset-password.test.js` to keep both files under the 300-line limit
 * (constitution.test.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrate } from '../../src/db/index.js';
import { insertUser, getUserById } from '../../src/db/users.js';
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
 * A fake input whose stream ends immediately without ever sending data —
 * reproduces empty/closed stdin (`< /dev/null`, Ctrl+D before typing
 * anything). Regression guard: without an `'end'`/`'close'` handler in
 * `createPromptReader`, the first prompt's `readNext()` promise never
 * settles, the event loop drains anyway, and the process used to exit 0
 * silently instead of reporting a failure.
 */
function fakeEndedInput() {
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
      if (event === 'end') {
        queueMicrotask(() => emitter.emit('end'));
      }
    },
  };
}

/**
 * Like a piped-shell fake input, but the last line has no trailing `\n`
 * before the stream ends — reproduces `printf 'pw\npw'` (no newline after the
 * final answer). Regression guard for the same `'end'` handling as
 * `fakeEndedInput`, but hit via the second prompt's `readNext()` instead of
 * the first.
 * @param {string[]} lines
 */
function fakeInputNoTrailingNewline(lines) {
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
        const withNewlines = lines.slice(0, -1).map((line) => `${line}\n`).join('');
        const chunk = withNewlines + (lines[lines.length - 1] ?? '');
        queueMicrotask(() => emitter.emit('data', chunk));
      }
      if (event === 'end') {
        queueMicrotask(() => emitter.emit('end'));
      }
    },
  };
}

/**
 * A fake TTY input that delivers each queued string as its own `'data'`
 * chunk (so a multi-character chunk exercises the character-by-character
 * loop in `onKeystroke`, e.g. a pasted password ending in `\r`). Records
 * `setRawMode` calls so a test can assert echo is disabled for the whole
 * prompt sequence and restored afterwards. Chunks are sent one per
 * `setImmediate` turn, not back-to-back on the microtask queue: resolving a
 * keystroke's `readNext()` and then calling `readNext()` again for the next
 * prompt takes two microtask hops (through `promptSecret`'s `await` and then
 * `resetPassword`'s), so a same-microtask-queue chunk chain can outrun that
 * and deliver the next prompt's chunk while `waiting` is still unset —
 * something real, human-timed keystrokes (or a paste, which still arrives
 * only after the label for ITS OWN prompt was printed) can never do.
 * `setImmediate` lets the whole microtask queue drain between chunks, like
 * real separate input events would.
 * @param {string[]} chunks
 */
function fakeTtyInput(chunks) {
  const emitter = new EventEmitter();
  const rawModeCalls = /** @type {boolean[]} */ ([]);
  const queue = [...chunks];
  const sendNext = () => {
    const next = queue.shift();
    if (next === undefined) return;
    setImmediate(() => {
      emitter.emit('data', next);
      sendNext();
    });
  };
  return {
    isTTY: true,
    rawModeCalls,
    setEncoding() {},
    /** @param {boolean} mode */
    setRawMode(mode) {
      rawModeCalls.push(mode);
    },
    resume() {},
    pause() {},
    /** @param {string} event @param {(chunk: unknown) => void} listener */
    on(event, listener) {
      emitter.on(event, listener);
      if (event === 'data') sendNext();
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

test('stdin ends before a full password is entered: exits 1 instead of silently succeeding with code 0', async () => {
  const { db, dataDir } = makeDb();
  try {
    const user = insertUser(db, {
      username: 'ended',
      passwordHash: 'scrypt$old',
      role: 'user',
      createdAt: 1000,
    });
    const log = createLogger({ out: fakeLogStream(), err: fakeLogStream(), now: () => 0 });
    const output = fakeOutput();
    const errorOutput = fakeOutput();

    const code = await resetPassword({
      args: ['ended'],
      config: fakeConfig(),
      db,
      input: fakeEndedInput(),
      output,
      errorOutput,
      log,
      isTTY: false,
    });

    assert.equal(code, 1);
    assert.match(errorOutput.text, /Das Passwort muss 8–256 Zeichen lang sein\./);
    assert.equal(getUserById(db, user.id)?.password_hash, 'scrypt$old');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('stdin ends right after an unterminated final line: still reads it instead of hanging', async () => {
  const { db, dataDir } = makeDb();
  try {
    const user = insertUser(db, {
      username: 'noeol',
      passwordHash: 'scrypt$old',
      role: 'user',
      createdAt: 1000,
    });
    const log = createLogger({ out: fakeLogStream(), err: fakeLogStream(), now: () => 0 });
    const output = fakeOutput();
    const errorOutput = fakeOutput();

    // Second line ('short1') has no trailing '\n' before the stream ends —
    // e.g. `printf 'short1\nshort1'`.
    const code = await resetPassword({
      args: ['noeol'],
      config: fakeConfig(),
      db,
      input: fakeInputNoTrailingNewline(['short1', 'short1']),
      output,
      errorOutput,
      log,
      isTTY: false,
    });

    assert.equal(code, 1);
    assert.match(errorOutput.text, /Das Passwort muss 8–256 Zeichen lang sein\./);
    assert.equal(getUserById(db, user.id)?.password_hash, 'scrypt$old');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('TTY: pasted multi-character chunk ending in \\r submits without appending the \\r to the password', async () => {
  const { db, dataDir } = makeDb();
  try {
    const user = insertUser(db, {
      username: 'tty',
      passwordHash: 'scrypt$old',
      role: 'user',
      createdAt: 1000,
    });
    const log = createLogger({ out: fakeLogStream(), err: fakeLogStream(), now: () => 0 });
    const output = fakeOutput();
    const errorOutput = fakeOutput();
    // First prompt: typed keystroke by keystroke with a Backspace correction.
    // Second prompt: pasted as ONE chunk ending in '\r' (the paste bug).
    const input = fakeTtyInput(['NewPassw0rX', '\u007f', 'd', '\r', 'NewPassw0rd\r']);

    const code = await resetPassword({
      args: ['tty'],
      config: fakeConfig(),
      db,
      input,
      output,
      errorOutput,
      log,
      isTTY: true,
    });

    assert.equal(code, 0);
    assert.equal(
      await verifyPassword('NewPassw0rd', getUserById(db, user.id)?.password_hash ?? ''),
      true,
    );
    assert.deepEqual(input.rawModeCalls, [true, false]);
    assert.doesNotMatch(output.text, /NewPassw0r/); // never echoed
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
