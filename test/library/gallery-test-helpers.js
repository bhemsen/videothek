/**
 * Shared fixtures for the `gallery.js` test suite (split across
 * `gallery.test.js` and `gallery-thumb.test.js`).
 */

/**
 * @param {Partial<import('../../src/library/gallery.js').ItemRow>} overrides
 * @returns {import('../../src/library/gallery.js').ItemRow}
 */
export function makeItem(overrides = {}) {
  return {
    id: 1,
    relPath: 'Bilder/foo.jpg',
    kind: 'image',
    playable: true,
    size: 1000,
    mtimeMs: 1700000000000,
    takenAt: null,
    orientation: null,
    thumbOffset: null,
    thumbLength: null,
    sourceSize: null,
    sourceMtimeMs: null,
    ...overrides,
  };
}

/**
 * `ItemRow` fields for a thumbnail recorded against the row's current
 * `size`/`mtimeMs` (i.e. not stale) — the fixture most thumb-marker tests
 * build on and then deviate from.
 *
 * @returns {Pick<import('../../src/library/gallery.js').ItemRow, 'thumbOffset' | 'thumbLength' | 'sourceSize' | 'sourceMtimeMs'>}
 */
export function freshThumbFields() {
  return {
    thumbOffset: 20,
    thumbLength: 30,
    sourceSize: 1000,
    sourceMtimeMs: 1700000000000,
  };
}
