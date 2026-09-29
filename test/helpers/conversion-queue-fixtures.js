// @ts-check
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { upsertItem } from '../../src/db/library-repo.js';
import { enqueueConversion } from '../../src/db/conversions.js';
import { storageKey, TARGETS } from '../../src/convert/targets.js';

/**
 * Shared fixtures for `src/convert/queue.js`'s tests
 * (`test/convert/queue*.test.js`, precedent: `test/helpers/conversion-job-fixtures.js`
 * for `job.js`'s own split tests): a real temp `MEDIA_ROOT`, an in-memory
 * migrated DB, a matching `Config`, sources enqueued (not claimed - claiming
 * is the queue's own job) under chosen `rel_path`s, and a controllable fake
 * `run` (`runConverter`'s shape) that lets a test drive each call's `result`
 * and observe its `kill()` calls one call at a time.
 */

/** @returns {import('node:sqlite').DatabaseSync} an in-memory DB with every migration applied */
export function makeDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

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
 * @param {string} mediaRoot
 * @param {string} convertDir - not yet realpath'd; `queue.start()` does that.
 * @returns {import('../../src/config.js').Config}
 */
export function fakeConfig(mediaRoot, convertDir) {
  return Object.freeze({
    mediaRoot, dataDir: '', host: '0.0.0.0', port: 0, rescanIntervalMin: 15,
    adminUser: null, adminPassword: null,
    converterCmd: Object.freeze(['/usr/bin/fake-converter']),
    convertDir,
    converterEnv: Object.freeze({ PATH: '/usr/bin' }),
  });
}

/**
 * @returns {{ calls: { level: string, event: string, fields?: Record<string, unknown> }[], log: import('../../src/log.js').Logger }}
 */
export function fakeLogger() {
  const calls = /** @type {{ level: string, event: string, fields?: Record<string, unknown> }[]} */ ([]);
  const record = (/** @type {string} */ level) => (/** @type {string} */ event, /** @type {any} */ fields) =>
    calls.push({ level, event, fields });
  return { calls, log: /** @type {any} */ ({ info: record('info'), warn: record('warn'), error: record('error') }) };
}

/**
 * Writes a real source file plus its matching `library_items` row, and
 * enqueues a `queued` conversion row for it (not claimed).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} mediaRoot
 * @param {string} relPath
 * @param {{ queuedAt?: number }} [options]
 * @returns {Promise<string>} the source's absolute path
 */
export async function enqueueSource(db, mediaRoot, relPath, { queuedAt = 1 } = {}) {
  const abs = path.join(mediaRoot, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, 'source bytes');
  const stat = await fs.stat(abs);
  const size = stat.size;
  const mtimeMs = Math.trunc(stat.mtimeMs);
  upsertItem(
    db,
    {
      rel_path: relPath, dir: path.dirname(relPath), category: 'audiobooks', kind: 'audio', ext: 'mp3',
      title: relPath, sort_title: relPath, playable: false, size, mtime_ms: mtimeMs, scan_version: 1,
    },
    1000
  );
  enqueueConversion(db, { relPath, storageKey: storageKey(relPath), target: 'flac', sourceSize: size, sourceMtimeMs: mtimeMs, now: queuedAt });
  return abs;
}

/**
 * Enqueues a `queued` row with no backing `library_items` row, simulating a
 * vanished or not-yet-mounted source: the queue must still claim it and end
 * it `failed` `source_missing` without ever calling `run`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} relPath
 * @param {{ queuedAt?: number }} [options]
 */
export function enqueueMissingSource(db, relPath, { queuedAt = 1 } = {}) {
  enqueueConversion(db, { relPath, storageKey: storageKey(relPath), target: 'flac', sourceSize: 1, sourceMtimeMs: 1, now: queuedAt });
}

/**
 * A controllable fake `run` (`runConverter`'s shape): each call's `result`
 * is settled by the test via the entry `next()` hands back, and its
 * `kill()` calls are only recorded on that entry (no real effect) - it is
 * `queue.js`'s own kill-escalation logic under test, not a real process.
 * @returns {{ run: any, calls: any[], next(): Promise<{ args: any, resolve: (value: any) => void, killCalls: string[] }> }}
 */
export function deferredRun() {
  const calls = /** @type {any[]} */ ([]);
  /** @type {((entry: any) => void)[]} */
  const waiters = [];
  /** @type {any[]} */
  const pending = [];
  const run = (/** @type {any} */ args) => {
    /** @type {(value: any) => void} */
    let resolveResult = () => {};
    const result = new Promise((resolve) => { resolveResult = resolve; });
    const killCalls = /** @type {string[]} */ ([]);
    calls.push(args);
    const entry = { args, resolve: resolveResult, killCalls };
    const waiter = waiters.shift();
    if (waiter) waiter(entry); else pending.push(entry);
    return { result, kill: (/** @type {string} */ signal) => killCalls.push(signal) };
  };
  const next = () => new Promise((resolve) => {
    const entry = pending.shift();
    if (entry) resolve(entry); else waiters.push(resolve);
  });
  return { run, calls, next };
}

/**
 * Polls `predicate` until it is true, or throws after `timeoutMs` so a stuck
 * test fails fast instead of hanging (job.js's own steps do real, if tiny, I/O).
 * @param {() => boolean} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 * @returns {Promise<void>}
 */
export async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * A `run` result (`fakeRun`'s shape) that resolves at once with a valid
 * `converted` FLAC record, for tests that need no manual control.
 * @param {{ outDir: string }} args
 * @returns {Promise<any>}
 */
export async function successResult({ outDir }) {
  const output = path.join(outDir, TARGETS.flac.file);
  await fs.writeFile(output, Buffer.concat([Buffer.from('fLaC', 'ascii'), Buffer.alloc(4)]));
  return {
    spawnError: null, exitCode: 0, signal: null, killedBy: null,
    records: [{ outcome: 'converted', output, error: null, notes: [] }],
    stdoutInvalid: false, stdioTimedOut: false, stderrTail: '',
  };
}
