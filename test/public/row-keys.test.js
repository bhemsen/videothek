import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRowIndex } from '../../public/js/lib/row-keys.js';

test('moves one step towards the pressed arrow', () => {
  assert.equal(nextRowIndex('ArrowRight', 0, 3), 1);
  assert.equal(nextRowIndex('ArrowLeft', 2, 3), 1);
});

test('does not wrap at either end of the row', () => {
  assert.equal(nextRowIndex('ArrowRight', 2, 3), -1);
  assert.equal(nextRowIndex('ArrowLeft', 0, 3), -1);
});

test('returns -1 when focus is not on a link', () => {
  assert.equal(nextRowIndex('ArrowRight', -1, 3), -1);
  assert.equal(nextRowIndex('ArrowLeft', -1, 3), -1);
});

test('ignores keys other than ArrowLeft/ArrowRight', () => {
  for (const key of ['Enter', 'ArrowDown', 'ArrowUp', 'Tab', '']) {
    assert.equal(nextRowIndex(key, 1, 3), -1, `key ${JSON.stringify(key)}`);
  }
});
