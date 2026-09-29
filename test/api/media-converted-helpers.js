// @ts-check

/**
 * Shared fixtures for the `/media/:id` converted-copy tests (split across
 * `media-converted.test.js` and `media-converted-paths.test.js` to stay under
 * the constitution's 300-line-per-file limit).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { upsertItem } from '../../src/db/library-repo.js';
import { enqueueConversion, publishConversion } from '../../src/db/conversions.js';
import { startTestApp } from '../helpers/app.js';

/** @typedef {import('../../src/db/library-repo.js').LibraryItemInput} LibraryItemInput */
/** @typedef {Awaited<ReturnType<typeof startTestApp>>} TestApp */

export const SOURCE_REL = 'Filme/Show (2020).mkv';
export const SOURCE_SIZE = 1234;
export const SOURCE_MTIME = 1_700_000_000_000;
export const STORAGE_KEY = 'a'.repeat(64);

/**
 * A non-direct-playable MKV movie row; `overrides` replace any field.
 * @param {Partial<LibraryItemInput>} [overrides]
 * @returns {LibraryItemInput}
 */
export function makeItem(overrides = {}) {
  return /** @type {LibraryItemInput} */ ({
    rel_path: SOURCE_REL,
    dir: 'Filme',
    category: 'movies',
    kind: 'video',
    ext: 'mkv',
    title: 'Show',
    sort_title: 'show',
    playable: false,
    size: SOURCE_SIZE,
    mtime_ms: SOURCE_MTIME,
    scan_version: 1,
    ...overrides,
  });
}

/**
 * `size` bytes, `value[i] = (i + seed) % 256`, so two buffers of the same
 * length are still trivially distinguishable (source vs. converted copy).
 * @param {number} size
 * @param {number} [seed]
 * @returns {Buffer}
 */
export function patternBytes(size, seed = 0) {
  return Buffer.from(Array.from({ length: size }, (_, i) => (i + seed) % 256));
}

/**
 * @param {string} fullPath
 * @param {Buffer} bytes
 * @returns {Promise<void>}
 */
export async function writeFileDeep(fullPath, bytes) {
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, bytes);
}

/**
 * Boots the app and logs one user in.
 * @returns {Promise<{ app: TestApp, cookie: string }>}
 */
export async function setup() {
  const app = await startTestApp();
  await app.createUser('alice', 'password123');
  const cookie = await app.login('alice', 'password123');
  return { app, cookie };
}

/**
 * Seeds the source under `MEDIA_ROOT` and publishes a fresh `playable`
 * conversions row for it, so the effective-playable computation marks the
 * item playable although its own `playable` column is `false`. The copy's
 * bytes are written under `CONVERT_DIR` only when `outputBytes` is given, so
 * a caller can simulate a fresh row whose file was removed by omitting it.
 * @param {TestApp} app
 * @param {{
 *   sourceBytes: Buffer,
 *   outputRel: string,
 *   outputBytes?: Buffer,
 *   item?: Partial<LibraryItemInput>,
 *   storageKey?: string,
 *   target?: 'web' | 'flac' | 'opus',
 *   now?: number,
 * }} opts
 * @returns {Promise<number>} the item's id
 */
export async function seedConvertedItem(app, opts) {
  const { sourceBytes, outputRel, outputBytes, item = {}, storageKey = STORAGE_KEY, target = 'web', now = 1000 } = opts;
  const row = makeItem(item);
  await writeFileDeep(path.join(app.config.mediaRoot, row.rel_path), sourceBytes);
  const id = upsertItem(app.db, row, now);
  enqueueConversion(app.db, {
    relPath: row.rel_path,
    storageKey,
    target,
    sourceSize: row.size,
    sourceMtimeMs: row.mtime_ms,
    now,
  });
  publishConversion(app.db, {
    relPath: row.rel_path,
    outputRel,
    outputSize: outputBytes ? outputBytes.length : 0,
    notes: '[]',
    now,
  });
  await mkdir(app.config.convertDir, { recursive: true });
  if (outputBytes) {
    await writeFileDeep(path.join(app.config.convertDir, outputRel), outputBytes);
  }
  return id;
}

/**
 * @param {TestApp} app
 * @param {string} cookie
 * @param {number} id
 * @param {RequestInit} [init] - `headers` are merged after the cookie.
 * @returns {Promise<Response>}
 */
export function getMedia(app, cookie, id, init = {}) {
  const headers = { Cookie: cookie, .../** @type {Record<string, string>} */ (init.headers ?? {}) };
  return fetch(`${app.baseUrl}/media/${id}`, { ...init, headers });
}
