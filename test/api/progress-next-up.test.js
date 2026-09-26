import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNextUp } from '../../src/api/progress-next-up.js';
import { getNextEpisode } from '../../src/db/episodes.js';

/**
 * Type-only check, never invoked at runtime: confirms the real caller from
 * the spec's decision log — `computeNextUp(listSeriesProgressRows(db,
 * userId), { getNext: (row) => getNextEpisode(db, row), getState })` — type-
 * checks under this project's strict `checkJs`. `ProgressItemRow`'s
 * `series_id` is optional (inherited from `LibraryItemRow`), so
 * `SeriesProgressRow`'s must be too, or this fails `tsc --strict` with
 * TS2345 ("undefined is not assignable to number | null").
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {import('../../src/db/progress.js').ProgressItemRow[]} rows
 * @returns {void}
 */
function assertRealProgressItemRowsAreAssignable(db, rows) {
  computeNextUp(rows, {
    getNext: (row) => getNextEpisode(db, row),
    getState: () => 'none',
  });
}

/**
 * @param {{ id: number, seriesId: number, position: number, finished: boolean, updatedAt: number }} input
 * @returns {{ id: number, series_id: number, position_seconds: number, finished: 0 | 1, updated_at: number }}
 */
function makeRow({ id, seriesId, position, finished, updatedAt }) {
  return { id, series_id: seriesId, position_seconds: position, finished: finished ? 1 : 0, updated_at: updatedAt };
}

/**
 * @param {{ id: number, relPath: string, playable?: boolean }} input
 */
function makeNext({ id, relPath, playable = true }) {
  return { id, rel_path: relPath, playable };
}

const throwIfCalled = () => {
  throw new Error('must not be called');
};

// -- happy path: a finished latest episode surfaces its next episode -------

test('finished S01E03 -> S01E04 via getNext, updatedAt is L\'s', () => {
  const l = makeRow({ id: 3, seriesId: 1, position: 1400, finished: true, updatedAt: 1000 });
  const n = makeNext({ id: 4, relPath: 'Serie/Season 01/S01E04.mkv' });
  const result = computeNextUp([l], {
    getNext: (row) => {
      assert.equal(row, l);
      return n;
    },
    getState: (relPath) => {
      assert.equal(relPath, n.rel_path);
      return 'none';
    },
  });
  assert.deepEqual(result, [{ row: n, updatedAt: 1000 }]);
});

test('finished season finale -> next season\'s S02E01', () => {
  const l = makeRow({ id: 10, seriesId: 1, position: 2600, finished: true, updatedAt: 5000 });
  const n = makeNext({ id: 11, relPath: 'Serie/Season 02/S02E01.mkv' });
  const result = computeNextUp([l], {
    getNext: () => n,
    getState: () => 'none',
  });
  assert.deepEqual(result, [{ row: n, updatedAt: 5000 }]);
});

test('S01E03 finished + S01E04\'s row removed (as after "x") -> S01E04 as next_up', () => {
  // The removed episode has no progress row at all, so it is simply absent
  // from `rows`; its own state lookup answers 'none' the same as "no row".
  const l = makeRow({ id: 3, seriesId: 1, position: 1400, finished: true, updatedAt: 1000 });
  const n = makeNext({ id: 4, relPath: 'Serie/Season 01/S01E04.mkv' });
  const result = computeNextUp([l], { getNext: () => n, getState: () => 'none' });
  assert.deepEqual(result, [{ row: n, updatedAt: 1000 }]);
});

// -- nothing cases -----------------------------------------------------------

const NOTHING_CASES = [
  {
    description: 'the finale has no next episode (getNext -> null)',
    rows: [makeRow({ id: 10, seriesId: 1, position: 2600, finished: true, updatedAt: 5000 })],
    getNext: () => null,
    getState: () => /** @type {const} */ ('none'),
  },
  {
    description: 'an unnumbered episode has no next either (getNext -> null)',
    rows: [makeRow({ id: 9, seriesId: 2, position: 600, finished: true, updatedAt: 500 })],
    getNext: () => null,
    getState: () => /** @type {const} */ ('none'),
  },
  {
    description: 'the successor is already started',
    rows: [makeRow({ id: 3, seriesId: 1, position: 1400, finished: true, updatedAt: 1000 })],
    getNext: () => makeNext({ id: 4, relPath: 'e04' }),
    getState: () => /** @type {const} */ ('in_progress'),
  },
  {
    description: 'the successor is not playable',
    rows: [makeRow({ id: 3, seriesId: 1, position: 1400, finished: true, updatedAt: 1000 })],
    getNext: () => makeNext({ id: 4, relPath: 'e04', playable: false }),
    getState: () => /** @type {const} */ ('none'),
  },
  {
    description: 'the latest row is only in_progress (already listed via L itself)',
    rows: [makeRow({ id: 3, seriesId: 1, position: 100, finished: false, updatedAt: 1000 })],
    getNext: throwIfCalled,
    getState: throwIfCalled,
  },
  {
    description: 'every row in the series is none',
    rows: [makeRow({ id: 3, seriesId: 1, position: 5, finished: false, updatedAt: 1000 })],
    getNext: throwIfCalled,
    getState: throwIfCalled,
  },
  {
    description: 'no rows at all',
    rows: [],
    getNext: throwIfCalled,
    getState: throwIfCalled,
  },
];

for (const { description, rows, getNext, getState } of NOTHING_CASES) {
  test(`computeNextUp emits nothing: ${description}`, () => {
    assert.deepEqual(computeNextUp(rows, { getNext, getState }), []);
  });
}

// -- ignoring `none` rows when choosing L ------------------------------------

test('a newer none row does not hide a finished latest episode', () => {
  const finishedRow = makeRow({ id: 3, seriesId: 1, position: 1400, finished: true, updatedAt: 1000 });
  const newerNoneRow = makeRow({ id: 5, seriesId: 1, position: 10, finished: false, updatedAt: 2000 });
  const n = makeNext({ id: 4, relPath: 'e04' });
  const result = computeNextUp([finishedRow, newerNoneRow], {
    getNext: (row) => {
      assert.equal(row.id, finishedRow.id);
      return n;
    },
    getState: () => 'none',
  });
  assert.deepEqual(result, [{ row: n, updatedAt: 1000 }]);
});

test('ties on updated_at break by the higher item id', () => {
  const lower = makeRow({ id: 3, seriesId: 1, position: 1400, finished: true, updatedAt: 1000 });
  const higher = makeRow({ id: 7, seriesId: 1, position: 1400, finished: true, updatedAt: 1000 });
  const n = makeNext({ id: 8, relPath: 'e08' });
  const result = computeNextUp([lower, higher], {
    getNext: (row) => {
      assert.equal(row.id, higher.id);
      return n;
    },
    getState: () => 'none',
  });
  assert.deepEqual(result, [{ row: n, updatedAt: 1000 }]);
});

// -- multiple series are computed independently ------------------------------

test('each series is grouped and computed independently', () => {
  const series1Finished = makeRow({ id: 3, seriesId: 1, position: 1400, finished: true, updatedAt: 1000 });
  const series2InProgress = makeRow({ id: 20, seriesId: 2, position: 200, finished: false, updatedAt: 3000 });
  const n1 = makeNext({ id: 4, relPath: 's1e04' });
  const result = computeNextUp([series1Finished, series2InProgress], {
    getNext: (row) => {
      assert.equal(row.series_id, 1);
      return n1;
    },
    getState: () => 'none',
  });
  assert.deepEqual(result, [{ row: n1, updatedAt: 1000 }]);
});
