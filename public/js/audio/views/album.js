/**
 * Album detail — stub. Replaced by its own issue with the track list and
 * "Alle abspielen"; ships only a heading so the shell's routing and
 * persistent bar can be exercised end-to-end. See
 * spec-music-audiobooks.md "View contract".
 */
import { el } from '../../lib/dom.js';

/** @typedef {import('../app.js').ViewParams} ViewParams */

const TITLE = 'Album';

/**
 * @param {ViewParams} params
 * @returns {Promise<{ title: string }>}
 */
export async function render({ container }) {
  container.append(el('h1', {}, TITLE));
  return { title: TITLE };
}
