/**
 * Web Media Session binding: lock-screen / hardware-key control for the
 * persistent player. No-op without `navigator.mediaSession`. See
 * spec-music-audiobooks.md "Media Session".
 */

/** @typedef {ReturnType<typeof import('./player.js').createAudioPlayer>} AudioPlayer */

/**
 * @param {AudioPlayer} player
 * @param {HTMLAudioElement} audio
 * @returns {void}
 */
export function bindMediaSession(player, audio) {
  if (!('mediaSession' in navigator)) return;
  attachHandlers(player, audio);
  player.onChange(() => updateMetadata(player));
  const updatePosition = () => setPositionState(audio);
  audio.addEventListener('durationchange', updatePosition);
  audio.addEventListener('seeked', updatePosition);
  audio.addEventListener('play', updatePosition);
  audio.addEventListener('pause', updatePosition);
  updateMetadata(player);
  updatePosition();
}

/**
 * @param {AudioPlayer} player
 * @param {HTMLAudioElement} audio
 * @returns {void}
 */
function attachHandlers(player, audio) {
  const session = navigator.mediaSession;
  session.setActionHandler('play', () => { if (audio.paused) player.toggle(); });
  session.setActionHandler('pause', () => { if (!audio.paused) player.toggle(); });
  session.setActionHandler('previoustrack', () => player.previous());
  session.setActionHandler('nexttrack', () => player.next());
  session.setActionHandler('seekbackward', () => player.seekBy(-15));
  session.setActionHandler('seekforward', () => player.seekBy(30));
  session.setActionHandler('seekto', (details) => {
    if (details.seekTime != null) player.seekTo(details.seekTime);
  });
}

/**
 * Sets metadata from the current item; a no-op while nothing is queued yet.
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

/**
 * Reports current position/duration to the OS media UI so its scrubber (and
 * the `seekto` handler above) has something to drive; skipped while the
 * duration is not yet known (`NaN` before the first `durationchange`).
 * @param {HTMLAudioElement} audio
 * @returns {void}
 */
function setPositionState(audio) {
  if (!Number.isFinite(audio.duration)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: audio.currentTime,
    });
  } catch {
    // Some browsers throw when position momentarily exceeds duration; ignore.
  }
}
