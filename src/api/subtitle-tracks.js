// @ts-check

/**
 * The single subtitle list for an item: source-folder sidecars first, then
 * the fresh conversion's published sidecars. Shared by the item detail JSON
 * and `GET /media/:id/subtitles/:n` so indices always agree.
 * See docs/specs/spec-converter-adapter.md, Prior decisions ("Subtitle list").
 */

import { getFreshConversion } from '../db/conversions.js';
import { resolveMediaPath } from '../media/paths.js';
import { listSubtitles } from '../media/subtitles.js';

const SIDECAR_FILE_RE = /^sub-\d{1,2}\.vtt$/;

/**
 * @typedef {{ index: number, lang: string | null, label: string | null, path: string }} ItemSubtitleTrack
 */

/**
 * Parses the stored `conversions.sidecars` JSON defensively into validated
 * `{ file, lang }` entries; anything malformed yields no entries.
 * @param {string | null | undefined} raw
 * @returns {Array<{ file: string, lang: string | null }>}
 */
function parseSidecars(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue;
    const { file, lang } = /** @type {Record<string, unknown>} */ (entry);
    if (typeof file !== 'string' || !SIDECAR_FILE_RE.test(file)) continue;
    entries.push({ file, lang: typeof lang === 'string' ? lang : null });
  }
  return entries;
}

/**
 * Lists an item's subtitle tracks: source-folder sidecars (`listSubtitles`),
 * then — only when `getFreshConversion` finds a row — its stored sidecars in
 * stored order, each resolved through `resolveMediaPath(convertDir, ...)`.
 * Non-video rows get no converted tracks. Invalid entries are dropped and indices compacted over the combined list.
 * The `path` field is for streaming only and must never be put into JSON.
 * @param {{ db: import('node:sqlite').DatabaseSync, mediaRoot: string, convertDir: string }} deps
 * @param {import('../db/library-repo.js').LibraryItemRow} row
 * @returns {Promise<ItemSubtitleTrack[]>}
 */
export async function listItemSubtitles({ db, mediaRoot, convertDir }, row) {
  const source = await listSubtitles(mediaRoot, row);
  /** @type {ItemSubtitleTrack[]} */
  const tracks = source.map(({ lang, label, path }, index) => ({ index, lang, label, path }));
  if (row.kind !== 'video') return tracks;
  const conversion = getFreshConversion(db, row);
  if (!conversion) return tracks;
  for (const { file, lang } of parseSidecars(conversion.sidecars)) {
    const resolved = await resolveMediaPath(convertDir, `${conversion.storage_key}/${file}`);
    if (resolved === null) continue;
    tracks.push({ index: tracks.length, lang, label: lang, path: resolved });
  }
  return tracks;
}
