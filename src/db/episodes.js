/**
 * Next-episode lookup, aligned with the series-detail page order (P2). See
 * `docs/specs/spec-video-streaming.md` Decision log ("Next episode") for the
 * exact rule this implements; P4's next-up feature reuses the same function
 * (H6) — there is no second ordering rule anywhere in the app.
 */

/** @typedef {import('./library-repo.js').LibraryItemRow} LibraryItemRow */

const NEXT_EPISODE_SQL = `
  SELECT * FROM library_items
  WHERE series_id = ?
    AND season IS NOT NULL
    AND episode IS NOT NULL
    AND (CASE WHEN ? = 1 THEN season = 0 ELSE season >= 1 END)
    AND (season, episode, COALESCE(episode_end, -1), sort_title, id) > (?, ?, ?, ?, ?)
  ORDER BY season, episode, COALESCE(episode_end, -1), sort_title, id
  LIMIT 1
`;

/**
 * Finds the row that follows `row` in its series, using the same candidate
 * order as the series-detail page (P2): `(season, episode,
 * coalesce(episode_end, -1), sort_title, id)`. Candidates are restricted to
 * numbered episodes (`season` and `episode` both non-`NULL`) of the same
 * `series_id`, split into two independent chains — regular seasons
 * (`season >= 1`) and specials (`season = 0`) — matching `row`'s own group;
 * the last regular episode never chains into Specials and vice versa. The
 * result is the first candidate whose order tuple is strictly greater than
 * `row`'s. Returns `null` when `row` has no `series_id`, `season` or
 * `episode` (movies, other categories, or unnumbered "Weitere Folgen" rows),
 * or when no candidate follows. Non-playable successors are returned, not
 * skipped.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {LibraryItemRow} row
 * @returns {LibraryItemRow | null}
 */
export function getNextEpisode(db, row) {
  if (row.series_id == null || row.season == null || row.episode == null) {
    return null;
  }
  const isSpecial = row.season === 0 ? 1 : 0;
  const next = /** @type {LibraryItemRow | undefined} */ (
    /** @type {unknown} */ (
      db
        .prepare(NEXT_EPISODE_SQL)
        .get(
          row.series_id,
          isSpecial,
          row.season,
          row.episode,
          row.episode_end ?? -1,
          row.sort_title,
          row.id
        )
    )
  );
  return next ?? null;
}
