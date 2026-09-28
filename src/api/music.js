// @ts-check

import { requireUser } from '../http/guards.js';
import { sendError, sendJson } from '../http/respond.js';
import { START_THRESHOLD_S } from './progress-rules.js';
import { getAudioRow, listAudioRows, listGroupRows } from '../db/audio-meta-repo.js';
import { getLatestMusicResume, listAudioProgress } from '../db/audio-progress.js';
import { buildAlbums, buildArtistSections } from '../library/audio-groups.js';

/**
 * `:id` pattern shared with Phases 3 and 6: 1–16 digits, no leading zero.
 * Combined with `Number.isSafeInteger` below so an id past
 * `Number.MAX_SAFE_INTEGER` (still 16 digits) is rejected too.
 */
const ID_PATTERN = /^[1-9][0-9]{0,15}$/;

/**
 * Parses a route `:id` param into a safe-integer `library_items.id`, or
 * `null` when it is not one (malformed, or a 16-digit value past
 * `Number.MAX_SAFE_INTEGER`) — the caller answers `404 not_found` either way.
 * @param {string} raw
 * @returns {number | null}
 */
function parseItemId(raw) {
  if (!ID_PATTERN.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Resolves a track's display duration in seconds: its own metadata duration
 * when known (`audio_meta.duration_ms`, converted), else the caller-supplied
 * fallback (a Phase 4 progress row's `duration_seconds`), else `null` — the
 * "Duration without decoding" decision.
 * @param {number | null} durationMs
 * @param {number | null} fallbackSeconds
 * @returns {number | null}
 */
function resolveDurationSeconds(durationMs, fallbackSeconds) {
  if (durationMs != null) return Math.round(durationMs / 1000);
  return fallbackSeconds ?? null;
}

/**
 * Maps an assembled album (`src/library/audio-groups.js`) to the reduced
 * shape used inside `GET /api/music`'s artist sections.
 * @param {import('../library/audio-groups.js').Album} album
 * @returns {{ id: number, title: string | null, year: number | null, trackCount: number, coverId: number }}
 */
function toAlbumSummaryJson(album) {
  return { id: album.id, title: album.title, year: album.year, trackCount: album.members.length, coverId: album.coverId };
}

/**
 * Maps one `buildArtistSections` section to its JSON shape.
 * @param {import('../library/audio-groups.js').ArtistSection} section
 * @returns {{ name: string | null, albums: ReturnType<typeof toAlbumSummaryJson>[] }}
 */
function toArtistSectionJson(section) {
  return { name: section.name, albums: section.albums.map(toAlbumSummaryJson) };
}

/** @typedef {{ trackId: number, albumId: number, title: string, artist: string | null, albumTitle: string | null, coverId: number, position: number, duration: number | null, updatedAt: string }} MusicResumeJson */

/**
 * Builds the Musik "Weiterhören" card's JSON, or `null` when the user has no
 * offerable music row (`getLatestMusicResume`).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} userId
 * @returns {MusicResumeJson | null}
 */
export function buildResumeJson(db, userId) {
  const resumeRow = getLatestMusicResume(db, { userId, startThreshold: START_THRESHOLD_S });
  if (!resumeRow) return null;
  const track = /** @type {import('../db/audio-meta-repo.js').AudioRow} */ (getAudioRow(db, resumeRow.itemId));
  const album = buildAlbums(listGroupRows(db, resumeRow.groupKey))[0];
  return {
    trackId: resumeRow.itemId,
    albumId: album.id,
    title: track.title,
    artist: track.tagArtist ?? album.artist,
    albumTitle: album.title,
    coverId: album.coverId,
    position: resumeRow.position,
    duration: resolveDurationSeconds(track.durationMs, resumeRow.duration),
    updatedAt: new Date(resumeRow.updatedAt).toISOString(),
  };
}

/**
 * `GET /api/music` handler: the "Weiterhören" resume plus every artist's
 * albums (`buildArtistSections` display order).
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {import('../http/router.js').Handler}
 */
function handleOverview(db) {
  return requireUser((_req, res, ctx) => {
    const resume = buildResumeJson(db, /** @type {{ id: number }} */ (ctx.user).id);
    const albums = buildAlbums(listAudioRows(db, 'music'));
    const artists = buildArtistSections(albums).map(toArtistSectionJson);
    sendJson(res, 200, { resume, artists });
  });
}

/**
 * Indexes a user's music progress rows by item id, for the album detail
 * route's per-track duration fallback.
 * @param {import('../db/audio-progress.js').AudioProgressRow[]} rows
 * @returns {Map<number, import('../db/audio-progress.js').AudioProgressRow>}
 */
function indexProgressByItem(rows) {
  return new Map(rows.map((row) => [row.itemId, row]));
}

/**
 * Number of distinct discs among an album's members — the "CD n"
 * sub-heading condition (`discCount > 1`) is decided by the caller (UI).
 * @param {import('../library/audio-groups.js').AudioRow[]} members
 * @returns {number}
 */
function countDiscs(members) {
  return new Set(members.map((member) => member.discNo)).size;
}

/**
 * Maps one album track (an `AudioRow`, already in play order) to its JSON
 * shape, resolving `artist`/`duration` per the endpoint's fallback rules.
 * @param {import('../library/audio-groups.js').AudioRow} track
 * @param {string | null} albumArtist
 * @param {Map<number, import('../db/audio-progress.js').AudioProgressRow>} progressByItem
 * @returns {object}
 */
function toTrackJson(track, albumArtist, progressByItem) {
  const progress = progressByItem.get(track.id) ?? null;
  return {
    id: track.id,
    title: track.title,
    artist: track.tagArtist ?? albumArtist,
    trackNo: track.trackNo,
    discNo: track.discNo,
    duration: resolveDurationSeconds(track.durationMs, progress ? progress.duration : null),
    playable: track.playable,
    ext: track.ext,
  };
}

/**
 * Builds the `GET /api/music/albums/:id` response body for an already-
 * resolved album.
 * @param {import('../library/audio-groups.js').Album} album
 * @param {Map<number, import('../db/audio-progress.js').AudioProgressRow>} progressByItem
 * @returns {object}
 */
function toAlbumDetailJson(album, progressByItem) {
  return {
    id: album.id,
    title: album.title,
    artist: album.artist,
    year: album.year,
    coverId: album.coverId,
    duration: album.durationMs == null ? null : Math.round(album.durationMs / 1000),
    discCount: countDiscs(album.members),
    tracks: album.members.map((track) => toTrackJson(track, album.artist, progressByItem)),
  };
}

/**
 * `GET /api/music/albums/:id` handler: any member id resolves the album via
 * its `group_key` (Group ids decision). `404 not_found` for a malformed or
 * unsafe id, an unknown item, one outside the `music` category, or one
 * without an `audio_meta` row yet.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {import('../http/router.js').Handler}
 */
function handleAlbumDetail(db) {
  return requireUser((_req, res, ctx) => {
    const id = parseItemId(ctx.params.id);
    const row = id === null ? undefined : getAudioRow(db, id);
    if (!row || row.category !== 'music') {
      sendError(res, 404, 'not_found');
      return;
    }
    const album = buildAlbums(listGroupRows(db, row.groupKey))[0];
    const progressByItem = indexProgressByItem(
      listAudioProgress(db, /** @type {{ id: number }} */ (ctx.user).id, 'music'),
    );
    sendJson(res, 200, toAlbumDetailJson(album, progressByItem));
  });
}

/**
 * Registers the Musik overview and album detail routes, both behind
 * `requireUser`. `src/api/` knows nothing about audio file formats — every
 * tag/format decision already happened in the metadata pass
 * (`src/library/audio-meta.js`) and is read back here through the joined
 * `audio_meta` rows.
 * @param {ReturnType<typeof import('../http/router.js').createRouter>} router
 * @param {{ db: import('node:sqlite').DatabaseSync }} deps
 * @returns {void}
 */
export function registerMusicRoutes(router, { db }) {
  router.add('GET', '/api/music', handleOverview(db));
  router.add('GET', '/api/music/albums/:id', handleAlbumDetail(db));
}
