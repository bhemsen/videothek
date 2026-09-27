import { test } from 'node:test';
import assert from 'node:assert/strict';
import { START_THRESHOLD_S } from '../../src/api/progress-rules.js';
import { deriveBookProgress } from '../../src/api/audiobook-resume.js';

/**
 * @param {{ id: number, playable?: boolean, duration?: number | null }} input
 * @returns {import('../../src/api/audiobook-resume.js').BookFile}
 */
function file({ id, playable = true, duration = null }) {
  return { id, playable, duration };
}

/**
 * @param {{ itemId: number, position: number, duration?: number | null, finished?: boolean, updatedAt: number }} input
 * @returns {import('../../src/api/audiobook-resume.js').AudioProgressRow}
 */
function row({ itemId, position, duration = null, finished = false, updatedAt }) {
  return { itemId, position, duration, finished: finished ? 1 : 0, updatedAt };
}

// -- new -----------------------------------------------------------------

test('no rows at all -> new, resume the first playable file at 0', () => {
  const files = [file({ id: 1 }), file({ id: 2 })];
  const result = deriveBookProgress(files, []);
  assert.equal(result.state, 'new');
  assert.deepEqual(result.resume, { itemId: 1, position: 0 });
  assert.equal(result.lastPlayedAt, null);
  assert.equal(result.fraction, null);
  assert.equal(result.progress.get(1), null);
  assert.equal(result.progress.get(2), null);
});

test('only uncounted rows (below threshold, unfinished) -> new', () => {
  const files = [file({ id: 1 }), file({ id: 2 })];
  const rows = [row({ itemId: 1, position: START_THRESHOLD_S - 1, updatedAt: 1000 })];
  const result = deriveBookProgress(files, rows);
  assert.equal(result.state, 'new');
  assert.deepEqual(result.resume, { itemId: 1, position: 0 });
  assert.equal(result.progress.get(1), null, '29 s is not counted, so per-file progress stays null');
});

test('no playable file at all -> new, resume null', () => {
  const files = [file({ id: 1, playable: false }), file({ id: 2, playable: false })];
  const result = deriveBookProgress(files, []);
  assert.equal(result.state, 'new');
  assert.equal(result.resume, null);
  assert.equal(result.fraction, null);
});

// -- threshold boundary (29 s ignored, 30 s counted) ----------------------

test('a row at exactly START_THRESHOLD_S is counted; one below is not', () => {
  const files = [file({ id: 1, duration: 100 })];

  const below = deriveBookProgress(files, [
    row({ itemId: 1, position: START_THRESHOLD_S - 1, duration: 100, updatedAt: 1 }),
  ]);
  assert.equal(below.state, 'new');
  assert.equal(below.progress.get(1), null);

  const at = deriveBookProgress(files, [
    row({ itemId: 1, position: START_THRESHOLD_S, duration: 100, updatedAt: 1 }),
  ]);
  assert.equal(at.state, 'in_progress');
  assert.deepEqual(at.resume, { itemId: 1, position: START_THRESHOLD_S });
  assert.deepEqual(at.progress.get(1), { position: START_THRESHOLD_S, duration: 100, finished: false });
});

// -- in_progress: L unfinished --------------------------------------------

test('in_progress: L (the latest counted row) is unfinished -> resume L at its position', () => {
  const files = [file({ id: 1 }), file({ id: 2 }), file({ id: 3 })];
  const rows = [
    row({ itemId: 1, position: 100, finished: true, updatedAt: 1000 }),
    row({ itemId: 2, position: 42, updatedAt: 2000 }),
  ];
  const result = deriveBookProgress(files, rows);
  assert.equal(result.state, 'in_progress');
  assert.deepEqual(result.resume, { itemId: 2, position: 42 });
});

// -- in_progress: L finished -> next unfinished playable file --------------

test('in_progress: L finished -> the next playable, unfinished file after L, at 0 (no row yet)', () => {
  const files = [file({ id: 1 }), file({ id: 2 }), file({ id: 3 })];
  const rows = [row({ itemId: 1, position: 100, finished: true, updatedAt: 1000 })];
  const result = deriveBookProgress(files, rows);
  assert.equal(result.state, 'in_progress');
  assert.deepEqual(result.resume, { itemId: 2, position: 0 });
});

test('in_progress: L finished -> the next unfinished file resumes at its own counted position', () => {
  const files = [file({ id: 1 }), file({ id: 2 }), file({ id: 3 })];
  const rows = [
    row({ itemId: 1, position: 100, finished: true, updatedAt: 1000 }),
    row({ itemId: 2, position: 55, updatedAt: 900 }),
  ];
  const result = deriveBookProgress(files, rows);
  assert.equal(result.state, 'in_progress');
  assert.deepEqual(result.resume, { itemId: 2, position: 55 });
});

test('in_progress: L finished with a finished file right after it -> skips to the next unfinished one', () => {
  const files = [file({ id: 1 }), file({ id: 2 }), file({ id: 3 })];
  const rows = [
    row({ itemId: 1, position: 100, finished: true, updatedAt: 1000 }),
    row({ itemId: 2, position: 100, finished: true, updatedAt: 500 }),
  ];
  const result = deriveBookProgress(files, rows);
  assert.equal(result.state, 'in_progress');
  assert.deepEqual(result.resume, { itemId: 3, position: 0 });
});

// -- in_progress: L finished, no successor -> first unfinished from the start --

test('in_progress: L is the last file and finished -> first unfinished playable file from the start', () => {
  const files = [file({ id: 1 }), file({ id: 2 }), file({ id: 3 })];
  const rows = [
    row({ itemId: 2, position: 10, updatedAt: 100 }), // uncounted, still "unfinished from the start"
    row({ itemId: 3, position: 100, finished: true, updatedAt: 2000 }),
  ];
  const result = deriveBookProgress(files, rows);
  assert.equal(result.state, 'in_progress');
  // Item 1 has no row (unfinished, uncounted) and is first -> resume at 0.
  assert.deepEqual(result.resume, { itemId: 1, position: 0 });
});

test('none after L, but an earlier file has a counted, unfinished row -> resume it at its position', () => {
  const files = [file({ id: 1 }), file({ id: 2 }), file({ id: 3 })];
  const rows = [
    row({ itemId: 1, position: 75, updatedAt: 100 }),
    row({ itemId: 3, position: 100, finished: true, updatedAt: 2000 }),
  ];
  const result = deriveBookProgress(files, rows);
  assert.equal(result.state, 'in_progress');
  assert.deepEqual(result.resume, { itemId: 1, position: 75 });
});

// -- all finished ----------------------------------------------------------

test('all playable files finished -> finished, resume the first playable file at 0', () => {
  const files = [file({ id: 1 }), file({ id: 2 })];
  const rows = [
    row({ itemId: 1, position: 100, finished: true, updatedAt: 1000 }),
    row({ itemId: 2, position: 100, finished: true, updatedAt: 2000 }),
  ];
  const result = deriveBookProgress(files, rows);
  assert.equal(result.state, 'finished');
  assert.deepEqual(result.resume, { itemId: 1, position: 0 });
});

// -- non-playable files never become L, and their own progress is null -----

test('an unfinished row on a now non-playable file never becomes L and has progress null', () => {
  const files = [file({ id: 1 }), file({ id: 2, playable: false }), file({ id: 3 })];
  const rows = [
    // The most recently updated row, but file 2 is no longer playable.
    row({ itemId: 2, position: 90, updatedAt: 9000 }),
    row({ itemId: 1, position: 40, updatedAt: 1000 }),
  ];
  const result = deriveBookProgress(files, rows);
  assert.equal(result.state, 'in_progress');
  // L must be item 1 (playable), not item 2, despite item 2's later updatedAt.
  assert.deepEqual(result.resume, { itemId: 1, position: 40 });
  assert.equal(result.progress.get(2), null, 'a non-playable file always has progress null');
});

test('a finished row on a non-playable file does not count toward "all finished"', () => {
  const files = [file({ id: 1 }), file({ id: 2, playable: false })];
  const rows = [
    row({ itemId: 1, position: 100, finished: true, updatedAt: 1000 }),
    row({ itemId: 2, position: 100, finished: true, updatedAt: 2000 }),
  ];
  const result = deriveBookProgress(files, rows);
  // Only playable file (1) is finished -> "all playable files finished" holds
  // trivially since it is the only one that takes part.
  assert.equal(result.state, 'finished');
});

// -- ties on updatedAt: later in play order wins ---------------------------

test('a tie on updatedAt breaks toward the file later in play order', () => {
  const files = [file({ id: 1 }), file({ id: 2 })];
  const rows = [
    row({ itemId: 1, position: 40, updatedAt: 1000 }),
    row({ itemId: 2, position: 50, updatedAt: 1000 }),
  ];
  const result = deriveBookProgress(files, rows);
  assert.deepEqual(result.resume, { itemId: 2, position: 50 });
});

// -- fraction ---------------------------------------------------------------

test('fraction sums finished (full) + in-progress (position, clamped) over playable files with a known duration', () => {
  const files = [file({ id: 1, duration: 100 }), file({ id: 2, duration: 200 })];
  const rows = [
    row({ itemId: 1, position: 100, duration: 100, finished: true, updatedAt: 1 }),
    row({ itemId: 2, position: 50, duration: 200, updatedAt: 2 }),
  ];
  const result = deriveBookProgress(files, rows);
  assert.equal(result.fraction, (100 + 50) / (100 + 200));
});

test('fraction ignores files with unknown duration entirely (neither numerator nor denominator)', () => {
  const files = [file({ id: 1, duration: 100 }), file({ id: 2, duration: null })];
  const rows = [
    row({ itemId: 1, position: 100, finished: true, updatedAt: 1 }),
    // item 2 has an unknown duration and no row duration either -> excluded
    row({ itemId: 2, position: 999, duration: null, finished: true, updatedAt: 2 }),
  ];
  const result = deriveBookProgress(files, rows);
  assert.equal(result.fraction, 1, 'only item 1 (known duration) contributes');
});

test('fraction falls back to the row-reported duration when the file has no known meta duration', () => {
  const files = [file({ id: 1, duration: null })];
  const rows = [row({ itemId: 1, position: 30, duration: 60, updatedAt: 1 })];
  const result = deriveBookProgress(files, rows);
  assert.equal(result.fraction, 30 / 60);
});

test('fraction excludes non-playable files even with a known duration', () => {
  const files = [file({ id: 1, playable: false, duration: 100 })];
  const rows = [row({ itemId: 1, position: 100, finished: true, updatedAt: 1 })];
  const result = deriveBookProgress(files, rows);
  assert.equal(result.fraction, null);
});

test('fraction is null when every playable file has an unknown duration', () => {
  const files = [file({ id: 1, duration: null })];
  const result = deriveBookProgress(files, []);
  assert.equal(result.fraction, null);
});

// -- lastPlayedAt -------------------------------------------------------------

test('lastPlayedAt is the max updatedAt among counted rows, as ISO', () => {
  const files = [file({ id: 1 }), file({ id: 2 })];
  const rows = [
    row({ itemId: 1, position: 40, updatedAt: 1000 }),
    row({ itemId: 2, position: 45, updatedAt: 5000 }),
  ];
  const result = deriveBookProgress(files, rows);
  assert.equal(result.lastPlayedAt, new Date(5000).toISOString());
});

test('lastPlayedAt ignores uncounted rows', () => {
  const files = [file({ id: 1 })];
  const rows = [row({ itemId: 1, position: START_THRESHOLD_S - 1, updatedAt: 9999 })];
  const result = deriveBookProgress(files, rows);
  assert.equal(result.lastPlayedAt, null);
});
