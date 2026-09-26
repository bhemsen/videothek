import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveMediaPath } from './paths.js';

/**
 * Content type for every WebVTT sidecar served by `/media/:id/subtitles/:n`
 * (spec-video-streaming.md, "Subtitle sidecars" decision). WebVTT mandates
 * UTF-8, and sidecars are served byte-for-byte with this charset.
 */
export const SUBTITLE_CONTENT_TYPE = 'text/vtt; charset=utf-8';

const MAX_MIDDLE_LENGTH = 64;
const LANG_PATTERN = /^[a-z]{2,3}$/i;

/**
 * @typedef {object} SubtitleSourceRow
 * @property {string} kind - `library_items.kind`; only `'video'` rows can
 *   have subtitle sidecars.
 * @property {string} rel_path - `library_items.rel_path`, the item's path
 *   relative to `mediaRoot`.
 */

/**
 * @typedef {object} SubtitleTrack
 * @property {number} index - 0-based position among this item's sidecars,
 *   sorted by NFC file name in code-unit order.
 * @property {string | null} lang - lower-cased 2-3 letter code parsed from
 *   the sidecar's `<basename>.<lang>.vtt` suffix, or `null` when the suffix
 *   is absent or does not look like a language code.
 * @property {string | null} label - the sidecar's suffix as written, or
 *   `null` for the bare `<basename>.vtt` (Jellyfin flag suffixes such as
 *   `.de.forced` are not interpreted beyond this).
 * @property {string} path - absolute filesystem path, already verified by
 *   `resolveMediaPath` to lie inside `mediaRoot`.
 */

/**
 * Discovers `.vtt` subtitle sidecars for a video library item by reading its
 * directory on every call — nothing is indexed or cached, per the "Subtitle
 * sidecars" decision in spec-video-streaming.md. Only `kind: 'video'` rows
 * are considered; every failure (row outside `mediaRoot`, missing file or
 * directory, unreadable directory) resolves to `[]` rather than throwing.
 *
 * @param {string} mediaRoot - absolute path to the media root directory.
 * @param {SubtitleSourceRow} row - the library item to find sidecars for.
 * @returns {Promise<SubtitleTrack[]>}
 */
export async function listSubtitles(mediaRoot, row) {
  if (row.kind !== 'video') return [];

  const itemPath = await resolveMediaPath(mediaRoot, row.rel_path);
  if (itemPath === null) return [];

  const dir = path.dirname(itemPath);
  const relDir = path.dirname(row.rel_path);
  const baseLower = path.basename(itemPath, path.extname(itemPath)).normalize('NFC').toLowerCase();

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = collectCandidates(entries, baseLower);
  candidates.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return buildTracks(mediaRoot, relDir, candidates);
}

/**
 * Filters a directory listing down to `.vtt` regular files whose stem
 * belongs to the given video basename (NFC + case-insensitive match).
 *
 * @param {import('node:fs').Dirent[]} entries
 * @param {string} baseLower - NFC-normalised, lower-cased video basename.
 * @returns {Array<{ name: string, middle: string | null }>}
 */
function collectCandidates(entries, baseLower) {
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name.normalize('NFC');
    if (!name.toLowerCase().endsWith('.vtt')) continue;
    const stem = name.slice(0, -'.vtt'.length);
    const middle = matchMiddle(stem, baseLower);
    if (middle === undefined) continue;
    candidates.push({ name, middle });
  }
  return candidates;
}

/**
 * Matches a sidecar's stem (its file name without the `.vtt` suffix)
 * against `<basename>` or `<basename>.<middle>`, case-insensitively after
 * NFC normalisation.
 *
 * @param {string} stem - sidecar file name without its `.vtt` suffix (NFC).
 * @param {string} baseLower - NFC-normalised, lower-cased video basename.
 * @returns {string | null | undefined} `null` for an exact `<basename>`
 *   match, the `middle` suffix (original casing preserved) for
 *   `<basename>.<middle>` when `middle` is 1-64 characters long, or
 *   `undefined` when `stem` does not belong to this video at all.
 */
function matchMiddle(stem, baseLower) {
  const stemLower = stem.toLowerCase();
  if (stemLower === baseLower) return null;
  const prefix = `${baseLower}.`;
  if (!stemLower.startsWith(prefix)) return undefined;
  const middle = stem.slice(prefix.length);
  return middle.length > 0 && middle.length <= MAX_MIDDLE_LENGTH ? middle : undefined;
}

/**
 * Resolves each sorted candidate's sidecar path through `resolveMediaPath`
 * and assigns its final, compacted index.
 *
 * @param {string} mediaRoot
 * @param {string} relDir - directory of the item, relative to `mediaRoot`
 *   (`'.'` when the item sits directly in `mediaRoot`).
 * @param {Array<{ name: string, middle: string | null }>} candidates
 * @returns {Promise<SubtitleTrack[]>}
 */
async function buildTracks(mediaRoot, relDir, candidates) {
  const tracks = [];
  for (const { name, middle } of candidates) {
    const relPath = relDir === '.' ? name : `${relDir}/${name}`;
    const sidecarPath = await resolveMediaPath(mediaRoot, relPath);
    if (sidecarPath === null) continue;
    tracks.push({
      index: tracks.length,
      lang: middle !== null && LANG_PATTERN.test(middle) ? middle.toLowerCase() : null,
      label: middle,
      path: sidecarPath,
    });
  }
  return tracks;
}
