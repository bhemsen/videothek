// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { upsertItem } from '../../src/db/library-repo.js';
import { enqueueConversion } from '../../src/db/conversions.js';
import { storageKey } from '../../src/convert/targets.js';

/**
 * Shared setup for the real-stub queue lifecycle tests
 * (`test/convert/queue-lifecycle.test.js`, `test/convert/queue-lifecycle-cleanup.test.js`):
 * a real temp `MEDIA_ROOT`/`CONVERT_DIR`, an in-memory migrated DB, a
 * `Config` pointed at `test/helpers/converter-stub.js` run as a real child
 * process (no fake `run`, unlike `test/convert/queue*.test.js`), and small
 * assertion helpers for the path-redaction and no-side-effects-outside
 * `CONVERT_DIR` requirements every case checks.
 */

export const stubPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'converter-stub.js');

/** The one library item every test enqueues a conversion for, unless overridden. */
export const REL_PATH = 'Filme/Beispiel/film.mkv';

/**
 * @param {import('node:test').TestContext} t
 * @param {string} prefix
 * @returns {Promise<string>} a realpath'd temp dir removed after the test
 */
export async function makeTempDir(t, prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

/** @returns {import('node:sqlite').DatabaseSync} an in-memory DB with every migration applied */
export function makeDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

/**
 * @returns {{ calls: { level: string, event: string, fields?: Record<string, unknown> }[], log: import('../../src/log.js').Logger }}
 *   a fake `Logger` recording every call in order
 */
export function fakeLogger() {
  const calls = /** @type {{ level: string, event: string, fields?: Record<string, unknown> }[]} */ ([]);
  const record = (/** @type {string} */ level) => (/** @type {string} */ event, /** @type {any} */ fields) =>
    calls.push({ level, event, fields });
  return { calls, log: /** @type {any} */ ({ info: record('info'), warn: record('warn'), error: record('error') }) };
}

/**
 * @param {{ event: string }[]} logCalls
 * @param {string} event
 * @returns {number}
 */
export function countEvent(logCalls, event) {
  return logCalls.filter((c) => c.event === event).length;
}

/**
 * Polls `predicate` until it is true, or throws after `timeoutMs` so a stuck
 * test fails fast instead of hanging.
 * @param {() => boolean} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 * @returns {Promise<void>}
 */
export async function waitUntil(predicate, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * A `Config` pointed at real temp roots, with `converterCmd` frozen as given
 * (the real stub, or a deliberately missing executable).
 * @param {string} mediaRoot
 * @param {string} convertDir
 * @param {readonly string[]} converterCmd
 * @returns {import('../../src/config.js').Config}
 */
export function fakeConfig(mediaRoot, convertDir, converterCmd) {
  return Object.freeze({
    mediaRoot, dataDir: '', host: '0.0.0.0', port: 0, rescanIntervalMin: 15,
    adminUser: null, adminPassword: null,
    converterCmd: Object.freeze([...converterCmd]),
    convertDir,
    converterEnv: Object.freeze({ PATH: process.env.PATH ?? '' }),
  });
}

/**
 * `CONVERTER_CMD` tokens for the real stub in a given mode.
 * @param {string} mode
 * @param {string[]} [extraArgs] - leading stub flags before the fixed
 *   contract arguments the runner appends, e.g. `['--hold', dir]`.
 * @returns {readonly string[]}
 */
export function stubCmd(mode, extraArgs = []) {
  return Object.freeze([process.execPath, stubPath, '--mode', mode, ...extraArgs]);
}

/**
 * An absolute path that does not exist, for the `converter_unavailable`
 * (spawn `ENOENT`) case.
 * @returns {string}
 */
export function missingExecutablePath() {
  return path.join(os.tmpdir(), `vt-missing-converter-${process.pid}-${Date.now()}`);
}

/**
 * Writes a real source file plus its matching `library_items` row, and
 * enqueues a `queued` conversion row for it (not claimed - the queue under
 * test claims it itself).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} mediaRoot
 * @param {{ relPath?: string, target?: 'web' | 'flac' | 'opus', category?: 'movies' | 'series' | 'music' | 'audiobooks', kind?: 'video' | 'audio', ext?: string, queuedAt?: number }} [options]
 * @returns {Promise<{ abs: string, size: number, mtimeMs: number, key: string }>}
 */
export async function enqueueSource(db, mediaRoot, {
  relPath = REL_PATH, target = 'web', category = 'movies', kind = 'video', ext = 'mkv', queuedAt = 1,
} = {}) {
  const abs = path.join(mediaRoot, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, 'original source bytes');
  const stat = await fs.stat(abs);
  const size = stat.size;
  const mtimeMs = Math.trunc(stat.mtimeMs);
  upsertItem(
    db,
    {
      rel_path: relPath, dir: path.dirname(relPath), category, kind, ext,
      title: relPath, sort_title: relPath, playable: false, size, mtime_ms: mtimeMs, scan_version: 1,
    },
    1000
  );
  const key = storageKey(relPath);
  enqueueConversion(db, { relPath, storageKey: key, target, sourceSize: size, sourceMtimeMs: mtimeMs, now: queuedAt });
  return { abs, size, mtimeMs, key };
}

/**
 * Creates an unrelated temp dir with one known file, for the "nothing
 * outside `CONVERT_DIR` is created or removed" requirement: every case that
 * touches the queue/job pipeline calls {@link assertSentinelUnchanged} on it
 * afterwards.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<string>}
 */
export async function makeSentinel(t) {
  const dir = await makeTempDir(t, 'vt-lifecycle-sentinel-');
  await fs.writeFile(path.join(dir, 'untouched.txt'), 'sentinel');
  return dir;
}

/**
 * Asserts a sentinel dir from {@link makeSentinel} was not touched.
 * @param {string} dir
 */
export async function assertSentinelUnchanged(dir) {
  assert.deepEqual(await fs.readdir(dir), ['untouched.txt'], 'nothing was created or removed outside CONVERT_DIR');
  assert.equal(await fs.readFile(path.join(dir, 'untouched.txt'), 'utf8'), 'sentinel', 'the sentinel file itself was not touched');
}

/**
 * Asserts that a conversion row's `error_detail`/`notes` and every logged
 * field never carry an absolute `mediaRoot`/`convertDirReal` path (the
 * redaction requirement every failure case must satisfy).
 * @param {object} params
 * @param {import('../../src/db/conversions.js').ConversionRow | undefined} params.row
 * @param {{ event: string, fields?: Record<string, unknown> }[]} params.logCalls
 * @param {string} params.mediaRoot
 * @param {string} params.convertDirReal
 */
export function assertNoLeakedPaths({ row, logCalls, mediaRoot, convertDirReal }) {
  const roots = [mediaRoot, convertDirReal];
  const detail = row?.error_detail ?? '';
  for (const root of roots) {
    assert.ok(!containsPath(detail, root), `error_detail leaked a root path: ${detail}`);
  }
  for (const note of JSON.parse(row?.notes ?? '[]')) {
    for (const root of roots) {
      assert.ok(!containsPath(note, root), `a stored note leaked a root path: ${note}`);
    }
  }
  for (const call of logCalls) {
    const serialized = JSON.stringify(call.fields ?? {});
    for (const root of roots) {
      assert.ok(!containsPath(serialized, root), `a ${call.event} log line leaked a root path: ${serialized}`);
    }
  }
}

/**
 * Case-insensitive on `win32` (matching `redactDetail`'s own matching),
 * byte-exact elsewhere.
 * @param {string} text
 * @param {string} root
 * @returns {boolean}
 */
function containsPath(text, root) {
  if (root.length === 0) return false;
  return process.platform === 'win32'
    ? text.toLowerCase().includes(root.toLowerCase())
    : text.includes(root);
}
