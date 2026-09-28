/**
 * Pure, DOM-free formatting helpers for the start page's "Weiterhören" row
 * and its category previews: hrefs, progress fractions/text, meta lines, and
 * the previews' per-category section table. No DOM access; unit-tested from
 * test/public/home-format.test.js. See docs/architecture.md "Start page".
 */
import { formatRemaining } from './progress.js';
import { pluralize } from './library-format.js';
import { UNKNOWN_ARTIST, UNTITLED_ALBUM } from '../audio/music-queue.js';

/** @typedef {import('./home-api.js').ListeningItem} ListeningItem */
/** @typedef {import('./home-api.js').MusicListeningItem} MusicListeningItem */
/** @typedef {import('./home-api.js').AudiobookListeningItem} AudiobookListeningItem */
/** @typedef {import('./home-api.js').AlbumPreview} AlbumPreview */
/** @typedef {import('./home-api.js').BookPreview} BookPreview */

const UNKNOWN_AUTHOR = 'Unbekannter Autor';
const MIDDLE_DOT = '·';
const NO_BREAK_SPACE = ' ';

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
 * when unknown (an empty file title contributes nothing). The remaining time
 * never breaks internally, so a wrapping line breaks after the dot instead.
 * @param {ListeningItem} item
 * @returns {string}
 */
export function listenMeta(item) {
  const parts = item.kind === 'music' ? musicMetaParts(item) : audiobookMetaParts(item);
  return parts.join(` ${MIDDLE_DOT} `);
}

/**
 * `formatRemaining`'s text with no-break spaces, so "Noch 7 Min." stays on
 * one line inside the narrow card's wrapping meta line.
 * @param {number} seconds
 * @returns {string}
 */
function remainingPart(seconds) {
  return formatRemaining(seconds).replaceAll(' ', NO_BREAK_SPACE);
}

/**
 * @param {MusicListeningItem} item
 * @returns {string[]}
 */
function musicMetaParts(item) {
  const parts = [item.artist ?? UNKNOWN_ARTIST];
  if (item.duration !== null) parts.push(remainingPart(Math.max(0, item.duration - item.position)));
  return parts;
}

/**
 * @param {AudiobookListeningItem} item
 * @returns {string[]}
 */
function audiobookMetaParts(item) {
  const parts = [];
  if (item.resume.fileTitle !== '') parts.push(item.resume.fileTitle);
  if (item.remaining !== null) parts.push(remainingPart(item.remaining));
  return parts;
}

/** @typedef {'movies' | 'series' | 'music' | 'audiobooks' | 'images'} PreviewCategory */
/** @typedef {{ category: PreviewCategory, label: string, allHref: string, singular: string, plural: string }} PreviewSection */

/**
 * The five category-preview sections, in nav order. Labels are hardcoded
 * (not looked up via `NAV_ENTRIES.find`, which is `NavEntry | undefined`
 * under tsc strict) but equal `NAV_ENTRIES`' labels — checked by a test.
 * @type {readonly PreviewSection[]}
 */
export const PREVIEW_SECTIONS = Object.freeze([
  { category: 'movies', label: 'Filme', allHref: '/movies?sort=added', singular: 'Titel', plural: 'Titel' },
  { category: 'series', label: 'Serien', allHref: '/series?sort=added', singular: 'Serie', plural: 'Serien' },
  { category: 'music', label: 'Musik', allHref: '/music', singular: 'Album', plural: 'Alben' },
  { category: 'audiobooks', label: 'Hörbücher', allHref: '/audiobooks', singular: 'Hörbuch', plural: 'Hörbücher' },
  { category: 'images', label: 'Bilder', allHref: '/images', singular: 'Datei', plural: 'Dateien' },
]);

/**
 * Formats a category's item count with its German singular/plural word.
 * @param {PreviewCategory} category
 * @param {number} n
 * @returns {string}
 */
export function previewCountLabel(category, n) {
  const section = /** @type {PreviewSection} */ (PREVIEW_SECTIONS.find((s) => s.category === category));
  return pluralize(n, section.singular, section.plural);
}

/**
 * The link/title/meta shown on an album preview card.
 * @param {AlbumPreview} album
 * @returns {{ href: string, title: string, meta: string }}
 */
export function albumCardText(album) {
  return { href: `/music?album=${album.id}`, title: album.title ?? UNTITLED_ALBUM, meta: album.artist ?? UNKNOWN_ARTIST };
}

/**
 * The link/title/meta shown on a book preview card.
 * @param {BookPreview} book
 * @returns {{ href: string, title: string, meta: string }}
 */
export function bookCardText(book) {
  return { href: `/audiobooks?book=${book.id}`, title: book.title, meta: book.author ?? UNKNOWN_AUTHOR };
}
