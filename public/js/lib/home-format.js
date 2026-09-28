/**
 * Pure, DOM-free formatting helpers for the start page's "Weiterhören" row.
 * The category-preview helpers join this module in a later commit — see the
 * home overview contract §6.2. No DOM access; unit-tested from
 * test/public/home-format.test.js.
 */
import { formatRemaining } from './progress.js';
import { UNKNOWN_ARTIST } from '../audio/music-queue.js';

/** @typedef {import('./home-api.js').ListeningItem} ListeningItem */
/** @typedef {import('./home-api.js').MusicListeningItem} MusicListeningItem */
/** @typedef {import('./home-api.js').AudiobookListeningItem} AudiobookListeningItem */

const MIDDLE_DOT = '·';

/**
 * The link target for a "Weiterhören" card.
 * @param {ListeningItem} item
 * @returns {string} `/music` for a music item, `/audiobooks?book=<id>` for an audiobook.
 */
export function listenHref(item) {
  return item.kind === 'music' ? '/music' : `/audiobooks?book=${item.id}`;
}

/**
 * The fraction of a "Weiterhören" item already listened to, clamped to 0..1.
 * @param {ListeningItem} item
 * @returns {number}
 */
export function listenFraction(item) {
  const raw = item.kind === 'music' ? (item.duration ? item.position / item.duration : 0) : (item.fraction ?? 0);
  return Math.min(1, Math.max(0, raw));
}

/**
 * The hidden progress-percentage text for a "Weiterhören" card.
 * @param {ListeningItem} item
 * @returns {string} `Zu {n} % gehört`
 */
export function listenProgressText(item) {
  return `Zu ${Math.round(listenFraction(item) * 100)} % gehört`;
}

/**
 * The visible meta line for a "Weiterhören" card: artist/next-file title
 * plus the remaining time, joined by a middle dot; either part is omitted
 * when unknown (an empty file title contributes nothing).
 * @param {ListeningItem} item
 * @returns {string}
 */
export function listenMeta(item) {
  const parts = item.kind === 'music' ? musicMetaParts(item) : audiobookMetaParts(item);
  return parts.join(` ${MIDDLE_DOT} `);
}

/**
 * @param {MusicListeningItem} item
 * @returns {string[]}
 */
function musicMetaParts(item) {
  const parts = [item.artist ?? UNKNOWN_ARTIST];
  if (item.duration !== null) parts.push(formatRemaining(Math.max(0, item.duration - item.position)));
  return parts;
}

/**
 * @param {AudiobookListeningItem} item
 * @returns {string[]}
 */
function audiobookMetaParts(item) {
  const parts = [];
  if (item.resume.fileTitle !== '') parts.push(item.resume.fileTitle);
  if (item.remaining !== null) parts.push(formatRemaining(item.remaining));
  return parts;
}
