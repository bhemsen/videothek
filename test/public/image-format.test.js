import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTakenAt,
  orientationClass,
  countLabel,
  headerMeta,
  parseBildHash,
} from '../../public/js/image-format.js';

test('formatTakenAt slices a local date-time without Date parsing', () => {
  assert.equal(formatTakenAt('2024-07-14T09:14:00'), '14.07.2024, 09:14');
  assert.equal(formatTakenAt('2024-12-01T23:59:59'), '01.12.2024, 23:59');
});

test('formatTakenAt returns an empty string for unusable input', () => {
  assert.equal(formatTakenAt(''), '');
  assert.equal(formatTakenAt('2024-07-14'), '');
  assert.equal(formatTakenAt(null), '');
  assert.equal(formatTakenAt(undefined), '');
});

test('orientationClass maps 2-8 to their class', () => {
  assert.equal(orientationClass(2), 'orient-2');
  assert.equal(orientationClass(3), 'orient-3');
  assert.equal(orientationClass(4), 'orient-4');
  assert.equal(orientationClass(5), 'orient-5');
  assert.equal(orientationClass(6), 'orient-6');
  assert.equal(orientationClass(7), 'orient-7');
  assert.equal(orientationClass(8), 'orient-8');
});

test('orientationClass leaves normal (1) and unknown values untransformed', () => {
  assert.equal(orientationClass(1), '');
  assert.equal(orientationClass(0), '');
  assert.equal(orientationClass(9), '');
  assert.equal(orientationClass(-1), '');
  assert.equal(orientationClass(2.5), '');
  assert.equal(orientationClass(NaN), '');
});

test('countLabel uses the singular for exactly one file', () => {
  assert.equal(countLabel(1), '1 Datei');
});

test('countLabel uses the plural for zero and for more than one file', () => {
  assert.equal(countLabel(0), '0 Dateien');
  assert.equal(countLabel(2), '2 Dateien');
  assert.equal(countLabel(42), '42 Dateien');
});

test('headerMeta joins both non-zero parts with the middle dot', () => {
  assert.equal(headerMeta(2, 9), '2 Ordner · 9 Dateien');
  assert.equal(headerMeta(1, 1), '1 Ordner · 1 Datei');
});

test('headerMeta omits whichever part is zero', () => {
  assert.equal(headerMeta(0, 5), '5 Dateien');
  assert.equal(headerMeta(3, 0), '3 Ordner');
});

test('headerMeta returns an empty string when both counts are zero', () => {
  assert.equal(headerMeta(0, 0), '');
});

test('parseBildHash accepts a positive integer id', () => {
  assert.equal(parseBildHash('#bild-42'), 42);
  assert.equal(parseBildHash('#bild-1'), 1);
});

test('parseBildHash rejects zero, leading zeros, non-digits and other hashes', () => {
  assert.equal(parseBildHash('#bild-0'), null);
  assert.equal(parseBildHash('#bild-01'), null);
  assert.equal(parseBildHash('#bild-x'), null);
  assert.equal(parseBildHash('#foo'), null);
  assert.equal(parseBildHash(''), null);
});

test('parseBildHash rejects an id beyond the safe-integer bound', () => {
  assert.equal(parseBildHash('#bild-99999999999999999'), null);
});
