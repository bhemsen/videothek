import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaTypeFor } from '../../src/http/media-types.js';
import { EXTENSIONS, isPlayableExtension } from '../../src/library/parsers/compat.js';

test('known extension resolves to its compat-table MIME type', () => {
  assert.equal(mediaTypeFor('mp4'), 'video/mp4');
});

test('a leading dot, as path.extname() returns it, is accepted', () => {
  assert.equal(mediaTypeFor('.mp4'), 'video/mp4');
});

test('upper-case input works, with and without a leading dot', () => {
  assert.equal(mediaTypeFor('MP4'), 'video/mp4');
  assert.equal(mediaTypeFor('.MP4'), 'video/mp4');
});

test('unknown extension falls back to application/octet-stream', () => {
  assert.equal(mediaTypeFor('xyz'), 'application/octet-stream');
  assert.equal(mediaTypeFor(''), 'application/octet-stream');
});

test('a known but non-playable extension falls back to application/octet-stream', () => {
  assert.equal(isPlayableExtension('mkv'), false);
  assert.equal(mediaTypeFor('mkv'), 'application/octet-stream');
});

test('every extension the compat table marks playable gets a non-fallback type', () => {
  for (const ext of Object.keys(EXTENSIONS)) {
    if (!isPlayableExtension(ext)) continue;
    const mime = mediaTypeFor(ext);
    assert.notEqual(mime, 'application/octet-stream', `extension "${ext}" should not fall back`);
    assert.equal(mime, EXTENSIONS[ext].mime, `extension "${ext}" should match the compat table`);
  }
});
