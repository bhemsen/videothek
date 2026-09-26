/**
 * Web Media Session binding: lock-screen / hardware-key control for the
 * persistent player. No-op without `navigator.mediaSession`. See
 * spec-music-audiobooks.md "Media Session".
 */

/** @typedef {ReturnType<typeof import('./player.js').createAudioPlayer>} AudioPlayer */

/**
 * @param {AudioPlayer} player
 * @returns {void}
 */
export function bindMediaSession(player) {
  if (!('mediaSession' in navigator)) return;
  attachHandlers(player);
  player.onChange(() => updateMetadata(player));
  updateMetadata(player);
}

/**
 * @param {AudioPlayer} player
 * @returns {void}
 */
function attachHandlers(player) {
  const session = navigator.mediaSession;
  session.setActionHandler('play', () => player.toggle());
  session.setActionHandler('pause', () => player.toggle());
  session.setActionHandler('previoustrack', () => player.previous());
  session.setActionHandler('nexttrack', () => player.next());
  session.setActionHandler('seekbackward', () => player.seekBy(-15));
  session.setActionHandler('seekforward', () => player.seekBy(30));
  session.setActionHandler('seekto', (details) => {
    if (details.seekTime != null) player.seekTo(details.seekTime);
  });
}

/**
 * Sets metadata and `setPositionState` from the current item; a no-op while
 * nothing is queued yet.
 * @param {AudioPlayer} player
 * @returns {void}
 */
function updateMetadata(player) {
  const state = player.state();
  if (state === null) return;
  const { item, mode } = state;
  const artist = mode === 'music' ? item.subtitle : (item.subtitle ?? item.groupTitle);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: item.title,
    artist: artist ?? '',
    album: item.groupTitle ?? '',
    artwork: item.coverId === null ? [] : [{ src: `/media/${item.coverId}/cover` }],
  });
}
