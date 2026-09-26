/**
 * Read-only joins from Phase 4's `progress` table
 * (`src/db/migrations/003-progress.sql`) onto `library_items`/`audio_meta`
 * for the music and audiobooks APIs (`src/api/music.js`,
 * `src/api/audiobooks.js`). This module never writes to `progress` — writes
 * stay in `src/db/progress.js` — and never hard-codes the "started" position
 * threshold: every caller supplies it as a bound parameter (Phase 4's
 * `src/api/progress-rules.js` `START_THRESHOLD_S`).
 * @typedef {{ itemId: number, position: number, duration: number | null, finished: 0 | 1, updatedAt: number }} AudioProgressRow
 * @typedef {{ itemId: number, groupKey: string, position: number, duration: number | null, updatedAt: number } | null} MusicResumeRow
 */

/**
 * The user's progress rows for present items of one category (`music` or
 * `audiobooks`), joined on `progress.rel_path = library_items.rel_path`. No
 * `finished`/threshold/playable filter — callers (e.g. the audiobook resume
 * derivation) need every counted and uncounted row to decide state
 * themselves. `updatedAt` is Phase 4's epoch-ms value, passed through as-is.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} userId
 * @param {'music' | 'audiobooks'} category
 * @returns {AudioProgressRow[]}
 */
export function listAudioProgress(db, userId, category) {
  const rows = db
    .prepare(
      `SELECT li.id AS itemId,
              p.position_seconds AS position,
              p.duration_seconds AS duration,
              p.finished AS finished,
              p.updated_at AS updatedAt
       FROM progress p
       JOIN library_items li ON li.rel_path = p.rel_path
       WHERE p.user_id = ? AND li.category = ?
       ORDER BY li.id`
    )
    .all(userId, category);
  // `node:sqlite` returns null-prototype row objects; spread into plain
  // objects so callers (and `assert.deepEqual`) see ordinary objects.
  return rows.map((row) => /** @type {AudioProgressRow} */ ({ ...row }));
}

/**
 * The user's most recently updated in-progress, playable music track — the
 * Musik "Weiterhören" card's source row. Only items with an `audio_meta` row
 * are eligible (an item the metadata pass has not reached yet stays
 * invisible, same rule as `audio-meta-repo.js`'s joined reads). Ties on
 * `updated_at` break on the higher `library_items.id`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ userId: number, startThreshold: number }} params
 * @returns {MusicResumeRow}
 */
export function getLatestMusicResume(db, { userId, startThreshold }) {
  const row = db
    .prepare(
      `SELECT li.id AS itemId,
              am.group_key AS groupKey,
              p.position_seconds AS position,
              p.duration_seconds AS duration,
              p.updated_at AS updatedAt
       FROM progress p
       JOIN library_items li ON li.rel_path = p.rel_path
       JOIN audio_meta am ON am.item_id = li.id
       WHERE p.user_id = ?
         AND li.category = 'music'
         AND li.playable = 1
         AND p.finished = 0
         AND p.position_seconds >= ?
       ORDER BY p.updated_at DESC, li.id DESC
       LIMIT 1`
    )
    .get(userId, startThreshold);
  // See `listAudioProgress`: spread out of the driver's null-prototype row.
  return row ? /** @type {MusicResumeRow} */ ({ ...row }) : null;
}
