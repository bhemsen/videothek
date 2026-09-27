// @ts-check

import { deriveProgressState } from './progress-rules.js';

/**
 * @typedef {{
 *   id: number,
 *   series_id?: number | null,
 *   position_seconds: number,
 *   finished: 0 | 1,
 *   updated_at: number,
 * }} SeriesProgressRow - the columns `computeNextUp` reads from a row of
 *   `rows` (`src/db/progress.js`'s `listSeriesProgressRows(db, userId)`); the
 *   real row also carries the full joined `library_items` columns
 *   (`season`, `episode`, `episode_end`, `sort_title`, `rel_path`, …) that
 *   `getNext` needs, passed through untouched. `series_id` is optional
 *   because the real row's (`ProgressItemRow`, via `LibraryItemRow`) is
 *   optional too — a plain `number | null` here would make the real caller
 *   (`computeNextUp(listSeriesProgressRows(db, userId), { getNext: (row) =>
 *   getNextEpisode(db, row), ... })`) fail `tsc --strict` with TS2345.
 * @typedef {{ id: number, rel_path: string, playable: number | boolean }} NextEpisodeRow
 *   - the shape `getNext` resolves to: P3's `getNextEpisode(db, row)` result.
 */

/**
 * Finds *L* per the spec: the highest-`updated_at` row (ties: higher `id`)
 * among `seriesRows` whose derived state is not `none`, plus that state.
 * `null` when every row in the series is `none`.
 * @template {SeriesProgressRow} T
 * @param {T[]} seriesRows one series' progress rows
 * @returns {{ row: T, state: 'in_progress' | 'finished' } | null}
 */
function findLatest(seriesRows) {
  /** @type {{ row: T, state: 'in_progress' | 'finished' } | null} */
  let best = null;
  for (const row of seriesRows) {
    const state = deriveProgressState({ finished: row.finished === 1, position: row.position_seconds });
    if (state === 'none') {
      continue;
    }
    if (
      best === null ||
      row.updated_at > best.row.updated_at ||
      (row.updated_at === best.row.updated_at && row.id > best.row.id)
    ) {
      best = { row, state };
    }
  }
  return best;
}

/**
 * Groups `rows` by `series_id`, preserving each group's first-seen order.
 * Rows with a nullish `series_id` (`null` or `undefined`) all land in one
 * bucket; harmless in practice because `getNext` returns `null` for them
 * (no `series_id` to look up a successor by), same as any other row with no
 * next episode.
 * @template {SeriesProgressRow} T
 * @param {T[]} rows
 * @returns {Map<number | null | undefined, T[]>}
 */
function groupBySeries(rows) {
  /** @type {Map<number | null | undefined, T[]>} */
  const bySeries = new Map();
  for (const row of rows) {
    const list = bySeries.get(row.series_id);
    if (list) {
      list.push(row);
    } else {
      bySeries.set(row.series_id, [row]);
    }
  }
  return bySeries;
}

/**
 * Computes "Nächste Folge" (`next_up`) entries per series from the user's
 * series progress rows, with the neighbouring-phase lookups injected so this
 * module stays pure and imports nothing from P2/P3. Per series: *L* = the
 * latest non-`none` row (`findLatest`); `in_progress` -> nothing (already
 * listed via *L* itself); `finished` -> *N* = `getNext(L)`, emitted only if it
 * exists, is `playable` and its own state (`getState(N.rel_path)`) is `none`.
 * @template {SeriesProgressRow} L
 * @template {NextEpisodeRow} N
 * @param {L[]} rows the user's progress rows joined to present `category =
 *   'series'` library items (`listSeriesProgressRows`), every state included
 * @param {{
 *   getNext: (row: L) => N | null,
 *   getState: (relPath: string) => 'none' | 'in_progress' | 'finished',
 * }} deps injected lookups (P3's `getNextEpisode(db, row)` and a
 *   `progress`-table state lookup by `rel_path`)
 * @returns {{ row: N, updatedAt: number }[]} one entry per series that has a
 *   next episode to surface; `updatedAt` is *L*'s `updated_at` (epoch ms)
 */
export function computeNextUp(rows, { getNext, getState }) {
  /** @type {{ row: N, updatedAt: number }[]} */
  const results = [];
  for (const seriesRows of groupBySeries(rows).values()) {
    const latest = findLatest(seriesRows);
    if (latest === null || latest.state !== 'finished') {
      continue;
    }
    const next = getNext(latest.row);
    if (next !== null && Boolean(next.playable) && getState(next.rel_path) === 'none') {
      results.push({ row: next, updatedAt: latest.row.updated_at });
    }
  }
  return results;
}
