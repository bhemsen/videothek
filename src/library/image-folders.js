/**
 * Folder-key derivation and validation for the image gallery.
 *
 * A folder key addresses a virtual folder in the merged `images` tree: it is
 * an item's `dir` with the category root alias (`Bilder`, `Pictures`,
 * `Photos`, ...) stripped off, so every alias merges into one tree. Keys are
 * `/`-separated, case-sensitive, and compared only against the library index
 * — never turned into a filesystem path.
 */

/**
 * Derives the gallery folder key for a `library_items.dir` value.
 *
 * @param {string} dir - the item's directory, relative to `MEDIA_ROOT` and
 *   `/`-separated (e.g. `"Bilder/Urlaub 2024/Italien"`).
 * @returns {string} the folder key with the first path segment (the category
 *   root alias) removed; `''` for a file directly in the alias root.
 */
export function folderKeyForDir(dir) {
  if (!dir) return '';
  const segments = dir.split('/');
  return segments.slice(1).join('/');
}

/**
 * Validates and normalises a `?folder=` query value into a folder key.
 *
 * Rules: absent or empty means the root (`''`); otherwise the value must be
 * at most 4096 UTF-16 units, contain no NUL character, and every `/`-split
 * segment must be non-empty and neither `.` nor `..` (this also rejects a
 * leading/trailing `/` and a doubled `/`, both of which produce an empty
 * segment). `\` is an ordinary character and is always allowed — the key
 * never reaches the filesystem.
 *
 * @param {string | null} value - the raw `folder` query value.
 * @returns {string | null} the folder key, or `null` when `value` violates a
 *   folder-key rule.
 */
export function parseFolderKey(value) {
  if (value === null || value === '') return '';
  if (value.length > 4096) return null;
  if (value.includes('\u0000')) return null;
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
  }
  return value;
}
