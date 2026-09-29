// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { upsertItem } from '../../src/db/library-repo.js';
import { enqueueConversion, claimNextConversion } from '../../src/db/conversions.js';
import { storageKey, TARGETS } from '../../src/convert/targets.js';

/**
 * Shared fixtures for `src/convert/job.js`'s tests (`test/convert/job*.test.js`):
 * a real temp `MEDIA_ROOT`/`CONVERT_DIR`, an in-memory DB with a claimed row,
 * a fake logger and a fake `run` in `runConverter`'s shape.
 */

export const REL_PATH = 'Hoerbuecher/Buch/kapitel1.mp3';
export const FLAC_BYTES = Buffer.concat([Buffer.from('fLaC', 'ascii'), Buffer.alloc(4)]);

/**
 * @param {string} mediaRoot
 * @param {string} convertDir
 * @returns {import('../../src/config.js').Config}
 */
export function fakeConfig(mediaRoot, convertDir) {
  return Object.freeze({
    mediaRoot,
    dataDir: '',
    host: '0.0.0.0',
    port: 0,
    rescanIntervalMin: 15,
    adminUser: null,
    adminPassword: null,
    converterCmd: Object.freeze(['/usr/bin/fake-converter']),
    convertDir,
    converterEnv: Object.freeze({ PATH: '/usr/bin' }),
  });
}

/**
 * @returns {import('node:sqlite').DatabaseSync} an in-memory DB with every migration applied
 */
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
 * A fake `run` (`runConverter`'s shape) built from an async result builder,
 * itself synchronous like the real runner.
 * @param {(args: any) => Promise<any>} buildResult
 * @returns {{ run: any, calls: any[] }}
 */
export function fakeRun(buildResult) {
  const calls = /** @type {any[]} */ ([]);
  const run = (/** @type {any} */ args) => {
    calls.push(args);
    return { result: buildResult(args), kill: () => {} };
  };
  return { run, calls };
}

/**
 * A settled `converted` record writing a valid `audio.flac` into `outDir`.
 * @param {{ outDir: string }} args
 * @param {string[]} [notes]
 * @returns {Promise<any>}
 */
export async function convertedFlac({ outDir }, notes = []) {
  const output = path.join(outDir, TARGETS.flac.file);
  await fs.writeFile(output, FLAC_BYTES);
  return {
    spawnError: null, exitCode: 0, signal: null, killedBy: null,
    records: [{ outcome: 'converted', output, error: null, notes }],
    stdoutInvalid: false, stdioTimedOut: false, stderrTail: '',
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Partial<Parameters<typeof enqueueConversion>[1]>} [overrides]
 * @returns {import('../../src/db/conversions.js').ConversionRow} the claimed row
 */
export function claim(db, overrides = {}) {
  enqueueConversion(db, {
    relPath: REL_PATH, storageKey: storageKey(REL_PATH), target: 'flac', sourceSize: 1, sourceMtimeMs: 1, now: 1,
    ...overrides,
  });
  const row = claimNextConversion(db, 10);
  assert.ok(row, 'expected a claimable row');
  return row;
}

/**
 * Writes a real source file under `mediaRoot` and the matching `library_items` row.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} mediaRoot
 * @returns {Promise<{ abs: string, size: number, mtimeMs: number }>}
 */
export async function makeSource(db, mediaRoot) {
  const abs = path.join(mediaRoot, REL_PATH);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, 'source bytes');
  const stat = await fs.stat(abs);
  upsertItem(
    db,
    {
      rel_path: REL_PATH, dir: path.dirname(REL_PATH), category: 'audiobooks', kind: 'audio', ext: 'mp3',
      title: 'Kapitel 1', sort_title: 'kapitel 1', playable: false, size: stat.size,
      mtime_ms: Math.trunc(stat.mtimeMs), scan_version: 1,
    },
    1000
  );
  return { abs, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
}

/**
 * A ready fixture with a real, indexed source and a claimed row. The DB is
 * closed after the test unless the test closed it itself.
 * @param {import('node:test').TestContext} t
 */
export async function setup(t) {
  const db = makeDb();
  t.after(() => { if (db.isOpen) db.close(); });
  const convertDirReal = await makeTempDir(t, 'vt-job-convert-');
  const mediaRoot = await makeTempDir(t, 'vt-job-media-');
  const source = await makeSource(db, mediaRoot);
  const row = claim(db, { sourceSize: source.size, sourceMtimeMs: source.mtimeMs });
  return { db, convertDirReal, mediaRoot, row, source };
}
