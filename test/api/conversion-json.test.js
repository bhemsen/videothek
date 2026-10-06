import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveConversionStatus,
  buildConversionEntry,
  buildConversionList,
  buildConversionEntriesForIds,
  parseConversionIds,
} from '../../src/api/conversion-json.js';

/**
 * A `ConversionListRow` as `src/db/conversion-queries.js` would return it:
 * `library_items` columns under plain names, every `conversions` column
 * under a `c_` prefix, plus the computed `position`. Defaults describe a
 * convertible, not-yet-queued movie with no `conversions` row at all
 * (`status: 'none'`).
 * @param {Partial<import('../../src/db/conversion-queries.js').ConversionListRow>} overrides
 * @returns {import('../../src/db/conversion-queries.js').ConversionListRow}
 */
function baseRow(overrides = {}) {
  return /** @type {import('../../src/db/conversion-queries.js').ConversionListRow} */ ({
    id: 1,
    rel_path: 'Filme/Item.mkv',
    dir: 'Filme',
    category: 'movies',
    kind: 'video',
    ext: 'mkv',
    title: 'Item',
    sort_title: 'item',
    year: null,
    series_id: null,
    series_title: null,
    season: null,
    episode: null,
    episode_end: null,
    video_codec: null,
    audio_codec: null,
    playable: false,
    size: 1000,
    mtime_ms: 1,
    scan_version: 1,
    added_at: 1000,
    scanned_at: 1000,
    c_rel_path: null,
    c_storage_key: null,
    c_target: null,
    c_status: null,
    c_source_size: null,
    c_source_mtime_ms: null,
    c_output_rel: null,
    c_output_size: null,
    c_notes: null,
    c_error: null,
    c_error_detail: null,
    c_queued_at: null,
    c_started_at: null,
    c_finished_at: null,
    position: null,
    ...overrides,
  });
}

// -- deriveConversionStatus -----------------------------------------------

test('deriveConversionStatus: no conversions row -> none', () => {
  assert.equal(deriveConversionStatus(baseRow()), 'none');
});

for (const status of /** @type {const} */ (['queued', 'converting', 'failed'])) {
  test(`deriveConversionStatus: stored ${status} passes through unchanged`, () => {
    assert.equal(deriveConversionStatus(baseRow({ c_status: status })), status);
  });
}

test('deriveConversionStatus: playable row whose source size/mtime still match -> playable', () => {
  const row = baseRow({ c_status: 'playable', c_source_size: 1000, c_source_mtime_ms: 1, size: 1000, mtime_ms: 1 });
  assert.equal(deriveConversionStatus(row), 'playable');
});

test('deriveConversionStatus: playable row whose source size changed -> stale', () => {
  const row = baseRow({ c_status: 'playable', c_source_size: 999, c_source_mtime_ms: 1, size: 1000, mtime_ms: 1 });
  assert.equal(deriveConversionStatus(row), 'stale');
});

test('deriveConversionStatus: playable row whose source mtime changed -> stale', () => {
  const row = baseRow({ c_status: 'playable', c_source_size: 1000, c_source_mtime_ms: 2, size: 1000, mtime_ms: 1 });
  assert.equal(deriveConversionStatus(row), 'stale');
});

// -- buildConversionEntry ---------------------------------------------------

test('buildConversionEntry: none entry carries item/convertible/target and null conversion fields', () => {
  const row = baseRow();
  const entry = buildConversionEntry(row);
  assert.equal(entry.itemId, 1);
  assert.equal(entry.item.id, 1);
  assert.equal(entry.item.fileName, 'Item.mkv');
  assert.equal(entry.convertible, true, 'not playable, has bytes, movies+video -> web target');
  assert.equal(entry.target, 'web');
  assert.equal(entry.status, 'none');
  assert.equal(entry.position, null);
  assert.equal(entry.error, null);
  assert.equal(entry.errorDetail, null);
  assert.deepEqual(entry.notes, []);
  assert.equal(entry.outputSize, null);
  assert.equal(entry.queuedAt, null);
  assert.equal(entry.startedAt, null);
  assert.equal(entry.finishedAt, null);
});

test('buildConversionEntry: convertible is false once the item is already playable', () => {
  const entry = buildConversionEntry(baseRow({ playable: true }));
  assert.equal(entry.convertible, false);
});

test('buildConversionEntry: convertible is false for a zero-byte source', () => {
  const entry = buildConversionEntry(baseRow({ size: 0 }));
  assert.equal(entry.convertible, false);
});

test('buildConversionEntry: target is null and convertible is false for a non-convertible kind (images)', () => {
  const entry = buildConversionEntry(baseRow({ category: 'images', kind: 'image', ext: 'jpg' }));
  assert.equal(entry.target, null);
  assert.equal(entry.convertible, false);
});

test('buildConversionEntry: notes parsed from the stored JSON array', () => {
  const entry = buildConversionEntry(baseRow({ c_status: 'playable', c_notes: '["note a","note b"]' }));
  assert.deepEqual(entry.notes, ['note a', 'note b']);
});

test('buildConversionEntry: error/errorDetail/outputSize pass through, timestamps become ISO-8601', () => {
  const row = baseRow({
    c_status: 'failed',
    c_error: 'source_missing',
    c_error_detail: 'ENOENT',
    c_output_size: 12345,
    c_queued_at: 1000,
    c_started_at: 2000,
    c_finished_at: 3000,
  });
  const entry = buildConversionEntry(row);
  assert.equal(entry.error, 'source_missing');
  assert.equal(entry.errorDetail, 'ENOENT');
  assert.equal(entry.outputSize, 12345);
  assert.equal(entry.queuedAt, new Date(1000).toISOString());
  assert.equal(entry.startedAt, new Date(2000).toISOString());
  assert.equal(entry.finishedAt, new Date(3000).toISOString());
});

test('buildConversionEntry: position passes through unchanged', () => {
  const entry = buildConversionEntry(baseRow({ c_status: 'queued', position: 3 }));
  assert.equal(entry.position, 3);
});

// -- buildConversionList (GET without ids) -----------------------------------

test('buildConversionList: groups converting, queued, failed, stale, playable in that order', () => {
  const rows = [
    baseRow({ id: 5, rel_path: 'playable.mkv', c_status: 'playable', c_source_size: 1000, c_source_mtime_ms: 1, c_finished_at: 10 }),
    baseRow({ id: 4, rel_path: 'stale.mkv', c_status: 'playable', c_source_size: 999, c_source_mtime_ms: 1, c_finished_at: 10 }),
    baseRow({ id: 3, rel_path: 'failed.mkv', c_status: 'failed', c_finished_at: 10 }),
    baseRow({ id: 2, rel_path: 'queued.mkv', c_status: 'queued', position: 1, c_queued_at: 10 }),
    baseRow({ id: 1, rel_path: 'converting.mkv', c_status: 'converting', c_queued_at: 5, c_started_at: 10 }),
  ];

  const entries = buildConversionList(rows);

  assert.deepEqual(
    entries.map((e) => e.status),
    ['converting', 'queued', 'failed', 'stale', 'playable']
  );
});

test('buildConversionList: queued rows ascending by position', () => {
  const rows = [
    baseRow({ id: 1, rel_path: 'c.mkv', c_status: 'queued', position: 3, c_queued_at: 30 }),
    baseRow({ id: 2, rel_path: 'a.mkv', c_status: 'queued', position: 1, c_queued_at: 10 }),
    baseRow({ id: 3, rel_path: 'b.mkv', c_status: 'queued', position: 2, c_queued_at: 20 }),
  ];

  const entries = buildConversionList(rows);

  assert.deepEqual(entries.map((e) => e.itemId), [2, 3, 1]);
});

test('buildConversionList: every other group is newest first by finished_at, falling back to queued_at', () => {
  const rows = [
    // Two failed rows: one finished later than the other.
    baseRow({ id: 1, rel_path: 'older-failed.mkv', c_status: 'failed', c_queued_at: 1, c_finished_at: 100 }),
    baseRow({ id: 2, rel_path: 'newer-failed.mkv', c_status: 'failed', c_queued_at: 2, c_finished_at: 200 }),
    // A third failed row that never started (no finished_at): falls back to queued_at,
    // and its queued_at (150) sits between the other two finished_at values.
    baseRow({ id: 3, rel_path: 'never-started.mkv', c_status: 'failed', c_queued_at: 150, c_finished_at: null }),
  ];

  const entries = buildConversionList(rows);

  assert.deepEqual(entries.map((e) => e.itemId), [2, 3, 1], 'newest finished_at first, then the queued_at fallback, then the oldest finished_at');
});

test('buildConversionList: the one converting row is never counted as a position and is unaffected by ordering rules of other groups', () => {
  const rows = [
    baseRow({ id: 1, rel_path: 'running.mkv', c_status: 'converting', c_queued_at: 1, c_started_at: 2 }),
    baseRow({ id: 2, rel_path: 'waiting.mkv', c_status: 'queued', position: 1, c_queued_at: 5 }),
  ];

  const entries = buildConversionList(rows);

  assert.equal(entries[0].itemId, 1);
  assert.equal(entries[0].position, null);
  assert.equal(entries[1].position, 1);
});

// -- buildConversionEntriesForIds (GET with ids) -----------------------------

test('buildConversionEntriesForIds: entries follow request order, not row order', () => {
  const rows = [
    baseRow({ id: 1, rel_path: 'a.mkv' }),
    baseRow({ id: 2, rel_path: 'b.mkv' }),
    baseRow({ id: 3, rel_path: 'c.mkv' }),
  ];

  const entries = buildConversionEntriesForIds(rows, [3, 1, 2]);

  assert.deepEqual(entries.map((e) => e.itemId), [3, 1, 2]);
});

test('buildConversionEntriesForIds: an id absent from rows (never in library_items) is omitted', () => {
  const rows = [baseRow({ id: 1, rel_path: 'a.mkv' })];

  const entries = buildConversionEntriesForIds(rows, [1, 999]);

  assert.deepEqual(entries.map((e) => e.itemId), [1]);
});

test('buildConversionEntriesForIds: an item present but with no conversions row gets status none', () => {
  const rows = [baseRow({ id: 1, rel_path: 'a.mkv', c_status: null })];

  const entries = buildConversionEntriesForIds(rows, [1]);

  assert.equal(entries[0].status, 'none');
});

// -- parseConversionIds -------------------------------------------------------

test('parseConversionIds: a single valid id', () => {
  assert.deepEqual(parseConversionIds('42'), [42]);
});

test('parseConversionIds: several valid ids keep request order', () => {
  assert.deepEqual(parseConversionIds('10,2,7'), [10, 2, 7]);
});

test('parseConversionIds: duplicates ignored, first occurrence kept in place', () => {
  assert.deepEqual(parseConversionIds('5,3,5,3,7'), [5, 3, 7]);
});

test('parseConversionIds: exactly 500 unique ids is accepted', () => {
  const ids = Array.from({ length: 500 }, (_, i) => i + 1);
  assert.deepEqual(parseConversionIds(ids.join(',')), ids);
});

test('parseConversionIds: a safe-integer 16-digit id is accepted', () => {
  assert.deepEqual(parseConversionIds('1000000000000000'), [1000000000000000]);
});

const INVALID_IDS_QUERIES = [
  { description: 'empty string', raw: '' },
  { description: 'trailing comma (empty token)', raw: '1,' },
  { description: 'leading zero', raw: '01' },
  { description: 'zero itself', raw: '0' },
  { description: 'negative number', raw: '-1' },
  { description: 'decimal number', raw: '1.5' },
  { description: 'non-numeric token', raw: 'abc' },
  { description: 'whitespace around a digit', raw: ' 1' },
  { description: 'one bad token among good ones', raw: '1,2,x' },
  { description: '501 ids (over the limit)', raw: Array.from({ length: 501 }, (_, i) => i + 1).join(',') },
  { description: 'unsafe integer (exceeds Number.MAX_SAFE_INTEGER)', raw: '9999999999999999' },
];

for (const { description, raw } of INVALID_IDS_QUERIES) {
  test(`parseConversionIds rejects: ${description}`, () => {
    assert.equal(parseConversionIds(raw), null);
  });
}

test('buildConversionEntry: cancelling only for a converting row whose rel_path matches', () => {
  const converting = baseRow({ c_status: 'converting' });
  assert.equal(buildConversionEntry(converting, 'Filme/Item.mkv').cancelling, true);
  assert.equal(buildConversionEntry(converting, 'Filme/Other.mkv').cancelling, false);
  assert.equal(buildConversionEntry(converting, null).cancelling, false);
  const failed = baseRow({ c_status: 'failed' });
  assert.equal(buildConversionEntry(failed, 'Filme/Item.mkv').cancelling, false);
});
