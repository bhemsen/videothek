/**
 * Pure, URL-free shaping of an image-gallery folder view: sort, breadcrumb,
 * child-folder aggregation, `takenAt` fallback, thumbnail marker and
 * orientation. No HTTP, no DB, no I/O, and no URL strings — `src/api/gallery.js`
 * maps the neutral `thumb` marker this module returns to actual media URLs.
 */

/**
 * @typedef {Object} ItemRow
 * @property {number} id
 * @property {string} relPath
 * @property {'image' | 'video'} kind
 * @property {boolean} playable
 * @property {number} size
 * @property {number} mtimeMs
 * @property {string | null} takenAt
 * @property {number | null} orientation
 * @property {number | null} thumbOffset
 * @property {number | null} thumbLength
 * @property {number | null} sourceSize
 * @property {number | null} sourceMtimeMs
 */

/**
 * @typedef {Object} ChildFolder
 * @property {string} key
 * @property {string} name
 * @property {number} count
 */

/**
 * @typedef {Object} FolderInput
 * @property {string} key
 * @property {string} name
 * @property {number} count
 * @property {ItemRow | null} coverRow
 */

/**
 * @typedef {Object} GalleryItemView
 * @property {number} id
 * @property {string} name
 * @property {'image' | 'video'} kind
 * @property {boolean} playable
 * @property {string} takenAt
 * @property {'embedded' | 'original' | null} thumb
 * @property {number} thumbOrientation
 * @property {number} version
 */

/**
 * @typedef {Object} GalleryCoverView
 * @property {number} id
 * @property {'embedded' | 'original' | null} thumb
 * @property {number} thumbOrientation
 * @property {number} version
 */

/**
 * @typedef {Object} GalleryFolderView
 * @property {string} key
 * @property {string} name
 * @property {number} count
 * @property {GalleryCoverView | null} cover
 */

/**
 * @typedef {Object} GalleryView
 * @property {string} key
 * @property {string} name
 * @property {{key: string, name: string}[]} breadcrumb
 * @property {GalleryFolderView[]} folders
 * @property {GalleryItemView[]} items
 */

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/**
 * Formats a millisecond timestamp as `YYYY-MM-DDTHH:MM:SS` in the server's
 * local time zone (used as the `takenAt` fallback for items without EXIF).
 *
 * @param {number} ms - a `Date.now()`-style millisecond timestamp.
 * @returns {string} the formatted local date-time.
 */
function formatLocalDateTime(ms) {
  const date = new Date(ms);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Decides the neutral thumbnail marker for an item or a folder cover.
 *
 * @param {ItemRow} row
 * @returns {'embedded' | 'original' | null}
 */
function thumbMarkerFor(row) {
  if (row.kind !== 'image' || !row.playable) return null;
  const hasThumb = row.thumbOffset != null && row.thumbLength != null;
  const isFresh = row.sourceSize === row.size && row.sourceMtimeMs === row.mtimeMs;
  return hasThumb && isFresh ? 'embedded' : 'original';
}

/**
 * @param {ItemRow} row
 * @param {'embedded' | 'original' | null} thumb
 * @returns {number}
 */
function thumbOrientationFor(row, thumb) {
  if (thumb !== 'embedded') return 1;
  const orientation = row.orientation;
  return orientation != null && orientation >= 1 && orientation <= 8 ? orientation : 1;
}

/**
 * @param {string} relPath
 * @returns {string}
 */
function lastSegment(relPath) {
  const segments = relPath.split('/');
  return segments[segments.length - 1] ?? relPath;
}

/**
 * @param {ItemRow} row
 * @returns {GalleryItemView}
 */
function toItemView(row) {
  const thumb = thumbMarkerFor(row);
  return {
    id: row.id,
    name: lastSegment(row.relPath),
    kind: row.kind,
    playable: row.playable,
    takenAt: row.takenAt ?? formatLocalDateTime(row.mtimeMs),
    thumb,
    thumbOrientation: thumbOrientationFor(row, thumb),
    version: row.mtimeMs,
  };
}

/**
 * @param {ItemRow | null} row
 * @returns {GalleryCoverView | null}
 */
function toCoverView(row) {
  if (!row) return null;
  const thumb = thumbMarkerFor(row);
  return {
    id: row.id,
    thumb,
    thumbOrientation: thumbOrientationFor(row, thumb),
    version: row.mtimeMs,
  };
}

/**
 * @param {GalleryItemView} a
 * @param {GalleryItemView} b
 * @returns {number}
 */
function compareItems(a, b) {
  if (a.takenAt !== b.takenAt) return a.takenAt < b.takenAt ? -1 : 1;
  const nameCmp = collator.compare(a.name, b.name);
  if (nameCmp !== 0) return nameCmp;
  return a.id - b.id;
}

/**
 * @param {{ key: string, name: string }} a
 * @param {{ key: string, name: string }} b
 * @returns {number}
 */
function compareFolders(a, b) {
  const nameCmp = collator.compare(a.name, b.name);
  if (nameCmp !== 0) return nameCmp;
  if (a.key === b.key) return 0;
  // JS `<` compares UTF-16 code units, not UTF-8 bytes; intentional — the two
  // orders only differ for astral-plane vs. U+E000-U+FFFF characters.
  return a.key < b.key ? -1 : 1;
}

/**
 * Builds the ancestors of `key` below the root, root and current excluded.
 *
 * @param {string} key
 * @returns {{ key: string, name: string }[]}
 */
function buildBreadcrumb(key) {
  if (!key) return [];
  const segments = key.split('/');
  segments.pop();
  /** @type {{ key: string, name: string }[]} */
  const breadcrumb = [];
  let acc = '';
  for (const segment of segments) {
    acc = acc ? `${acc}/${segment}` : segment;
    breadcrumb.push({ key: acc, name: segment });
  }
  return breadcrumb;
}

/**
 * Aggregates every folder in `key`'s subtree (as returned by
 * `listSubtreeFolderCounts`) into `key`'s direct child folders, each carrying
 * the summed item count of its whole subtree.
 *
 * @param {string} key - the current folder key (`''` = root).
 * @param {{ folder: string, count: number }[]} folderCounts - every folder
 *   strictly below `key`, each with its own direct item count.
 * @returns {ChildFolder[]} unsorted direct child folders.
 */
export function childFolders(key, folderCounts) {
  const prefix = key ? `${key}/` : '';
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const { folder, count } of folderCounts) {
    if (folder.length <= prefix.length || !folder.startsWith(prefix)) continue;
    const rest = folder.slice(prefix.length);
    const firstSegment = rest.split('/', 1)[0];
    const childKey = prefix + firstSegment;
    counts.set(childKey, (counts.get(childKey) ?? 0) + count);
  }
  return [...counts.entries()].map(([childKey, count]) => ({
    key: childKey,
    name: childKey.slice(prefix.length),
    count,
  }));
}

/**
 * Shapes one folder's gallery view: sorted items and folders, breadcrumb,
 * `takenAt` fallback and thumbnail markers. Pure — no URLs, no DB, no I/O.
 *
 * @param {{ key: string, items: ItemRow[], folders: FolderInput[] }} input
 * @returns {GalleryView}
 */
export function buildGalleryView({ key, items, folders }) {
  return {
    key,
    name: key ? lastSegment(key) : '',
    breadcrumb: buildBreadcrumb(key),
    folders: folders
      .map((folder) => ({
        key: folder.key,
        name: folder.name,
        count: folder.count,
        cover: toCoverView(folder.coverRow),
      }))
      .sort(compareFolders),
    items: items.map(toItemView).sort(compareItems),
  };
}
