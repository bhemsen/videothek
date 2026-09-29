// @ts-check
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { upsertItem } from '../../src/db/library-repo.js';
import { enqueueConversion } from '../../src/db/conversions.js';
import { storageKey } from '../../src/convert/targets.js';
import { createConversionQueue } from '../../src/convert/queue.js';

/**
 * Shared setup for the real-stub queue lifecycle tests
 * (`test/convert/queue-lifecycle.test.js`, `test/convert/queue-lifecycle-cleanup.test.js`):
 * one base temp dir holding `media/` (`MEDIA_ROOT`) and `converted/`
 * (`CONVERT_DIR`, created by `queue.start()` itself), an in-memory migrated
 * DB, a `Config` pointed at `test/helpers/converter-stub.js` run as a real
 * child process (no fake `run`, unlike `test/convert/queue*.test.js`), and
 * assertion helpers for the path-redaction and nothing-outside-`CONVERT_DIR`
 * requirements.
 */

export const stubPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'converter-stub.js');

/** The one library item every test enqueues a conversion for, unless overridden. */
export const REL_PATH = 'Filme/Beispiel/film.mkv';

const MEDIA_NAME = 'media';
const CONVERT_NAME = 'converted';

/**
 * @typedef {object} LifecycleFixture
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {string} base - realpath'd parent of `mediaRoot` and `convertDirReal`.
 * @property {string} mediaRoot
 * @property {string} convertDirReal - not yet created; `queue.start()` creates it.
 * @property {import('../../src/log.js').Logger} log
 * @property {{ level: string, event: string, fields?: Record<string, unknown> }[]} logCalls
 * @property {(() => Promise<void>)[]} stops - queue `stop()`s run first in teardown.
 */

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

/**
 * A fresh base temp dir with `media/` created and `converted/` left for
 * `queue.start()` to create, plus a DB and a recording logger.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<LifecycleFixture>}
 */
export async function lifecycleFixture(t) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vt-lifecycle-')));
  /** @type {(() => Promise<void>)[]} */
  const stops = [];
  // One hook, in this order: node:test runs `t.after` hooks in registration
  // order, so separate hooks would remove the dir before a live stub is stopped.
  t.after(async () => {
    for (const stop of stops) await stop();
    if (db.isOpen) db.close();
    await fs.rm(base, { recursive: true, force: true, maxRetries: 3 });
  });
  const mediaRoot = path.join(base, MEDIA_NAME);
  await fs.mkdir(mediaRoot);
  const { log, calls: logCalls } = fakeLogger();
  return { db, base, mediaRoot, convertDirReal: path.join(base, CONVERT_NAME), log, logCalls, stops };
}

/**
 * @returns {{ calls: { level: string, event: string, fields?: Record<string, unknown> }[], log: import('../../src/log.js').Logger }}
 *   a fake `Logger` recording every call in order
 */
function fakeLogger() {
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
 * A `Config` pointed at the fixture's roots, with `converterCmd` frozen as
 * given (the real stub, or a deliberately missing executable) and a fixed
 * minimal `converterEnv` (the stub runs via absolute `process.execPath`).
 * @param {LifecycleFixture} f
 * @param {readonly string[]} converterCmd
 * @returns {import('../../src/config.js').Config}
 */
export function fakeConfig(f, converterCmd) {
  return Object.freeze({
    mediaRoot: f.mediaRoot, dataDir: '', host: '0.0.0.0', port: 0, rescanIntervalMin: 15,
    adminUser: null, adminPassword: null,
    converterCmd: Object.freeze([...converterCmd]),
    convertDir: f.convertDirReal,
    converterEnv: Object.freeze({ PATH: '/usr/bin' }),
  });
}

/**
 * Creates a queue against `converterCmd`, registers its `stop()` to run
 * first in the fixture's teardown, starts it (asserting success) and kicks it once.
 * @param {LifecycleFixture} f
 * @param {readonly string[]} converterCmd
 * @param {Partial<Parameters<typeof createConversionQueue>[0]>} [extra]
 * @returns {Promise<ReturnType<typeof createConversionQueue>>}
 */
export async function startQueue(f, converterCmd, extra = {}) {
  const queue = createConversionQueue({ db: f.db, config: fakeConfig(f, converterCmd), log: f.log, now: () => 1, ...extra });
  f.stops.push(() => queue.stop());
  assert.equal(await queue.start(), true, 'queue.start() must succeed against a real temp CONVERT_DIR');
  queue.kick();
  return queue;
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
 * @param {LifecycleFixture} f
 * @param {{ relPath?: string, target?: 'web' | 'flac' | 'opus', category?: 'movies' | 'series' | 'music' | 'audiobooks', kind?: 'video' | 'audio', ext?: string, queuedAt?: number }} [options]
 * @returns {Promise<{ abs: string, size: number, mtimeMs: number, key: string }>}
 */
export async function enqueueSource(f, {
  relPath = REL_PATH, target = 'web', category = 'movies', kind = 'video', ext = 'mkv', queuedAt = 1,
} = {}) {
  const abs = path.join(f.mediaRoot, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, 'original source bytes');
  const stat = await fs.stat(abs);
  const size = stat.size;
  const mtimeMs = Math.trunc(stat.mtimeMs);
  upsertItem(
    f.db,
    {
      rel_path: relPath, dir: path.dirname(relPath), category, kind, ext,
      title: relPath, sort_title: relPath, playable: false, size, mtime_ms: mtimeMs, scan_version: 1,
    },
    1000
  );
  const key = storageKey(relPath);
  enqueueConversion(f.db, { relPath, storageKey: key, target, sourceSize: size, sourceMtimeMs: mtimeMs, now: queuedAt });
  return { abs, size, mtimeMs, key };
}

/**
 * A recursive listing of the fixture's base dir - `MEDIA_ROOT` and anything
 * beside `CONVERT_DIR` - leaving out `converted/` and everything under it.
 * Scope: only this base dir (the spec's "nothing outside `convertDir`" temp-dir
 * listing); siblings elsewhere in the system temp dir are not listed.
 * Files carry size, mtime and a content hash unless `namesOnly` (for a case
 * that rewrites the source file itself).
 * @param {LifecycleFixture} f
 * @param {{ namesOnly?: boolean }} [options]
 * @returns {Promise<string[]>}
 */
export async function snapshotOutsideConvertDir(f, { namesOnly = false } = {}) {
  const entries = /** @type {string[]} */ (await fs.readdir(f.base, { recursive: true }));
  const outside = entries.filter((rel) => rel !== CONVERT_NAME && !rel.startsWith(CONVERT_NAME + path.sep)).sort();
  return Promise.all(outside.map(async (rel) => {
    const abs = path.join(f.base, rel);
    const stat = await fs.lstat(abs);
    if (!stat.isFile()) return `${stat.isDirectory() ? 'dir' : 'other'} ${rel}`;
    if (namesOnly) return `file ${rel}`;
    const hash = createHash('sha256').update(await fs.readFile(abs)).digest('hex');
    return `file ${rel} ${stat.size} ${stat.mtimeMs} ${hash}`;
  }));
}

/**
 * Asserts nothing inside `MEDIA_ROOT` or beside `CONVERT_DIR` was created,
 * removed or (unless `namesOnly`) modified since `before` was taken.
 * @param {LifecycleFixture} f
 * @param {string[]} before - from {@link snapshotOutsideConvertDir}.
 * @param {{ namesOnly?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function assertNothingOutsideConvertDir(f, before, options = {}) {
  const after = await snapshotOutsideConvertDir(f, options);
  assert.deepEqual(after, before, 'nothing outside CONVERT_DIR was created, removed or modified');
}

/**
 * Asserts that a conversion row's `error_detail`/`notes` and every logged
 * field never carry the fixture's base, `mediaRoot` or `convertDirReal`
 * path, nor any string in `extra` (the redaction requirement).
 * @param {LifecycleFixture} f
 * @param {import('../../src/db/conversions.js').ConversionRow | undefined} row
 * @param {string[]} [extra] - further paths/names no row field or log line may contain.
 */
export function assertNoLeakedPaths(f, row, extra = []) {
  const needles = [f.base, f.mediaRoot, f.convertDirReal, ...extra];
  const texts = [
    ['error_detail', row?.error_detail ?? ''],
    ...JSON.parse(row?.notes ?? '[]').map((/** @type {string} */ note) => ['a stored note', note]),
    ...f.logCalls.map((call) => [`a ${call.event} log line`, logLineText(call)]),
  ];
  for (const [where, text] of texts) {
    for (const needle of needles) {
      assert.ok(!containsPath(text, needle), `${where} leaked a path: ${text}`);
    }
  }
}

/**
 * The raw text of one log call - its event name plus every leaf field value,
 * unescaped (not `JSON.stringify`, which doubles win32 backslashes so a
 * path would never match), one per line.
 * @param {{ event: string, fields?: Record<string, unknown> }} call
 * @returns {string}
 */
export function logLineText(call) {
  /** @type {string[]} */
  const parts = [call.event];
  const walk = (/** @type {unknown} */ value) => {
    if (value instanceof Error) parts.push(value.message, String(value.stack));
    if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
    else parts.push(String(value));
  };
  walk(call.fields ?? {});
  return parts.join('\n');
}

/**
 * Case-insensitive on `win32` (matching `redactDetail`'s own matching),
 * byte-exact elsewhere.
 * @param {string} text
 * @param {string} needle
 * @returns {boolean}
 */
function containsPath(text, needle) {
  if (needle.length === 0) return false;
  return process.platform === 'win32'
    ? text.toLowerCase().includes(needle.toLowerCase())
    : text.includes(needle);
}
