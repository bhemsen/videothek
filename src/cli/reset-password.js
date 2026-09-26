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
 * echo control needed). TTY: keystrokes are interpreted with echo disabled —
 * Backspace/Delete edit the buffer, Enter submits, Ctrl+C aborts the process.
 * @param {CliInput} input
 * @param {boolean} isTTY
 * @returns {() => Promise<string>} resolves the next queued line
 */
function createPromptReader(input, isTTY) {
  let buffer = '';
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

  /** @param {string} text */
  const onKeystroke = (text) => {
    if (text === CTRL_C) {
      input.setRawMode?.(false);
      process.exit(1);
      return;
    }
    if (text === '\r' || text === '\n') {
      const resolve = waiting;
      const line = buffer;
      buffer = '';
      waiting = null;
      resolve?.(line);
      return;
    }
    buffer = BACKSPACE_CHARS.has(text) ? buffer.slice(0, -1) : buffer + text;
  };

  /** @param {unknown} chunk */
  const onData = (chunk) => {
    const text = String(chunk);
    if (isTTY) {
      onKeystroke(text);
    } else {
      buffer += text;
      tryResolveLine();
    }
  };

  input.setRawMode?.(isTTY);
  input.setEncoding?.('utf8');
  input.on('data', onData);
  input.resume?.();

  return () => new Promise((resolveLine) => {
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
 * Never throws: every failure is reported on `output` in German and
 * reflected in the returned exit code.
 * @param {{
 *   args: string[],
 *   config: Config,
 *   db: import('node:sqlite').DatabaseSync,
 *   input: CliInput,
 *   output: CliOutput,
 *   log: Logger,
 *   isTTY: boolean,
 * }} deps
 * @returns {Promise<number>} process exit code
 */
export async function resetPassword({ args, db, input, output, log, isTTY }) {
  const rawUsername = args[0];
  if (!rawUsername) {
    output.write('Benutzername fehlt. Verwendung: npm run reset-password -- <username>\n');
    return 1;
  }
  const username = normalizeUsername(rawUsername);
  const user = getUserByUsername(db, username);
  if (!user) {
    output.write(`Unbekannter Benutzer: ${username}\n`);
    return 1;
  }

  const readNext = createPromptReader(input, isTTY);
  const password = await promptSecret(`Neues Passwort für ${user.username}: `, output, readNext);
  const repeat = await promptSecret('Passwort wiederholen: ', output, readNext);
  input.setRawMode?.(false);
  input.pause?.();
  if (password !== repeat) {
    output.write('Passwörter stimmen nicht überein.\n');
    return 1;
  }
  if (!validatePassword(password)) {
    output.write('Das Passwort muss 8–256 Zeichen lang sein.\n');
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
