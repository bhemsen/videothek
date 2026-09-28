import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOME_LIMIT_DEFAULT, HOME_LIMIT_MAX, parseHomeLimit } from '../../src/api/home-params.js';

/**
 * @param {string | null} raw
 * @returns {number | null}
 */
function parse(raw) {
  const params = new URLSearchParams();
  if (raw !== null) params.set('limit', raw);
  return parseHomeLimit(params);
}

test('parseHomeLimit: absent defaults to 10, valid digit strings in range parse', () => {
  // Literals, not the constants under test: this must fail if HOME_LIMIT_DEFAULT or
  // HOME_LIMIT_MAX ever drifts from the documented API values (default 10, range
  // 1..20; see the handler JSDoc in home-listening.js and home-previews.js).
  assert.equal(parse(null), 10);
  assert.equal(parse('1'), 1);
  assert.equal(parse('20'), 20);
  assert.equal(parse('05'), 5);
  assert.equal(HOME_LIMIT_DEFAULT, 10);
  assert.equal(HOME_LIMIT_MAX, 20);
});

test('parseHomeLimit: empty, zero, out of range, fractional, non-numeric or padded is invalid', () => {
  for (const raw of ['', '0', '21', '-1', '1.5', 'abc', ' 5']) {
    assert.equal(parse(raw), null, `expected null for ${JSON.stringify(raw)}`);
  }
});
