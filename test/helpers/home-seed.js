// @ts-check

/**
 * Shared seed helpers for the `/api/home/*` test suite (`test/api/home-params.test.js`,
 * `test/api/home-listening.test.js`, `test/api/home-previews.test.js`,
 * `test/db/home-queries.test.js`). Every helper inserts through the real
 * repositories (`upsertItem`, `upsertSeries`, `upsertAudioMeta`,
 * `insertMetaStubs`, `upsertProgress`), so no test needs raw SQL. `dir` is
 * always `relPath`'s parent path (`''` at root) and `size` is a fixed 1000,
 * so the embedded-thumb freshness check (`sourceSize === size &&
 * sourceMtimeMs === mtimeMs`) can be satisfied deterministically.
 */

import { upsertItem, upsertSeries } from '../../src/db/library-repo.js';
import { upsertAudioMeta } from '../../src/db/audio-meta-repo.js';
import { insertMetaStubs } from '../../src/db/image-meta.js';
import { upsertProgress } from '../../src/db/progress.js';

const SIZE = 1000;

/**
 * `relPath`'s parent directory (`LibraryItemInput.dir`); `''` for a
 * root-level file.
 * @param {string} relPath
 * @returns {string}
 */
function dirOf(relPath) {
  const index = relPath.lastIndexOf('/');
  return index === -1 ? '' : relPath.slice(0, index);
}

/**
 * Seeds one `movies` item.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ relPath: string, title: string, addedAt: number, mtimeMs?: number, playable?: boolean, year?: number | null }} params
 * @returns {number} the item id
 */
export function seedMovie(db, { relPath, title, addedAt, mtimeMs = 1_700_000_000_000, playable = true, year = null }) {
  return upsertItem(
    db,
    {
      rel_path: relPath, dir: dirOf(relPath), category: 'movies', kind: 'video', ext: 'mp4',
      title, sort_title: title.toLowerCase(), year, playable, size: SIZE, mtime_ms: mtimeMs, scan_version: 1,
    },
    addedAt
  );
}

/**
 * Seeds one series episode, creating (or reusing) its `library_series` row
 * by `seriesKey`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ seriesKey: string, seriesTitle: string, relPath: string, addedAt: number, mtimeMs?: number,
 *   season?: number, episode?: number, playable?: boolean }} params
 * @returns {number} the episode item id
 */
export function seedEpisode(
  db,
  { seriesKey, seriesTitle, relPath, addedAt, mtimeMs = 1_700_000_000_000, season = 1, episode = 1, playable = true }
) {
  const seriesId = upsertSeries(
    db,
    { series_key: seriesKey, title: seriesTitle, sort_title: seriesTitle.toLowerCase() },
    addedAt
  );
  return upsertItem(
    db,
    {
      rel_path: relPath, dir: dirOf(relPath), category: 'series', kind: 'video', ext: 'mp4',
      title: `S${season}E${episode}`, sort_title: `s${season}e${episode}`,
      series_id: seriesId, series_title: seriesTitle, season, episode,
      playable, size: SIZE, mtime_ms: mtimeMs, scan_version: 1,
    },
    addedAt
  );
}

/**
 * Seeds one `music`/`audiobooks` file, with its `audio_meta` row unless
 * `withMeta` is `false` (an item the metadata pass has not reached yet).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ category: 'music' | 'audiobooks', relPath: string, groupKey: string, groupTitle: string | null,
 *   groupArtist?: string | null, title: string, trackNo?: number | null, addedAt: number, mtimeMs?: number,
 *   durationMs?: number | null, playable?: boolean, withMeta?: boolean }} params
 * @returns {number} the item id
 */
export function seedAudio(
  db,
  {
    category, relPath, groupKey, groupTitle, groupArtist = null, title, trackNo = null, addedAt,
    mtimeMs = 1_700_000_000_000, durationMs = 180_000, playable = true, withMeta = true,
  }
) {
  const itemId = upsertItem(
    db,
    {
      rel_path: relPath, dir: dirOf(relPath), category, kind: 'audio', ext: 'mp3',
      title, sort_title: title.toLowerCase(), playable, size: SIZE, mtime_ms: mtimeMs, scan_version: 1,
    },
    addedAt
  );
  if (withMeta) {
    upsertAudioMeta(db, {
      item_id: itemId, meta_version: 1, source_mtime_ms: mtimeMs, source_size: SIZE,
      group_key: groupKey, group_title: groupTitle, group_artist: groupArtist,
      title, track_no: trackNo, disc_no: 1, duration_ms: durationMs, tag_format: null,
    });
  }
  return itemId;
}

/**
 * Seeds one `images` item directly inside `folder`, plus its `image_meta`
 * stub (the join `src/db/image-meta.js` reads on requires it).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ relPath: string, folder: string, addedAt: number, mtimeMs?: number, playable?: boolean, kind?: 'image' | 'video' }} params
 * @returns {number} the item id
 */
export function seedImage(
  db,
  { relPath, folder, addedAt, mtimeMs = 1_700_000_000_000, playable = true, kind = 'image' }
) {
  const itemId = upsertItem(
    db,
    {
      rel_path: relPath, dir: dirOf(relPath), category: 'images', kind, ext: kind === 'video' ? 'mp4' : 'jpg',
      title: relPath, sort_title: relPath.toLowerCase(), playable, size: SIZE, mtime_ms: mtimeMs, scan_version: 1,
    },
    addedAt
  );
  insertMetaStubs(db, [{ itemId, folder }]);
  return itemId;
}

/**
 * Seeds one progress row via the real upsert.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ userId: number, relPath: string, position: number, duration: number, finished?: boolean, updatedAt: number }} params
 * @returns {void}
 */
export function seedProgress(db, { userId, relPath, position, duration, finished = false, updatedAt }) {
  upsertProgress(db, { userId, relPath, positionSeconds: position, durationSeconds: duration, finished, updatedAt });
}
