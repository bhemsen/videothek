/**
 * Offline password recovery: `npm run reset-password -- <username>`. Runs
 * without the HTTP server (works even with the media disk unmounted, since
 * `loadConfig` is called with `requireMediaRoot: false`) so a lost admin
 * password never locks the household out. Prompts twice for a new password
 * without echoing it, sets the hash and revokes every session that user
 * holds so a stolen or forgotten-open session cannot outlive the reset.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createLogger } from '../log.js';
import { migrate, openDatabase } from '../db/index.js';
import { getUserByUsername, setPasswordHash } from '../db/users.js';
import { deleteUserSessions } from '../db/sessions.js';
import { hashPassword } from '../auth/password.js';
import { normalizeUsername, validatePassword } from '../auth/validation.js';

/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('../log.js').Logger} Logger */

/** @typedef {{ write(chunk: string): void }} CliOutput */

/**
 * Minimal duck-typed input stream: `process.stdin` satisfies it structurally
 * (like `LogStream` in `src/log.js`), and tests pass a plain fake without
 * implementing the rest of the `net.Socket` surface.
 * @typedef {{
 *   isTTY?: boolean,
 *   setRawMode?(mode: boolean): void,
 *   setEncoding?(encoding: BufferEncoding): void,
 *   resume?(): void,
 *   pause?(): void,
 *   on(event: string, listener: (chunk: unknown) => void): void,
 * }} CliInput
 */

const CTRL_C = '\u0003';
const BACKSPACE_CHARS = new Set(['\u007f', '\b']);

/**
 * Creates a persistent reader over `input` that hands out one line/secret
 * per call. A single `'data'` listener stays attached for the whole prompt
 * sequence and buffers internally, so bytes that arrive together — a piped
 * shell flushing several answers in one chunk, or a keystroke typed right
 * after Enter — are queued instead of being dropped when the first call
 * extracts its line (the original, non-buffering version silently lost the
 * second prompt's answer whenever a test/shell wrote both lines at once,
 * leaving the CLI waiting forever on input that would never arrive).
 * Non-TTY: chunks are appended verbatim and sliced on the next newline (no
 * echo control needed). TTY: each chunk's characters are replayed one at a
 * time through `onKeystroke` (a pasted password arrives as one multi-char
 * chunk, not one keystroke per chunk) with echo disabled — Backspace/Delete
 * edit the buffer, Enter submits, Ctrl+C aborts the process. If `input` ends
 * (EOF/closed) while a call is still waiting — empty/closed stdin, or a
 * final line with no trailing newline — that call resolves with whatever is
 * left in the buffer (possibly `''`) instead of hanging forever; any later
 * call resolves the same way immediately, since no more data can arrive.
 * @param {CliInput} input
 * @param {boolean} isTTY
 * @returns {() => Promise<string>} resolves the next queued line
 */
function createPromptReader(input, isTTY) {
  let buffer = '';
  let ended = false;
  /** @type {((line: string) => void) | null} */
  let waiting = null;

  const tryResolveLine = () => {
    const end = buffer.indexOf('\n');
    if (end === -1 || !waiting) return;
    const line = buffer.slice(0, end).replace(/\r$/, '');
    buffer = buffer.slice(end + 1);
    const resolve = waiting;
    waiting = null;
    resolve(line);
  };

  /** @param {string} ch a single character/code point from a TTY data chunk */
  const onKeystroke = (ch) => {
    if (ch === CTRL_C) {
      input.setRawMode?.(false);
      process.exit(1);
      return;
    }
    if (ch === '\r' || ch === '\n') {
      const resolve = waiting;
      const line = buffer;
      buffer = '';
      waiting = null;
      resolve?.(line);
      return;
    }
    buffer = BACKSPACE_CHARS.has(ch) ? buffer.slice(0, -1) : buffer + ch;
  };

  /** @param {unknown} chunk */
  const onData = (chunk) => {
    const text = String(chunk);
    if (isTTY) {
      for (const ch of text) onKeystroke(ch);
    } else {
      buffer += text;
      tryResolveLine();
    }
  };

  const onEnd = () => {
    if (ended) return;
    ended = true;
    if (!waiting) return;
    const resolve = waiting;
    const line = buffer;
    buffer = '';
    waiting = null;
    resolve(line);
  };

  input.setRawMode?.(isTTY);
  input.setEncoding?.('utf8');
  input.on('data', onData);
  input.on('end', onEnd);
  input.on('close', onEnd);
  input.resume?.();

  return () => new Promise((resolveLine) => {
    if (ended) {
      const line = buffer;
      buffer = '';
      resolveLine(line);
      return;
    }
    waiting = resolveLine;
    if (!isTTY) tryResolveLine();
  });
}

/**
 * Prompts once for a password-like value without echoing it.
 * @param {string} label
 * @param {CliOutput} output
 * @param {() => Promise<string>} readNext
 * @returns {Promise<string>}
 */
async function promptSecret(label, output, readNext) {
  output.write(label);
  const value = await readNext();
  output.write('\n');
  return value;
}

/**
 * Runs the offline `reset-password` CLI against already-opened dependencies.
 * Never throws: every failure is reported on `errorOutput` (stderr in
 * `main()`) in German and reflected in the returned exit code; `output`
 * (stdout in `main()`) only ever carries the prompts and the success line.
 * @param {{
 *   args: string[],
 *   config: Config,
 *   db: import('node:sqlite').DatabaseSync,
 *   input: CliInput,
 *   output: CliOutput,
 *   errorOutput: CliOutput,
 *   log: Logger,
 *   isTTY: boolean,
 * }} deps
 * @returns {Promise<number>} process exit code
 */
export async function resetPassword({ args, db, input, output, errorOutput, log, isTTY }) {
  const rawUsername = args[0];
  if (!rawUsername) {
    errorOutput.write('Benutzername fehlt. Verwendung: npm run reset-password -- <username>\n');
    return 1;
  }
  const username = normalizeUsername(rawUsername);
  const user = getUserByUsername(db, username);
  if (!user) {
    errorOutput.write(`Unbekannter Benutzer: ${username}\n`);
    return 1;
  }

  const readNext = createPromptReader(input, isTTY);
  const password = await promptSecret(`Neues Passwort für ${user.username}: `, output, readNext);
  const repeat = await promptSecret('Passwort wiederholen: ', output, readNext);
  input.setRawMode?.(false);
  input.pause?.();
  if (password !== repeat) {
    errorOutput.write('Passwörter stimmen nicht überein.\n');
    return 1;
  }
  if (!validatePassword(password)) {
    errorOutput.write('Das Passwort muss 8–256 Zeichen lang sein.\n');
    return 1;
  }

  setPasswordHash(db, user.id, await hashPassword(password));
  const revoked = deleteUserSessions(db, user.id);
  log.info('password_reset', { user: user.username, by: 'cli' });
  output.write(`Passwort für ${user.username} gesetzt, ${revoked} Sitzung(en) beendet.\n`);
  return 0;
}

/**
 * Wires the real process streams and exits with `resetPassword`'s result.
 * @returns {Promise<void>}
 */
async function main() {
  const config = loadConfig(undefined, { requireMediaRoot: false });
  const log = createLogger();
  const db = openDatabase(config.dataDir);
  try {
    migrate(db, { log });
    process.exitCode = await resetPassword({
      args: process.argv.slice(2),
      config,
      db,
      input: /** @type {CliInput} */ (process.stdin),
      output: process.stdout,
      errorOutput: process.stderr,
      log,
      isTTY: process.stdin.isTTY === true,
    });
  } finally {
    db.close();
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  main().catch((/** @type {unknown} */ err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
