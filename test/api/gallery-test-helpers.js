/**
 * Shared fixtures for the `src/api/gallery.js` test suite (split across
 * `gallery.test.js` and `gallery-validation.test.js` to stay under the
 * constitution's 300-line-per-file limit).
 */

import http from 'node:http';
import { insertItem } from '../helpers/image-meta-seed.js';
import { insertMetaStubs, saveMeta } from '../../src/db/image-meta.js';

/**
 * Issues a raw HTTP GET against the running test app, `agent: false` so the
 * socket closes right away and `app.close()` never hangs on a pooled
 * keep-alive connection. `pathname` is used verbatim — callers pre-encode.
 * @param {string} baseUrl
 * @param {string} pathname
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number, body: any }>}
 */
export function get(baseUrl, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${pathname}`, { method: 'GET', headers, agent: false }, (res) => {
      const chunks = /** @type {Buffer[]} */ ([]);
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: /** @type {number} */ (res.statusCode), body: raw ? JSON.parse(raw) : undefined });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Inserts a `library_items` row plus its `image_meta` stub (the join
 * `src/db/image-meta.js` reads on requires) into the given folder key.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} folder
 * @param {Partial<{ rel_path: string, dir: string, kind: string, ext: string, playable: number, size: number, mtime_ms: number }>} overrides
 * @returns {number} the inserted item's id
 */
export function seedItem(db, folder, overrides = {}) {
  const id = insertItem(db, overrides);
  insertMetaStubs(db, [{ itemId: id, folder }]);
  return id;
}

/**
 * `seedItem` plus a saved `image_meta` header (EXIF fields), for cover/order/
 * thumbnail-marker scenarios.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} folder
 * @param {Partial<{ rel_path: string, dir: string, kind: string, ext: string, playable: number, size: number, mtime_ms: number }>} overrides
 * @param {{ takenAt?: string | null, orientation?: number | null, thumbOffset?: number | null,
 *   thumbLength?: number | null, sourceSize: number, sourceMtimeMs: number, metaVersion?: number }} meta
 * @returns {number}
 */
export function seedItemWithMeta(db, folder, overrides, meta) {
  const id = seedItem(db, folder, overrides);
  saveMeta(db, id, {
    takenAt: meta.takenAt ?? null,
    orientation: meta.orientation ?? null,
    thumbOffset: meta.thumbOffset ?? null,
    thumbLength: meta.thumbLength ?? null,
    sourceSize: meta.sourceSize,
    sourceMtimeMs: meta.sourceMtimeMs,
    metaVersion: meta.metaVersion ?? 1,
  });
  return id;
}

/**
 * Looks up an item's id by its `rel_path`, for asserting which item a
 * folder's cover resolved to.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} relPath
 * @returns {number}
 */
export function idOf(db, relPath) {
  const row = /** @type {{ id: number } | undefined} */ (
    db.prepare('SELECT id FROM library_items WHERE rel_path = ?').get(relPath)
  );
  if (!row) throw new Error(`no such item: ${relPath}`);
  return row.id;
}
