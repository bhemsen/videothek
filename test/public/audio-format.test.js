import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatTotal, formatPercent } from '../../public/js/audio/format.js';

test('formatDuration reuses formatClock and shows the placeholder for null', () => {
  assert.equal(formatDuration(5), '0:05');
  assert.equal(formatDuration(3723), '1:02:03');
  assert.equal(formatDuration(null), '–:–');
});

test('formatTotal rounds to minutes/hours with a 1 Min. floor and shows the placeholder for null', () => {
  assert.equal(formatTotal(2880), '48 Min.');
  assert.equal(formatTotal(25920), '7 Std. 12 Min.');
  assert.equal(formatTotal(25200), '7 Std.');
  assert.equal(formatTotal(10), '1 Min.');
  assert.equal(formatTotal(0), '1 Min.');
  assert.equal(formatTotal(null), '–:–');
});

test('formatPercent floors to a whole percentage and shows the placeholder for null', () => {
  assert.equal(formatPercent(0.34), '34 %');
  assert.equal(formatPercent(0.999), '99 %');
  assert.equal(formatPercent(0), '0 %');
  assert.equal(formatPercent(1), '100 %');
  assert.equal(formatPercent(null), '–');
});

test('formatPercent is not thrown off by binary-float artefacts of an exact fraction', () => {
  assert.equal(0.29 * 100, 28.999999999999996, 'documents the artefact this test guards against');
  assert.equal(formatPercent(0.29), '29 %');
  assert.equal(formatPercent(0.57), '57 %');
});
