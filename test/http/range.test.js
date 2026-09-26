import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange } from '../../src/http/range.js';

const SIZE = 1000;

test('start-end range (0-99) is satisfiable and clamped as given', () => {
  assert.deepEqual(parseRange('bytes=0-99', SIZE), { type: 'range', start: 0, end: 99 });
});

test('open-ended range (a-) runs to the last byte', () => {
  assert.deepEqual(parseRange('bytes=500-', SIZE), { type: 'range', start: 500, end: SIZE - 1 });
});

test('suffix range (-n) serves the last n bytes', () => {
  assert.deepEqual(parseRange('bytes=-500', SIZE), { type: 'range', start: SIZE - 500, end: SIZE - 1 });
});

test('suffix length >= size serves the whole file as a range', () => {
  assert.deepEqual(parseRange('bytes=-2000', SIZE), { type: 'range', start: 0, end: SIZE - 1 });
});

test('end beyond size is clamped to the last byte', () => {
  assert.deepEqual(parseRange('bytes=0-99999', SIZE), { type: 'range', start: 0, end: SIZE - 1 });
});

test('start equal to size is unsatisfiable', () => {
  assert.deepEqual(parseRange(`bytes=${SIZE}-${SIZE + 5}`, SIZE), { type: 'unsatisfiable' });
});

test('start greater than end is unsatisfiable', () => {
  assert.deepEqual(parseRange('bytes=500-100', SIZE), { type: 'unsatisfiable' });
});

test('suffix length of zero (-0) is unsatisfiable', () => {
  assert.deepEqual(parseRange('bytes=-0', SIZE), { type: 'unsatisfiable' });
});

test('any range on an empty file is unsatisfiable', () => {
  assert.deepEqual(parseRange('bytes=0-0', 0), { type: 'unsatisfiable' });
  assert.deepEqual(parseRange('bytes=0-', 0), { type: 'unsatisfiable' });
  assert.deepEqual(parseRange('bytes=-1', 0), { type: 'unsatisfiable' });
});

test('missing header is ignored (none)', () => {
  assert.deepEqual(parseRange(undefined, SIZE), { type: 'none' });
  assert.deepEqual(parseRange(null, SIZE), { type: 'none' });
});

test('non-digit spec (bytes=abc) is ignored (none)', () => {
  assert.deepEqual(parseRange('bytes=abc', SIZE), { type: 'none' });
});

test('bare dash spec (bytes=-) is ignored (none)', () => {
  assert.deepEqual(parseRange('bytes=-', SIZE), { type: 'none' });
});

test('empty spec (bytes=) is ignored (none)', () => {
  assert.deepEqual(parseRange('bytes=', SIZE), { type: 'none' });
});

test('wrong range unit (items=0-1) is ignored (none)', () => {
  assert.deepEqual(parseRange('items=0-1', SIZE), { type: 'none' });
});

test('multiple range-specs (multi-range) are ignored (none)', () => {
  assert.deepEqual(parseRange('bytes=0-99,200-299', SIZE), { type: 'none' });
});

test('whitespace around the spec is trimmed', () => {
  assert.deepEqual(parseRange('bytes= 0-99 ', SIZE), { type: 'range', start: 0, end: 99 });
});

test('oversized start digit string is unsatisfiable', () => {
  const oversizedStart = `${Number.MAX_SAFE_INTEGER}0`;
  assert.deepEqual(parseRange(`bytes=${oversizedStart}-100`, SIZE), { type: 'unsatisfiable' });
});

test('oversized end digit string is clamped to the last byte', () => {
  const oversizedEnd = `${Number.MAX_SAFE_INTEGER}0`;
  assert.deepEqual(parseRange(`bytes=0-${oversizedEnd}`, SIZE), { type: 'range', start: 0, end: SIZE - 1 });
});

test('oversized suffix digit string serves the whole file', () => {
  const oversizedSuffix = `${Number.MAX_SAFE_INTEGER}0`;
  assert.deepEqual(parseRange(`bytes=-${oversizedSuffix}`, SIZE), { type: 'range', start: 0, end: SIZE - 1 });
});

test('start at the exact last byte is satisfiable', () => {
  assert.deepEqual(parseRange(`bytes=${SIZE - 1}-`, SIZE), { type: 'range', start: SIZE - 1, end: SIZE - 1 });
});
