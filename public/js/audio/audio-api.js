/**
 * Music & audiobook API client, thin wrappers over `../lib/api.js`
 * `request` — see spec-music-audiobooks.md "API".
 */
import { request } from '../lib/api.js';

/** @typedef {{ trackId: number, albumId: number, title: string, artist: string | null, albumTitle: string | null, coverId: number, position: number, duration: number | null, updatedAt: string }} MusicResume */
/** @typedef {{ id: number, title: string | null, year: number | null, trackCount: number, coverId: number }} AlbumSummary */
/** @typedef {{ name: string | null, albums: AlbumSummary[] }} ArtistSection */
/** @typedef {{ resume: MusicResume | null, artists: ArtistSection[] }} MusicOverview */
/** @typedef {{ id: number, title: string, artist: string | null, trackNo: number | null, discNo: number, duration: number | null, playable: boolean, ext: string }} AlbumTrack */
/** @typedef {{ id: number, title: string | null, artist: string | null, year: number | null, coverId: number, duration: number | null, discCount: number, tracks: AlbumTrack[] }} AlbumDetail */
/** @typedef {'new' | 'in_progress' | 'finished'} AudiobookState */
/** @typedef {{ id: number, title: string, author: string | null, coverId: number, fileCount: number, duration: number | null, state: AudiobookState, fraction: number | null, lastPlayedAt: string | null }} AudiobookSummary */
/** @typedef {{ books: AudiobookSummary[] }} AudiobookGrid */
/** @typedef {{ position: number, duration: number | null, finished: boolean } | null} FileProgress */
/** @typedef {{ id: number, title: string, trackNo: number | null, discNo: number, duration: number | null, playable: boolean, ext: string, progress: FileProgress }} AudiobookFile */
/** @typedef {{ itemId: number, position: number } | null} AudiobookResume */
/** @typedef {AudiobookSummary & { resume: AudiobookResume, files: AudiobookFile[] }} AudiobookDetail */

/**
 * Fetches the Musik overview (resume card + artist/album sections).
 * @returns {Promise<MusicOverview>}
 */
export async function getMusicOverview() {
  const { data } = await request('GET', '/api/music');
  return /** @type {MusicOverview} */ (data);
}

/**
 * Fetches one album's detail (track list in play order).
 * @param {number} id
 * @returns {Promise<AlbumDetail>}
 */
export async function getAlbum(id) {
  const { data } = await request('GET', `/api/music/albums/${encodeURIComponent(id)}`);
  return /** @type {AlbumDetail} */ (data);
}

/**
 * Fetches the Hörbücher grid (all books + their "Weiterhören" state).
 * @returns {Promise<AudiobookGrid>}
 */
export async function getAudiobooks() {
  const { data } = await request('GET', '/api/audiobooks');
  return /** @type {AudiobookGrid} */ (data);
}

/**
 * Fetches one audiobook's detail (files in play order + derived resume).
 * @param {number} id
 * @returns {Promise<AudiobookDetail>}
 */
export async function getAudiobook(id) {
  const { data } = await request('GET', `/api/audiobooks/${encodeURIComponent(id)}`);
  return /** @type {AudiobookDetail} */ (data);
}
