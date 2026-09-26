import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTENSIONS,
  SCAN_VERSION,
  isPlayableExtension,
  mimeForExtension,
  resolvePlayable,
} from '../../../src/library/parsers/compat.js';

test('SCAN_VERSION starts at 1', () => {
  assert.equal(SCAN_VERSION, 1);
});

test('every extension resolves with mime set iff playable', () => {
  for (const [ext, row] of Object.entries(EXTENSIONS)) {
    assert.ok(['video', 'audio', 'image'].includes(row.kind), `${ext} has a valid kind`);
    assert.equal(typeof row.playable, 'boolean', `${ext}.playable is boolean`);
    assert.equal(typeof row.sniff, 'boolean', `${ext}.sniff is boolean`);
    assert.equal(isPlayableExtension(ext), row.playable, `${ext} isPlayableExtension matches table`);
    assert.equal(mimeForExtension(ext), row.mime, `${ext} mimeForExtension matches table`);
    if (row.playable) {
      assert.equal(typeof row.mime, 'string', `${ext} has a mime string`);
    } else {
      assert.equal(row.mime, null, `${ext} has no mime`);
    }
  }
});

test('unknown extension is not playable and has no mime', () => {
  assert.equal(isPlayableExtension('xyz'), false);
  assert.equal(mimeForExtension('xyz'), null);
});

test('spec table spot checks', () => {
  assert.equal(EXTENSIONS.webm.mime, 'video/webm');
  assert.equal(EXTENSIONS.mp4.sniff, true);
  assert.equal(EXTENSIONS.m4v.sniff, true);
  assert.equal(EXTENSIONS.mkv.playable, false);
  assert.equal(EXTENSIONS.mov.playable, false);
  assert.equal(EXTENSIONS.ogv.playable, false);
  assert.equal(EXTENSIONS.weba.mime, 'audio/webm');
  assert.equal(EXTENSIONS.m4a.sniff, true);
  assert.equal(EXTENSIONS.m4b.sniff, true);
  assert.equal(EXTENSIONS.jfif.mime, 'image/jpeg');
  assert.equal(EXTENSIONS.svg.playable, false);
  for (const raw of ['dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'raf']) {
    assert.equal(EXTENSIONS[raw].playable, false, `${raw} is indexed, not playable`);
  }
});

test('resolvePlayable: unknown extension is never playable', () => {
  assert.equal(resolvePlayable({ ext: 'xyz', size: 100, codecs: null }), false);
});

test('resolvePlayable: an extension flagged not playable stays not playable', () => {
  assert.equal(resolvePlayable({ ext: 'mkv', size: 100, codecs: null }), false);
});

test('resolvePlayable: size 0 is never playable, even for an as-is extension', () => {
  assert.equal(resolvePlayable({ ext: 'webm', size: 0, codecs: null }), false);
  assert.equal(resolvePlayable({ ext: 'mp4', size: 0, codecs: null }), false);
});

test('resolvePlayable: an as-is extension with size > 0 is playable', () => {
  assert.equal(resolvePlayable({ ext: 'webm', size: 100, codecs: null }), true);
  assert.equal(resolvePlayable({ ext: 'mp3', size: 100, codecs: null }), true);
});

test('resolvePlayable: null codecs on a sniff row means playable by extension', () => {
  assert.equal(resolvePlayable({ ext: 'mp4', size: 100, codecs: null }), true);
  assert.equal(resolvePlayable({ ext: 'm4a', size: 100, codecs: null }), true);
});

test('resolvePlayable: sniffed fourcc rule accepts the allow-listed codecs', () => {
  assert.equal(
    resolvePlayable({ ext: 'mp4', size: 100, codecs: { video: ['avc1'], audio: ['mp4a'] } }),
    true,
  );
  assert.equal(
    resolvePlayable({ ext: 'mp4', size: 100, codecs: { video: ['av01'], audio: ['Opus'] } }),
    true,
  );
  assert.equal(resolvePlayable({ ext: 'm4a', size: 100, codecs: { video: [], audio: ['fLaC'] } }), true);
  assert.equal(resolvePlayable({ ext: 'm4a', size: 100, codecs: { video: [], audio: ['.mp3'] } }), true);
});

test('resolvePlayable: sniffed fourcc rule rejects any disallowed codec', () => {
  assert.equal(
    resolvePlayable({ ext: 'mp4', size: 100, codecs: { video: ['hvc1'], audio: ['mp4a'] } }),
    false,
  );
  assert.equal(
    resolvePlayable({ ext: 'mp4', size: 100, codecs: { video: ['mp4v'], audio: [] } }),
    false,
  );
  assert.equal(
    resolvePlayable({ ext: 'mp4', size: 100, codecs: { video: ['avc1'], audio: ['ac-3'] } }),
    false,
  );
  assert.equal(
    resolvePlayable({ ext: 'm4a', size: 100, codecs: { video: [], audio: ['alac'] } }),
    false,
  );
});
