/**
 * The audio views' shared request-error state: "Die Bibliothek konnte nicht
 * geladen werden." + "Erneut versuchen". See spec-music-audiobooks.md
 * "States and copy".
 */
import { el, createEmptyState } from '../../lib/dom.js';

/**
 * @param {() => Promise<void>} onRetry
 * @returns {HTMLElement}
 */
export function buildLoadErrorState(onRetry) {
  const state = createEmptyState({ title: 'Die Bibliothek konnte nicht geladen werden.', text: '' });
  state.append(el('button', { type: 'button', class: 'btn btn-secondary', onClick: onRetry }, 'Erneut versuchen'));
  return state;
}
