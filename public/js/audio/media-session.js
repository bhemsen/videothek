/**
 * Web Media Session binding: lock-screen / hardware-key control for the
 * persistent player. No-op without `navigator.mediaSession`. See
 * spec-music-audiobooks.md "Media Session".
 */

/** @typedef {ReturnType<typeof import('./player.js').createAudioPlayer>} AudioPlayer */
/** @typedef {NonNullable<ReturnType<AudioPlayer['state']>>} PlayerState */

/**
 * @param {AudioPlayer} player
 * @param {HTMLAudioElement} audio
 * @returns {void}
 */
export function bindMediaSession(player, audio) {
  if (!('mediaSession' in navigator)) return;
  attachHandlers(player, audio);
  let lastItemId = /** @type {number | null} */ (null);
  player.onChange(() => {
    const state = player.state();
    if (state !== null && state.item.id !== lastItemId) {
      lastItemId = state.item.id;
      updateMetadata(state);
    }
  });
  const updatePosition = () => setPositionState(audio);
  audio.addEventListener('durationchange', updatePosition);
  audio.addEventListener('seeked', updatePosition);
  audio.addEventListener('play', updatePosition);
  audio.addEventListener('pause', updatePosition);
  const initialState = player.state();
  if (initialState !== null) {
    lastItemId = initialState.item.id;
    updateMetadata(initialState);
  }
  updatePosition();
}

/**
 * @param {AudioPlayer} player
 * @param {HTMLAudioElement} audio
 * @returns {void}
 */
function attachHandlers(player, audio) {
  setHandler('play', () => { if (audio.paused) player.toggle(); });
  setHandler('pause', () => { if (!audio.paused) player.toggle(); });
  setHandler('previoustrack', () => player.previous());
  setHandler('nexttrack', () => player.next());
  setHandler('seekbackward', () => player.seekBy(-15));
  setHandler('seekforward', () => player.seekBy(30));
  setHandler('seekto', (details) => {
    if (details.seekTime != null) player.seekTo(details.seekTime);
  });
}

/**
 * Registers one action handler; a browser that does not support `action`
 * throws a `TypeError`, which is swallowed so one unsupported action never
 * takes the rest of the Media Session binding (or the audio section) down.
 * @param {MediaSessionAction} action
 * @param {MediaSessionActionHandler} handler
 * @returns {void}
 */
function setHandler(action, handler) {
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {
    // Unsupported action in this browser: leave it unbound.
  }
}

/**
 * Sets metadata from `state`'s current item. Called only when the item
 * changes (see `bindMediaSession`), not on every play/pause/error toggle, so
 * the OS lock-screen artwork does not re-fetch or flicker on those.
 * @param {PlayerState} state
 * @returns {void}
 */
function updateMetadata(state) {
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
