/**
 * Pure Musik helpers shared by the overview and album views: queue items on
 * the #72 `QueueItem` convention (`subtitle` = track artist, `groupTitle` =
 * album title), the resume start index, the playing-row key and the
 * disc-heading layout. No DOM access. See spec-music-audiobooks.md
 * "Start positions", "Rows", "Views" and the #72 decision-log entry.
 */

/** @typedef {import('./audio-api.js').AlbumDetail} AlbumDetail */
/** @typedef {import('./audio-api.js').AlbumTrack} AlbumTrack */
/** @typedef {import('./queue.js').QueueItem} QueueItem */
/** @typedef {{ item: { id: number }, groupId: number, mode: string }} PlayingState */
/** @typedef {{ kind: 'disc', discNo: number } | { kind: 'track', track: AlbumTrack, index: number }} TrackListEntry */

export const MIDDLE_DOT = '·';
export const UNKNOWN_ARTIST = 'Unbekannter Interpret';
export const UNTITLED_ALBUM = 'Einzeltitel';

/**
 * Builds the album queue. Every track starts at 0, except the resumed track
 * (when `resume` is given), which starts at `resume.position` — the start
 * travels on the item itself (spec "Music resume", "Start positions").
 * @param {AlbumDetail} album
 * @param {{ trackId: number, position: number } | null} [resume]
 * @returns {QueueItem[]}
 */
export function buildAlbumQueue(album, resume = null) {
  const groupTitle = album.title ?? UNTITLED_ALBUM;
  return album.tracks.map((track) => ({
    id: track.id,
    title: track.title,
    subtitle: track.artist ?? UNKNOWN_ARTIST,
    groupTitle,
    coverId: album.coverId,
    duration: track.duration,
    playable: track.playable,
    start: resume !== null && track.id === resume.trackId ? resume.position : 0,
  }));
}

/**
 * Index of `trackId` in the album's tracks, or 0 when it is not a member.
 * @param {AlbumDetail} album
 * @param {number} trackId
 * @returns {number}
 */
export function resumeStartIndex(album, trackId) {
  return Math.max(0, album.tracks.findIndex((track) => track.id === trackId));
}

/**
 * The id of the track to highlight on the album page: the player's current
 * item, only while it plays this album's music queue (`mode`, `groupId`).
 * @param {PlayingState | null} state
 * @param {number} albumId
 * @returns {number | null}
 */
export function activeTrackId(state, albumId) {
  if (state === null || state.mode !== 'music' || state.groupId !== albumId) return null;
  return state.item.id;
}

/**
 * The track list in order, with a disc heading before each disc's first
 * track — only when the album has more than one disc.
 * @param {AlbumDetail} album
 * @returns {TrackListEntry[]}
 */
export function trackListEntries(album) {
  /** @type {TrackListEntry[]} */
  const entries = [];
  let lastDisc = /** @type {number | null} */ (null);
  album.tracks.forEach((track, index) => {
    if (album.discCount > 1 && track.discNo !== lastDisc) {
      entries.push({ kind: 'disc', discNo: track.discNo });
      lastDisc = track.discNo;
    }
    entries.push({ kind: 'track', track, index });
  });
  return entries;
}
