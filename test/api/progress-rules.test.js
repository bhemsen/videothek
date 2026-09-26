import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES } from '../../src/library/categories.js';
import {
  START_THRESHOLD_S,
  VIDEO_FINISHED_RATIO,
  AUDIO_END_WINDOW_S,
  MAX_DURATION_S,
  validateProgressBody,
  decideProgressWrite,
  deriveProgressState,
  toProgressEntryJson,
  parseProgressQuery,
} from '../../src/api/progress-rules.js';

/** @typedef {import('../../src/library/categories.js').Category} Category */

test('constants match the spec', () => {
  assert.equal(START_THRESHOLD_S, 30);
  assert.equal(VIDEO_FINISHED_RATIO, 0.9);
  assert.equal(AUDIO_END_WINDOW_S, 30);
  assert.equal(MAX_DURATION_S, 604800);
});

// -- validateProgressBody -----------------------------------------------

const INVALID_BODIES = [
  { description: 'null body', body: null },
  { description: 'non-object body', body: 'hello' },
  { description: 'missing fields', body: {} },
  { description: 'position NaN', body: { position: NaN, duration: 100 } },
  { description: 'position +Infinity', body: { position: Infinity, duration: 100 } },
  { description: 'position -Infinity', body: { position: -Infinity, duration: 100 } },
  { description: 'position negative', body: { position: -1, duration: 100 } },
  { description: 'position as string', body: { position: '30', duration: 100 } },
  { description: 'duration missing', body: { position: 10 } },
  { description: 'duration NaN', body: { position: 10, duration: NaN } },
  { description: 'duration as string', body: { position: 10, duration: '100' } },
  { description: 'duration zero', body: { position: 0, duration: 0 } },
  { description: 'duration negative', body: { position: 0, duration: -1 } },
  { description: 'duration above MAX_DURATION_S', body: { position: 0, duration: MAX_DURATION_S + 1 } },
];

for (const { description, body } of INVALID_BODIES) {
  test(`validateProgressBody rejects: ${description}`, () => {
    assert.equal(validateProgressBody(body), null);
  });
}

test('validateProgressBody accepts a valid body unchanged', () => {
  assert.deepEqual(validateProgressBody({ position: 12.5, duration: 100 }), { position: 12.5, duration: 100 });
});

test('validateProgressBody clamps position > duration to duration', () => {
  assert.deepEqual(validateProgressBody({ position: 120, duration: 100 }), { position: 100, duration: 100 });
});

test('validateProgressBody accepts duration exactly at MAX_DURATION_S', () => {
  const result = validateProgressBody({ position: 0, duration: MAX_DURATION_S });
  assert.deepEqual(result, { position: 0, duration: MAX_DURATION_S });
});

test('validateProgressBody ignores unknown fields', () => {
  assert.deepEqual(validateProgressBody({ position: 1, duration: 2, extra: 'x' }), { position: 1, duration: 2 });
});

// -- decideProgressWrite: finished-rule boundaries -----------------------

/**
 * @type {{ description: string, category: Category, position: number, duration: number, expectFinished: boolean }[]}
 */
const FINISHED_RULE_CASES = [
  { description: 'movies at exactly 90%', category: 'movies', position: 90, duration: 100, expectFinished: true },
  { description: 'movies just below 90%', category: 'movies', position: 89, duration: 100, expectFinished: false },
  { description: 'series just above 90%', category: 'series', position: 91, duration: 100, expectFinished: true },
  { description: 'music at exactly 30s remaining', category: 'music', position: 70, duration: 100, expectFinished: true },
  { description: 'music just above 30s remaining', category: 'music', position: 69, duration: 100, expectFinished: false },
  { description: 'audiobooks just below 30s remaining', category: 'audiobooks', position: 71, duration: 100, expectFinished: true },
  { description: 'short audiobook finished on first report', category: 'audiobooks', position: 0, duration: 20, expectFinished: true },
];

for (const { description, category, position, duration, expectFinished } of FINISHED_RULE_CASES) {
  test(`decideProgressWrite finished rule: ${description}`, () => {
    const result = decideProgressWrite({ category, position, duration, existingFinished: false });
    assert.equal(result.write, true);
    assert.equal(result.write && result.finished, expectFinished);
  });
}

// -- decideProgressWrite: write-rule order (finished guard) --------------

/**
 * @type {{
 *   description: string, category: Category, position: number, duration: number, existingFinished: boolean,
 *   expected: { write: false } | { write: true, finished: boolean },
 * }[]}
 */
const WRITE_RULE_CASES = [
  { description: '20s video write on an existing finished row is guarded', category: 'movies', position: 20, duration: 100, existingFinished: true, expected: { write: false } },
  { description: '25s audio write on an existing finished row is guarded', category: 'music', position: 25, duration: 1000, existingFinished: true, expected: { write: false } },
  { description: 'guard does not apply without an existing finished row', category: 'movies', position: 20, duration: 100, existingFinished: false, expected: { write: true, finished: false } },
  { description: 'a >= 30s re-watch write flips a finished row back to in_progress', category: 'movies', position: 35, duration: 100, existingFinished: true, expected: { write: true, finished: false } },
  { description: 'the finished rule wins even below the start threshold', category: 'audiobooks', position: 5, duration: 20, existingFinished: false, expected: { write: true, finished: true } },
];

for (const { description, category, position, duration, existingFinished, expected } of WRITE_RULE_CASES) {
  test(`write-rule order: ${description}`, () => {
    assert.deepEqual(decideProgressWrite({ category, position, duration, existingFinished }), expected);
  });
}

// -- deriveProgressState: 30s start threshold on both sides --------------

const STATE_CASES = [
  { description: 'none just below the start threshold', finished: false, position: 29, expected: 'none' },
  { description: 'in_progress at exactly the start threshold', finished: false, position: 30, expected: 'in_progress' },
  { description: 'finished overrides position', finished: true, position: 0, expected: 'finished' },
  { description: 'no row (position 0, unfinished) is none', finished: false, position: 0, expected: 'none' },
];

for (const { description, finished, position, expected } of STATE_CASES) {
  test(`deriveProgressState: ${description}`, () => {
    assert.equal(deriveProgressState({ finished, position }), expected);
  });
}

// -- toProgressEntryJson --------------------------------------------------

test('toProgressEntryJson: updatedAt is ISO-8601', () => {
  const entry = toProgressEntryJson({
    itemId: 5,
    position: 40,
    duration: 100,
    finished: false,
    updatedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
  });
  assert.deepEqual(entry, {
    itemId: 5,
    position: 40,
    duration: 100,
    state: 'in_progress',
    updatedAt: '2026-01-02T03:04:05.000Z',
  });
});

test('toProgressEntryJson: the "no row" entry', () => {
  const entry = toProgressEntryJson({ itemId: 7, position: 0, duration: null, finished: false, updatedAt: null });
  assert.deepEqual(entry, { itemId: 7, position: 0, duration: null, state: 'none', updatedAt: null });
});

// -- parseProgressQuery ----------------------------------------------------

test('parseProgressQuery: defaults to continue view, limit 20, non-image categories', () => {
  const result = parseProgressQuery(new URLSearchParams());
  assert.deepEqual(result, { categories: ['movies', 'series', 'music', 'audiobooks'], view: 'continue', limit: 20 });
});

test('parseProgressQuery: every default category id exists in CATEGORIES', () => {
  const result = parseProgressQuery(new URLSearchParams());
  assert.ok(result);
  for (const id of result.categories) {
    assert.ok(CATEGORIES.includes(id), `${id} missing from CATEGORIES`);
  }
});

test('parseProgressQuery: comma list, duplicates ignored', () => {
  const result = parseProgressQuery(new URLSearchParams('category=series,movies,series'));
  assert.ok(result);
  assert.deepEqual(result.categories, ['series', 'movies']);
});

test('parseProgressQuery: view=all with no limit', () => {
  const result = parseProgressQuery(new URLSearchParams('view=all'));
  assert.deepEqual(result, { categories: ['movies', 'series', 'music', 'audiobooks'], view: 'all', limit: null });
});

test('parseProgressQuery: unknown parameters are ignored', () => {
  const result = parseProgressQuery(new URLSearchParams('foo=bar'));
  assert.deepEqual(result, { categories: ['movies', 'series', 'music', 'audiobooks'], view: 'continue', limit: 20 });
});

const INVALID_QUERIES = [
  'category=',
  'category=movies,,series',
  'category=bogus',
  'category=images',
  'category=movies,images',
  'view=bogus',
  'view=all&limit=10',
  'view=all&limit=',
];

for (const query of INVALID_QUERIES) {
  test(`parseProgressQuery: invalid query "${query}"`, () => {
    assert.equal(parseProgressQuery(new URLSearchParams(query)), null);
  });
}

const LIMIT_CASES = [
  { description: 'limit=1 is the minimum', query: 'limit=1', expectedLimit: 1 },
  { description: 'limit=50 is the maximum', query: 'limit=50', expectedLimit: 50 },
  { description: 'limit=0 is invalid', query: 'limit=0', expectedLimit: null },
  { description: 'limit=51 is invalid', query: 'limit=51', expectedLimit: null },
  { description: 'a negative limit is invalid', query: 'limit=-1', expectedLimit: null },
  { description: 'a non-numeric limit is invalid', query: 'limit=abc', expectedLimit: null },
];

for (const { description, query, expectedLimit } of LIMIT_CASES) {
  test(`parseProgressQuery: ${description}`, () => {
    const result = parseProgressQuery(new URLSearchParams(query));
    if (expectedLimit === null) {
      assert.equal(result, null);
    } else {
      assert.ok(result);
      assert.equal(result.limit, expectedLimit);
    }
  });
}
