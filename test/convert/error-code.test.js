// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorCode } from '../../src/convert/error-code.js';

test('errorCode prefers a string errno code over the name', () => {
  assert.equal(errorCode(Object.assign(new Error('x'), { code: 'ENOENT' })), 'ENOENT');
});

test('errorCode falls back to the error name when there is no string code', () => {
  assert.equal(errorCode(new TypeError('x')), 'TypeError');
  assert.equal(errorCode({ code: 5, name: 'Custom' }), 'Custom');
});

test('errorCode returns ERR_UNKNOWN by default and the given fallback otherwise', () => {
  for (const value of [undefined, null, 'oops', 42, {}]) {
    assert.equal(errorCode(value), 'ERR_UNKNOWN');
    assert.equal(errorCode(value, 'ERR_SPAWN'), 'ERR_SPAWN');
  }
});
