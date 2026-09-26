/**
 * Write- and read-side SQL for the audio metadata pass and the music/
 * audiobooks APIs (`src/library/audio-meta.js`, `src/api/music.js`,
 * `src/api/audiobooks.js`). `audio_meta` is defined in
 * `src/db/migrations/004-audio-meta.sql`, one row per `library_items` row of
 * category `music` or `audiobooks`, `ON DELETE CASCADE` from `library_items`.
 * `upsertAudioMeta`'s input mirrors the table's column names verbatim (like
 * `library-repo.js`'s `upsertItem`), so the metadata pass can pass a row
 * straight through without a naming translation; the read side maps to
 * camelCase here, since those rows feed the API layer directly.
 * @typedef {object} AudioMetaInput
 * @property {number} item_id
 * @property {number} meta_version
 * @property {number} source_mtime_ms
 * @property {number} source_size
 * @property {string} group_key
 * @property {string | null} [group_title]
 * @property {string | null} [group_artist]
 * @property {string} title
 * @property {number | null} [track_no]
 * @property {number} disc_no
 * @property {string | null} [tag_artist]
 * @property {string | null} [tag_album_artist]
 * @property {string | null} [tag_album]
 * @property {number | null} [tag_year]
 * @property {number | null} [duration_ms]
 * @property {'id3v2' | 'flac' | null} [tag_format]
 * @typedef {object} AudioRow
 * @property {number} id
 * @property {string} relPath
 * @property {string} dir
 * @property {'music' | 'audiobooks'} category
 * @property {string} ext
 * @property {boolean} playable
 * @property {string} groupKey
 * @property {string | null} groupTitle
 * @property {string | null} groupArtist
 * @property {string} title
 * @property {number | null} trackNo
 * @property {number} discNo
 * @property {string | null} tagArtist
 * @property {string | null} tagAlbumArtist
 * @property {string | null} tagAlbum
 * @property {number | null} tagYear
 * @property {number | null} durationMs
 */

const UPSERT_AUDIO_META_SQL = `
  INSERT INTO audio_meta (
    item_id, meta_version, source_mtime_ms, source_size, group_key,
    group_title, group_artist, title, track_no, disc_no,
    tag_artist, tag_album_artist, tag_album, tag_year, duration_ms, tag_format
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(item_id) DO UPDATE SET
    meta_version = excluded.meta_version,
    source_mtime_ms = excluded.source_mtime_ms,
    source_size = excluded.source_size,
    group_key = excluded.group_key,
    group_title = excluded.group_title,
    group_artist = excluded.group_artist,
    title = excluded.title,
    track_no = excluded.track_no,
    disc_no = excluded.disc_no,
    tag_artist = excluded.tag_artist,
    tag_album_artist = excluded.tag_album_artist,
    tag_album = excluded.tag_album,
    tag_year = excluded.tag_year,
    duration_ms = excluded.duration_ms,
    tag_format = excluded.tag_format
`;

// Shared projection for every joined read: library_items columns the API/
// grouping layer needs plus every audio_meta column except the bookkeeping
// ones (meta_version, source_size, source_mtime_ms are pass-internal).
const JOINED_ROW_SELECT = `
  SELECT
    li.id AS id,
    li.rel_path AS relPath,
    li.dir AS dir,
    li.category AS category,
    li.ext AS ext,
    li.playable AS playable,
    am.group_key AS groupKey,
    am.group_title AS groupTitle,
    am.group_artist AS groupArtist,
    am.title AS title,
    am.track_no AS trackNo,
    am.disc_no AS discNo,
    am.tag_artist AS tagArtist,
    am.tag_album_artist AS tagAlbumArtist,
    am.tag_album AS tagAlbum,
    am.tag_year AS tagYear,
    am.duration_ms AS durationMs
  FROM library_items li
  INNER JOIN audio_meta am ON am.item_id = li.id
`;

/**
 * SQLite has no boolean type; `library_items.playable` is stored as 0/1
 * (constitution CHECK), so the joined reads convert it to a real boolean
 * here rather than leaking the storage representation into the API layer.
 * @param {Record<string, unknown>} row
 * @returns {AudioRow}
 */
function toAudioRow(row) {
  return /** @type {AudioRow} */ ({ ...row, playable: row.playable === 1 });
}

/**
 * Selects every `library_items` row of category `music` or `audiobooks`
 * whose `audio_meta` row is missing, or stale by `meta_version` (a parser/
 * mapping change) or by `source_size`/`source_mtime_ms` (the file changed
 * since it was last read) — the audio metadata pass's work list, ordered by
 * id for a deterministic, resumable run.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} metaVersion - the pass's current `AUDIO_META_VERSION`
 * @returns {import('./library-repo.js').LibraryItemRow[]}
 */
export function listStaleAudioItems(db, metaVersion) {
  return /** @type {import('./library-repo.js').LibraryItemRow[]} */ (
    /** @type {unknown} */ (
      db
        .prepare(
          `SELECT li.* FROM library_items li
           LEFT JOIN audio_meta am ON am.item_id = li.id
           WHERE li.category IN ('music', 'audiobooks')
             AND (
               am.item_id IS NULL
               OR am.meta_version != ?
               OR am.source_size != li.size
               OR am.source_mtime_ms != li.mtime_ms
             )
           ORDER BY li.id`
        )
        .all(metaVersion)
    )
  );
}

/**
 * Inserts the `audio_meta` row for a freshly read item, or updates one
 * matched by `item_id`, via `ON CONFLICT(item_id) DO UPDATE` (never `INSERT
 * OR REPLACE`, which would defeat `ON DELETE CASCADE` semantics on `item_id`
 * as the primary key). Every column is overwritten on update, including the
 * staleness fields, so a later `listStaleAudioItems` call sees the item as
 * current.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {AudioMetaInput} row
 * @returns {void}
 */
export function upsertAudioMeta(db, row) {
  db.prepare(UPSERT_AUDIO_META_SQL).run(
    row.item_id,
    row.meta_version,
    row.source_mtime_ms,
    row.source_size,
    row.group_key,
    row.group_title ?? null,
    row.group_artist ?? null,
    row.title,
    row.track_no ?? null,
    row.disc_no,
    row.tag_artist ?? null,
    row.tag_album_artist ?? null,
    row.tag_album ?? null,
    row.tag_year ?? null,
    row.duration_ms ?? null,
    row.tag_format ?? null
  );
}

/**
 * Loads every `music` or `audiobooks` item that already has an `audio_meta`
 * row (an `INNER JOIN`, not a `LEFT JOIN`: an item the pass has not reached
 * yet stays invisible to the views, per the freshness/visibility rule), in
 * id order. Group assembly (`src/library/audio-groups.js`) does its own
 * sorting on top of this.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {'music' | 'audiobooks'} category
 * @returns {AudioRow[]}
 */
export function listAudioRows(db, category) {
  return db
    .prepare(`${JOINED_ROW_SELECT} WHERE li.category = ? ORDER BY li.id`)
    .all(category)
    .map(toAudioRow);
}

/**
 * Loads every member of one album/book group (`audio_meta.group_key`), in id
 * order. `group_key` always starts with the category folder segment (Phase 2
 * D3), so it disambiguates music from audiobooks without an extra parameter.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} groupKey
 * @returns {AudioRow[]}
 */
export function listGroupRows(db, groupKey) {
  return db
    .prepare(`${JOINED_ROW_SELECT} WHERE am.group_key = ? ORDER BY li.id`)
    .all(groupKey)
    .map(toAudioRow);
}

/**
 * Loads the joined row for one item id, for endpoints that resolve a single
 * member (e.g. the cover route). Returns `undefined` for an id that is not
 * indexed, not `music`/`audiobooks`, or has no `audio_meta` row yet.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} itemId
 * @returns {AudioRow | undefined}
 */
export function getAudioRow(db, itemId) {
  const row = db.prepare(`${JOINED_ROW_SELECT} WHERE li.id = ?`).get(itemId);
  return row ? toAudioRow(row) : undefined;
}
