// @ts-check

/**
 * @typedef {'movies' | 'series' | 'music' | 'audiobooks' | 'images'} Category
 * @typedef {'video' | 'audio' | 'image'} Kind
 */

/** Category ids in nav order. Used verbatim in API paths and params. */
export const CATEGORIES = Object.freeze(
  /** @type {Category[]} */ (['movies', 'series', 'music', 'audiobooks', 'images'])
);

/** Admitted kinds per category (P6 widens `images` to `['image', 'video']`). */
const KINDS = Object.freeze({
  movies: Object.freeze(/** @type {Kind[]} */ (['video'])),
  series: Object.freeze(/** @type {Kind[]} */ (['video'])),
  music: Object.freeze(/** @type {Kind[]} */ (['audio'])),
  audiobooks: Object.freeze(/** @type {Kind[]} */ (['audio'])),
  images: Object.freeze(/** @type {Kind[]} */ (['image', 'video']))
});

/** Top-level folder name (NFC-normalised, lower-cased) -> category id. */
const FOLDER_ALIASES = new Map([
  ['filme', 'movies'],
  ['movies', 'movies'],
  ['serien', 'series'],
  ['series', 'series'],
  ['tv', 'series'],
  ['musik', 'music'],
  ['music', 'music'],
  ['hörbücher', 'audiobooks'],
  ['hoerbuecher', 'audiobooks'],
  ['audiobooks', 'audiobooks'],
  ['bilder', 'images'],
  ['pictures', 'images'],
  ['photos', 'images']
]);

/**
 * Maps a top-level folder name under `MEDIA_ROOT` to its category id.
 * Comparison is NFC-normalised and case-insensitive.
 * @param {string} name folder name as read from disk
 * @returns {Category | null} the category id, or `null` when the folder is not a category root
 */
export function categoryForFolder(name) {
  const key = name.normalize('NFC').toLowerCase();
  const category = FOLDER_ALIASES.get(key);
  return category ? /** @type {Category} */ (category) : null;
}

/**
 * Returns the kinds admitted for a category.
 * @param {Category} category a value from `CATEGORIES`
 * @returns {readonly Kind[]} frozen array of admitted kinds
 */
export function kindsFor(category) {
  return KINDS[category];
}
