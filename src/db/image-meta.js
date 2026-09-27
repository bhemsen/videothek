/**
 * Read/write SQL for the image gallery's metadata sync, thumbnail route and
 * gallery API (`image_meta`, see `src/db/migrations/005-image-meta.sql`).
 * `item_id` cascades from `library_items` (no orphan-delete code needed).
 * Folder-key subtree lookups use the same `[key/, key0)` range trick as
 * `library-repo.js`'s `rel_path` ranges — never `LIKE` (`_`/`%` wildcards).
 * @typedef {object} ItemRow
 * @property {number} id
 * @property {string} relPath
 * @property {'image'|'video'} kind
 * @property {boolean} playable
 * @property {number} size
 * @property {number} mtimeMs
 * @property {string | null} takenAt
 * @property {number | null} orientation
 * @property {number | null} thumbOffset
 * @property {number | null} thumbLength
 * @property {number | null} sourceSize
 * @property {number | null} sourceMtimeMs
 */

const ITEM_ROW_SELECT = `
  SELECT
    li.id AS id, li.rel_path AS relPath, li.kind AS kind, li.playable AS playable,
    li.size AS size, li.mtime_ms AS mtimeMs, im.taken_at AS takenAt,
    im.orientation AS orientation, im.thumb_offset AS thumbOffset,
    im.thumb_length AS thumbLength, im.source_size AS sourceSize,
    im.source_mtime_ms AS sourceMtimeMs
  FROM image_meta im JOIN library_items li ON li.id = im.item_id
`;

/**
 * Coerces a raw row's SQLite integer `playable` column (`0`/`1`) to a JS
 * boolean; the caller's own return type states the trusted row shape.
 * @param {any} row - one raw row with a `playable` column
 * @returns {any}
 */
function toItemRow(row) {
  return { ...row, playable: row.playable === 1 };
}

/**
 * Lower/upper bound for a folder-key range that matches every key strictly
 * below `key` (`key/…`), whatever characters — including `_` and `%` — the
 * segments contain. Never use `LIKE`. `key` itself is excluded (see
 * `subtreeBounds` in `library-repo.js` for the same trick on `rel_path`).
 * @param {string} key
 * @returns {[string, string]}
 */
function subtreeBounds(key) {
  return [`${key}/`, `${key}0`];
}

/**
 * Loads up to `limit` `images`-category items that have no `image_meta` row
 * yet, ordered by id, for the sync's stub-insert step.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} afterId - keyset cursor; pass 0 to start from the beginning
 * @param {number} limit
 * @returns {{ id: number, dir: string }[]}
 */
export function listItemsWithoutMeta(db, afterId, limit) {
  return /** @type {{ id: number, dir: string }[]} */ (
    /** @type {unknown} */ (
      db
        .prepare(
          `SELECT id, dir FROM library_items
           WHERE category = 'images' AND id > ?
             AND NOT EXISTS (SELECT 1 FROM image_meta WHERE item_id = library_items.id)
           ORDER BY id
           LIMIT ?`
        )
        .all(afterId, limit)
    )
  );
}

/**
 * Inserts one stub row per given item, in one transaction, ignoring rows
 * whose `item_id` already has a stub (`ON CONFLICT DO NOTHING` — a rerun
 * racing this call never overwrites an already-read header). A no-op when
 * `rows` is empty (no transaction is opened). Must NOT be called inside an
 * open transaction: `BEGIN` then throws and the caller's transaction is left
 * untouched (never rolled back here). A failed insert rolls back the batch,
 * guarding the `ROLLBACK` itself against an implicit SQLite auto-abort.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ itemId: number, folder: string }[]} rows
 * @returns {void}
 */
export function insertMetaStubs(db, rows) {
  if (rows.length === 0) return;
  const insert = db.prepare(
    'INSERT INTO image_meta (item_id, folder) VALUES (?, ?) ON CONFLICT(item_id) DO NOTHING'
  );
  // BEGIN stays outside the try so a failed BEGIN never rolls back someone else's transaction.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      insert.run(row.itemId, row.folder);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction to roll back, e.g. an auto-abort */ }
    throw err;
  }
}

/**
 * Keyset-walks `image_meta` rows whose header is missing or stale — no
 * recorded source size yet, or `source_size`/`source_mtime_ms` no longer
 * match `library_items`, or `meta_version` is not the current one — for the
 * sync's header-read step.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} afterId - keyset cursor on `item_id`; pass 0 to start
 * @param {number} limit
 * @param {number} metaVersion - the current `IMAGE_META_VERSION`
 * @returns {{ itemId: number, relPath: string, ext: string, size: number, mtimeMs: number }[]}
 */
export function listStaleMeta(db, afterId, limit, metaVersion) {
  return /** @type {{ itemId: number, relPath: string, ext: string, size: number, mtimeMs: number }[]} */ (
    /** @type {unknown} */ (
      db
        .prepare(
          `SELECT im.item_id AS itemId, li.rel_path AS relPath, li.ext AS ext,
                  li.size AS size, li.mtime_ms AS mtimeMs
           FROM image_meta im JOIN library_items li ON li.id = im.item_id
           WHERE li.category = 'images' AND im.item_id > ?
             AND (
               im.source_size IS NULL
               OR im.source_size != li.size
               OR im.source_mtime_ms != li.mtime_ms
               OR im.meta_version IS NULL
               OR im.meta_version != ?
             )
           ORDER BY im.item_id
           LIMIT ?`
        )
        .all(afterId, metaVersion, limit)
    )
  );
}

/**
 * Overwrites the header fields of an existing `image_meta` row (a stub must
 * already exist — the sync always inserts stubs before reading headers).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} itemId
 * @param {{ takenAt: string | null, orientation: number | null, thumbOffset: number | null,
 *   thumbLength: number | null, sourceSize: number, sourceMtimeMs: number, metaVersion: number }} meta
 * @returns {void}
 */
export function saveMeta(db, itemId, meta) {
  db.prepare(
    `UPDATE image_meta
     SET taken_at = ?, orientation = ?, thumb_offset = ?, thumb_length = ?,
         source_size = ?, source_mtime_ms = ?, meta_version = ?
     WHERE item_id = ?`
  ).run(
    meta.takenAt ?? null,
    meta.orientation ?? null,
    meta.thumbOffset ?? null,
    meta.thumbLength ?? null,
    meta.sourceSize,
    meta.sourceMtimeMs,
    meta.metaVersion,
    itemId
  );
}

/**
 * Whether `key` addresses a folder that exists in the gallery tree: either
 * some item's folder is exactly `key`, or some item's folder lies in `key`'s
 * subtree. The root (`''`) always exists without a lookup, even in an empty
 * library.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} key
 * @returns {boolean}
 */
export function folderExists(db, key) {
  if (key === '') return true;
  const [lower, upper] = subtreeBounds(key);
  const row = /** @type {{ found: number }} */ (
    db
      .prepare(
        `SELECT EXISTS(
           SELECT 1 FROM image_meta WHERE folder = ? OR (folder >= ? AND folder < ?)
         ) AS found`
      )
      .get(key, lower, upper)
  );
  return row.found === 1;
}

/**
 * Loads every item directly inside folder `key` (exact match on `folder`,
 * not recursive), unsorted.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} key
 * @returns {ItemRow[]}
 */
export function listFolderItems(db, key) {
  return /** @type {any[]} */ (db.prepare(`${ITEM_ROW_SELECT} WHERE im.folder = ?`).all(key)).map(
    toItemRow
  );
}

/**
 * Every distinct folder strictly below `key` (`key`'s whole subtree, `key`
 * itself excluded) with its own direct item count — the raw material
 * `src/library/gallery.js`'s `childFolders` aggregates into `key`'s
 * immediate child folders. For the root (`key === ''`), "below" means every
 * non-root folder.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} key
 * @returns {{ folder: string, count: number }[]}
 */
export function listSubtreeFolderCounts(db, key) {
  if (key === '') {
    return /** @type {{ folder: string, count: number }[]} */ (
      /** @type {unknown} */ (
        db
          .prepare(`SELECT folder, COUNT(*) AS count FROM image_meta WHERE folder != '' GROUP BY folder`)
          .all()
      )
    );
  }
  const [lower, upper] = subtreeBounds(key);
  return /** @type {{ folder: string, count: number }[]} */ (
    /** @type {unknown} */ (
      db
        .prepare(
          'SELECT folder, COUNT(*) AS count FROM image_meta WHERE folder >= ? AND folder < ? GROUP BY folder'
        )
        .all(lower, upper)
    )
  );
}

/**
 * The first playable image in folder `key`'s subtree (`key` itself and every
 * folder below it — for the root, `key === ''`, every folder in the library),
 * in `(folder, rel_path)` binary order — the gallery API's folder-tile cover —
 * or `null` when the subtree has no playable image.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} key
 * @returns {ItemRow | null}
 */
export function findFolderCover(db, key) {
  if (key === '') {
    const row = db
      .prepare(
        `${ITEM_ROW_SELECT}
         WHERE li.kind = 'image' AND li.playable = 1
         ORDER BY im.folder, li.rel_path
         LIMIT 1`
      )
      .get();
    return row ? toItemRow(row) : null;
  }
  const [lower, upper] = subtreeBounds(key);
  const row = db
    .prepare(
      `${ITEM_ROW_SELECT}
       WHERE li.kind = 'image' AND li.playable = 1
         AND (im.folder = ? OR (im.folder >= ? AND im.folder < ?))
       ORDER BY im.folder, li.rel_path
       LIMIT 1`
    )
    .get(key, lower, upper);
  return row ? toItemRow(row) : null;
}

/**
 * Loads exactly the fields the thumbnail route needs: the file to read, its
 * category/kind/playable for the route's pre-checks, and the recorded
 * thumbnail location plus the source size/mtime `verifyThumb` checks it
 * against. `image_meta` fields come back `null` when no row exists yet
 * (item indexed but not yet synced) or a field was never read.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} itemId
 * @returns {{ relPath: string, category: 'movies'|'series'|'music'|'audiobooks'|'images',
 *   kind: 'video'|'audio'|'image', playable: boolean, thumbOffset: number | null,
 *   thumbLength: number | null, sourceSize: number | null, sourceMtimeMs: number | null } | null}
 */
export function getThumbSource(db, itemId) {
  const row = db
    .prepare(
      `SELECT li.rel_path AS relPath, li.category AS category, li.kind AS kind,
              li.playable AS playable, im.thumb_offset AS thumbOffset,
              im.thumb_length AS thumbLength, im.source_size AS sourceSize,
              im.source_mtime_ms AS sourceMtimeMs
       FROM library_items li LEFT JOIN image_meta im ON im.item_id = li.id
       WHERE li.id = ?`
    )
    .get(itemId);
  if (!row) return null;
  return toItemRow(row);
}
