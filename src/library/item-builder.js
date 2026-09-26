// @ts-check
import { join } from 'node:path';
import { kindsFor } from './categories.js';
import { EXTENSIONS, SCAN_VERSION, resolvePlayable } from './parsers/compat.js';
import { cleanName, sortKey, stripExtension } from './parsers/text.js';
import { parseMovie } from './parsers/movie.js';
import { parseEpisode } from './parsers/series.js';
import { sniffMp4Codecs } from './tags/mp4-codec.js';

/**
 * Builds one `library_items` row from a single already-stat'd candidate
 * file: extension + kind admission, the category-specific parser,
 * `resolvePlayable` (with an MP4 codec sniff for `sniff`-table extensions
 * when `size > 0`), `sortKey`, `scan_version` and timestamps.
 *
 * Spec: docs/specs/spec-library-video.md, "Scanner modules" (`item-builder.js`).
 */

/** @typedef {import('node:fs').Stats} Stats */
/** @typedef {'movies' | 'series' | 'music' | 'audiobooks' | 'images'} Category */
/** @typedef {import('../db/library-repo.js').LibraryItemInput} LibraryItemInput */

/**
 * `buildItem`'s row also carries the series identity a later series upsert
 * needs (`dir-sync.js`): `series_key` matches `library_series.series_key`
 * and `series_year` its `year` column — both present only for
 * `category: 'series'`. `series_id` is intentionally left unset here: this
 * module never touches the database (`src/library/` has no DB access, per
 * the architecture boundaries), so the id can only be assigned once the
 * series row has been upserted by that later step. See the spec's Decision
 * log (#32) for this hand-off.
 * @typedef {LibraryItemInput & { series_key?: string, series_year?: number | null }} BuiltItemRow
 */

/**
 * @typedef {object} BuildItemInput
 * @property {string} mediaRoot absolute path to `MEDIA_ROOT`
 * @property {string} relPath '/'-separated path relative to `MEDIA_ROOT`,
 *   including the leading category-root folder segment (e.g.
 *   `"Filme/Inception (2010)/inception.mp4"`) — matches `library_items.rel_path`
 * @property {Category} category the category the file's root folder resolved to
 * @property {Stats} stat an already-collected, successful `fs.Stats` for the file
 * @property {() => number} now injected clock (epoch ms), passed through to
 *   the parsers for their year upper bound
 */

/**
 * @param {string} fileName the last path segment, with extension
 * @returns {string} lower-case extension without the dot, or `''` when `fileName` has none
 */
function extensionOf(fileName) {
  const idx = fileName.lastIndexOf('.');
  return idx > 0 ? fileName.slice(idx + 1).toLowerCase() : '';
}

/**
 * Strips the leading category-root segment from a `MEDIA_ROOT`-relative
 * path, so the parsers (which work on paths relative to the category
 * folder) never need to know which alias folder ("Filme" vs "Movies")
 * actually matched on disk.
 * @param {string} relPath
 * @returns {string}
 */
function relInCategory(relPath) {
  const idx = relPath.indexOf('/');
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

/**
 * @typedef {object} Grouping
 * @property {string} title
 * @property {number | null} year
 * @property {string} [seriesKey]
 * @property {string} [seriesTitle]
 * @property {number | null} [seriesYear]
 * @property {number | null} [season]
 * @property {number | null} [episode]
 * @property {number | null} [episodeEnd]
 */

/**
 * Runs the category-specific parser. Music/audiobook/image files (P2
 * minimal admission) get only a cleaned title and no grouping beyond `dir`.
 * @param {Category} category
 * @param {string} relPath
 * @param {string} stem file stem (extension already stripped)
 * @param {() => number} now
 * @returns {Grouping}
 */
function buildGrouping(category, relPath, stem, now) {
  if (category === 'movies') {
    const { title, year } = parseMovie(relInCategory(relPath), now);
    return { title, year };
  }
  if (category === 'series') {
    const episode = parseEpisode(relInCategory(relPath), now);
    return {
      title: episode.title,
      year: null,
      seriesKey: episode.seriesKey,
      seriesTitle: episode.seriesTitle,
      seriesYear: episode.seriesYear,
      season: episode.season,
      episode: episode.episode,
      episodeEnd: episode.episodeEnd,
    };
  }
  return { title: cleanName(stem), year: null };
}

/**
 * @param {string} relPath
 * @returns {{ dir: string, fileName: string }}
 */
function splitRelPath(relPath) {
  const slashIdx = relPath.lastIndexOf('/');
  return slashIdx === -1
    ? { dir: '', fileName: relPath }
    : { dir: relPath.slice(0, slashIdx), fileName: relPath.slice(slashIdx + 1) };
}

/**
 * Builds one `library_items` row, or `null` when the file's extension is not
 * in the direct-play compatibility table or its kind is not admitted for
 * `category` (e.g. a `.jpg` under `Filme/`, a `.nfo`/`.srt`/`.vtt` anywhere,
 * a file with no extension). The only I/O this module performs itself is the
 * MP4 codec sniff, and only for `sniff`-table extensions with `size > 0` —
 * never for a zero-byte file, which `resolvePlayable` always rejects anyway.
 * @param {BuildItemInput} input
 * @returns {Promise<BuiltItemRow | null>}
 */
export async function buildItem({ mediaRoot, relPath, category, stat, now }) {
  const { dir, fileName } = splitRelPath(relPath);
  const ext = extensionOf(fileName);
  const entry = EXTENSIONS[ext];
  if (!entry || !kindsFor(category).includes(entry.kind)) {
    return null;
  }

  const codecs = entry.sniff && stat.size > 0 ? await sniffMp4Codecs(join(mediaRoot, relPath)) : null;
  const playable = resolvePlayable({ ext, size: stat.size, codecs });
  const grouping = buildGrouping(category, relPath, stripExtension(fileName), now);

  return {
    rel_path: relPath,
    dir,
    category,
    kind: entry.kind,
    ext,
    title: grouping.title,
    sort_title: sortKey(grouping.title),
    year: grouping.year,
    series_key: grouping.seriesKey,
    series_title: grouping.seriesTitle,
    series_year: grouping.seriesYear,
    season: grouping.season ?? null,
    episode: grouping.episode ?? null,
    episode_end: grouping.episodeEnd ?? null,
    video_codec: codecs?.video[0] ?? null,
    audio_codec: codecs?.audio[0] ?? null,
    playable,
    size: stat.size,
    mtime_ms: Math.trunc(stat.mtimeMs),
    scan_version: SCAN_VERSION,
  };
}
