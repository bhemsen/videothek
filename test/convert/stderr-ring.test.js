// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStderrRing } from '../../src/convert/stderr-ring.js';

test('keeps everything while under the window', () => {
  const ring = createStderrRing(100);
  ring.push(Buffer.from('a\nb\n'));
  assert.equal(ring.finish(), 'a\nb\n');
});

test('once wrapped, keeps only whole trailing lines within the window', () => {
  const ring = createStderrRing(10);
  ring.push(Buffer.from('first line\nsecond\nthird\n'));
  assert.equal(ring.finish(), 'third\n');
});

test('drops leading UTF-8 continuation bytes after wrapping', () => {
  const ring = createStderrRing(4);
  ring.push(Buffer.from('x\n\u00e4\u00e4\n'));
  assert.ok(!ring.finish().includes('\ufffd'));
});
