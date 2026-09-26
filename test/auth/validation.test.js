import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUsername,
  validateUsername,
  validatePassword,
  validateRole,
} from '../../src/auth/validation.js';

test('normalizeUsername trims, NFC-normalizes and lower-cases', () => {
  assert.equal(normalizeUsername('  Julia  '), 'julia');
  // "é" as a combining sequence (e + U+0301) normalizes to the precomposed
  // form (U+00E9), matching the precomposed spelling after lower-casing.
  const combining = 'JOSé';
  assert.equal(normalizeUsername(combining), 'josé');
  assert.equal(normalizeUsername('JÖRG'), 'jörg');
});

test('validateUsername accepts letters, digits, dot, underscore, hyphen', () => {
  assert.equal(validateUsername('julia'), 'julia');
  assert.equal(validateUsername('Julia_01'), 'julia_01');
  assert.equal(validateUsername('j.r-g'), 'j.r-g');
  assert.equal(validateUsername('JÖRG'), 'jörg');
});

test('validateUsername rejects empty, oversized and disallowed characters', () => {
  assert.equal(validateUsername(''), null);
  assert.equal(validateUsername('   '), null);
  assert.equal(validateUsername('a'.repeat(33)), null);
  assert.equal(validateUsername('a'.repeat(32)), 'a'.repeat(32));
  assert.equal(validateUsername('julia dupont'), null);
  assert.equal(validateUsername('julia@example.com'), null);
  assert.equal(validateUsername('julia/admin'), null);
});

test('validateUsername rejects non-string input', () => {
  // @ts-expect-error deliberately wrong type
  assert.equal(validateUsername(undefined), null);
  // @ts-expect-error deliberately wrong type
  assert.equal(validateUsername(42), null);
});

test('validatePassword enforces 8-256 Unicode code points', () => {
  assert.equal(validatePassword('1234567'), false);
  assert.equal(validatePassword('12345678'), true);
  assert.equal(validatePassword('a'.repeat(256)), true);
  assert.equal(validatePassword('a'.repeat(257)), false);
});

test('validatePassword counts code points, not UTF-16 code units', () => {
  // Each surrogate-pair emoji is one code point but two UTF-16 units, so a
  // naive `.length` check would over-count by 8 here.
  const eightEmoji = '\u{1F600}'.repeat(8);
  assert.equal(eightEmoji.length, 16);
  assert.equal(validatePassword(eightEmoji), true);
  const sevenEmoji = '\u{1F600}'.repeat(7);
  assert.equal(validatePassword(sevenEmoji), false);
});

test('validatePassword rejects non-string input', () => {
  // @ts-expect-error deliberately wrong type
  assert.equal(validatePassword(undefined), false);
  // @ts-expect-error deliberately wrong type
  assert.equal(validatePassword(12345678), false);
});

test('validateRole accepts only admin and user', () => {
  assert.equal(validateRole('admin'), true);
  assert.equal(validateRole('user'), true);
  assert.equal(validateRole('Admin'), false);
  assert.equal(validateRole(''), false);
  // @ts-expect-error deliberately wrong type
  assert.equal(validateRole(undefined), false);
});
