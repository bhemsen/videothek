/**
 * History binding for the image lightbox: an open lightbox pushes/replaces
 * `#bild-<id>` on top of the folder's own history entry, so a single browser
 * or Android back step closes the lightbox and leaves the folder view in
 * place instead of navigating away from it. See
 * docs/specs/spec-image-gallery.md "Lightbox history".
 */

/**
 * Pushes `#bild-<id>` above the folder entry. When history already sits on a
 * stale lightbox entry (browser Forward after a close, or a reloaded
 * `#bild-<id>` that `images.js` reopens) that entry is reused via
 * `replaceState`, so the next close's single `history.back()` still returns
 * to the folder entry.
 * @param {number} id
 * @returns {void}
 */
function pushEntry(id) {
  if (history.state?.lightbox != null) history.replaceState({ lightbox: id }, '', `#bild-${id}`);
  else history.pushState({ lightbox: id }, '', `#bild-${id}`);
}

/**
 * Methods: `push(id)` on open; `replace(id)` per slide (one lightbox entry,
 * not one per slide); `release()` from the dialog's `close` handler, which
 * steps back only while history still sits on the lightbox's own state (a
 * close reached via `popstate` has already moved past it); `dispose()`
 * removes the listener.
 *
 * `history.back()` is asynchronous: until its `popstate` lands, history
 * still sits on the old lightbox entry. A re-open in that window is queued
 * and applied once the back step completes, so that `popstate` neither
 * closes the new lightbox nor leaves it on a reused entry.
 * @param {{ onPop: () => void }} params - `onPop` runs when `popstate` fires
 *   and the new state carries no `lightbox` id (a real back navigation past
 *   the lightbox's own state, as opposed to the state the lightbox itself
 *   just pushed/replaced).
 * @returns {{ push: (id: number) => void, replace: (id: number) => void, release: () => void, dispose: () => void }}
 */
export function createLightboxHistory({ onPop }) {
  let backPending = false;
  /** @type {number | null} Lightbox id to push once the pending back lands. */
  let queuedId = null;

  /** @param {PopStateEvent} event @returns {void} */
  function onPopState(event) {
    if (backPending) {
      backPending = false;
      const id = queuedId;
      queuedId = null;
      if (id !== null) pushEntry(id);
      return;
    }
    if (event.state?.lightbox == null) onPop();
  }
  window.addEventListener('popstate', onPopState);

  return {
    push(id) {
      if (backPending) queuedId = id;
      else pushEntry(id);
    },
    replace(id) {
      if (!backPending) history.replaceState({ lightbox: id }, '', `#bild-${id}`);
      else if (queuedId !== null) queuedId = id;
    },
    release() {
      queuedId = null;
      if (backPending || history.state?.lightbox == null) return;
      backPending = true;
      history.back();
    },
    dispose() {
      window.removeEventListener('popstate', onPopState);
    },
  };
}
