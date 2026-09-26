/**
 * @typedef {object} StageHost
 * @property {(node: unknown) => void} append - appends a node to the stage container
 */

/**
 * @typedef {object} StageVideo
 * @property {() => void} remove - removes the element from its parent
 * @property {() => void} load - re-runs the media element's load algorithm
 * @property {() => (Promise<void> | undefined)} play - starts playback
 * @property {(type: string, listener: () => void, options?: { once?: boolean }) => void} addEventListener
 * @property {number} currentTime - playback position in seconds
 */

/**
 * Creates a stage around one persistent `<video>` element so a playback
 * error can detach it and a retry can re-attach the exact same element
 * without ever recreating it or reassigning its `src`. Duck-typed against
 * `host`/`video`: only `host.append` and `video.remove`/`load`/`play`/
 * `addEventListener`/`currentTime` are used, so tests can pass in fakes.
 * @param {StageHost} host - container the video element is appended to
 * @param {StageVideo} video - the single video element for the page's lifetime
 * @returns {{ detach: () => void, retry: (position: number) => void }}
 */
export function createStage(host, video) {
  /**
   * Removes the video element from the stage.
   * @returns {void}
   */
  function detach() {
    video.remove();
  }

  /**
   * Re-attaches the same video element and reloads it. Once the reload
   * reaches `loadedmetadata` (only the first time), seeks to `position`
   * when it is greater than 0, then starts playback, swallowing a
   * rejected play promise (e.g. `AbortError` from a fast subsequent
   * pause).
   * @param {number} position - seconds to seek to after reload (0 = no seek)
   * @returns {void}
   */
  function retry(position) {
    host.append(video);
    video.addEventListener(
      'loadedmetadata',
      () => {
        if (position > 0) {
          video.currentTime = position;
        }
        Promise.resolve(video.play()).catch(() => {});
      },
      { once: true }
    );
    video.load();
  }

  return { detach, retry };
}
