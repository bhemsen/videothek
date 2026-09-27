// @ts-check

/**
 * Item JSON serializer shared by every library route
 * (`src/api/library.js`) and later phases (Phase 3 adds `next`/`subtitles`
 * to the single-item response only, never here). Works on a bare
 * `library_items` row, no join required. `rel_path`/`dir` are never sent to
 * clients; `fileName` is derived from `rel_path`'s last path segment.
 * @typedef {import('../db/library-repo.js').LibraryItemRow} LibraryItemRow
 */

/**
 * @typedef {{
 *   id: number,
 *   category: string,
 *   kind: string,
 *   title: string,
 *   year: number | null,
 *   ext: string,
 *   size: number,
 *   playable: boolean,
 *   videoCodec: string | null,
 *   audioCodec: string | null,
 *   addedAt: string,
 *   seriesId: number | null,
 *   seriesTitle: string | null,
 *   season: number | null,
 *   episode: number | null,
 *   episodeEnd: number | null,
 *   fileName: string,
 * }} ItemJson
 */

/**
 * Builds the item JSON for a full `library_items` row. Every key is always
 * present (`null` when not applicable) — never `undefined` — and the
 * timestamp is an ISO-8601 string.
 * @param {LibraryItemRow} row
 * @returns {ItemJson}
 */
export function toItemJson(row) {
  return {
    id: row.id,
    category: row.category,
    kind: row.kind,
    title: row.title,
    year: row.year ?? null,
    ext: row.ext,
    size: row.size,
    playable: Boolean(row.playable),
    videoCodec: row.video_codec ?? null,
    audioCodec: row.audio_codec ?? null,
    addedAt: new Date(row.added_at).toISOString(),
    seriesId: row.series_id ?? null,
    seriesTitle: row.series_title ?? null,
    season: row.season ?? null,
    episode: row.episode ?? null,
    episodeEnd: row.episode_end ?? null,
    fileName: row.rel_path.slice(row.rel_path.lastIndexOf('/') + 1),
  };
}
