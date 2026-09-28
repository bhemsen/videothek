// @ts-check

/**
 * Read-side queries for `/api/home/*` (`src/api/home-listening.js`,
 * `src/api/home-previews.js`): per-category counts, recently added items for
 * the category previews, and the started-audiobook group keys for the
 * "Weiterhören" derivation. Every statement is a fixed literal prepared
 * statement with bound `?` parameters — no string-concatenated SQL. Rows are
 * spread out of `node:sqlite`'s null-prototype objects before being returned.
 */

const STARTED_BOOK_GROUPS_SQL = `
  SELECT DISTINCT am.group_key AS groupKey
  FROM progress p
  JOIN library_items li ON li.rel_path = p.rel_path
  JOIN audio_meta am ON am.item_id = li.id
  WHERE p.user_id = ?
    AND li.category = 'audiobooks'
    AND (p.finished = 1 OR p.position_seconds >= ?)
  ORDER BY am.group_key
`;

/**
 * Distinct `audio_meta.group_key` values of audiobooks with at least one
 * counted progress row (`finished = 1`, or started at/above `startThreshold`)
 * for the given user — the "Weiterhören" derivation's candidate set (a book
 * with no counted row can only be `new`, so it is never assembled).
 * `startThreshold` is always a bound parameter, never a literal.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ userId: number, startThreshold: number }} params
 * @returns {string[]} group keys, in no particular order
 */
export function listStartedBookGroupKeys(db, { userId, startThreshold }) {
  const rows = /** @type {{ groupKey: string }[]} */ (
    /** @type {unknown} */ (db.prepare(STARTED_BOOK_GROUPS_SQL).all(userId, startThreshold))
  );
  return rows.map((row) => row.groupKey);
}
