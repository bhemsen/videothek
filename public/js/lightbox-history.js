/**
 * History binding for the image lightbox: an open lightbox pushes/replaces
 * `#bild-<id>` on top of the folder's own history entry, so a single browser
 * or Android back step closes the lightbox and leaves the folder view in
 * place instead of navigating away from it. See
 * docs/specs/spec-image-gallery.md "Lightbox history".
 */

/**
 * @param {{ onPop: () => void }} params - `onPop` runs when `popstate` fires
 *   and the new state carries no `lightbox` id (a real back navigation past
 *   the lightbox's own state, as opposed to the state the lightbox itself
 *   just pushed/replaced).
 * @returns {{ push: (id: number) => void, replace: (id: number) => void, release: () => void, dispose: () => void }}
 */
export function createLightboxHistory({ onPop }) {
  /**
   * @param {PopStateEvent} event
   * @returns {void}
   */
  function onPopState(event) {
    if (event.state?.lightbox == null) onPop();
  }
  window.addEventListener('popstate', onPopState);

  return {
    /**
     * Called when the lightbox opens: pushes a new history entry above the
     * folder's own. When history already sits on a stale lightbox entry
     * (browser Forward after a close lands back on it with no dialog open)
     * that entry is reused via `replaceState` instead, so the next close's
     * single `history.back()` still returns to the folder entry.
     * @param {number} id
     * @returns {void}
     */
    push(id) {
      if (history.state?.lightbox != null) history.replaceState({ lightbox: id }, '', `#bild-${id}`);
      else history.pushState({ lightbox: id }, '', `#bild-${id}`);
    },
    /**
     * Called while navigating between slides: keeps one lightbox entry
     * instead of growing the history stack per slide.
     * @param {number} id
     * @returns {void}
     */
    replace(id) {
      history.replaceState({ lightbox: id }, '', `#bild-${id}`);
    },
    /**
     * Called from the dialog's `close` handler. Only steps history back when
     * it is still sitting on this lightbox's own pushed/replaced state — a
     * `close` reached via `popstate` (browser back, or the Android back
     * gesture's close-watcher after a real navigation) has already moved
     * past it, and stepping back again would leave the folder too.
     * @returns {void}
     */
    release() {
      if (history.state?.lightbox != null) history.back();
    },
    /**
     * Removes the `popstate` listener.
     * @returns {void}
     */
    dispose() {
      window.removeEventListener('popstate', onPopState);
    },
  };
}
