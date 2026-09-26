import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAudioUrl, audioUrl } from '../../public/js/audio/routes.js';

test('parses the section overview URLs', () => {
  assert.deepEqual(parseAudioUrl('/music', ''), { section: 'music', view: 'overview', id: null });
  assert.deepEqual(parseAudioUrl('/audiobooks', ''), { section: 'audiobooks', view: 'grid', id: null });
});

test('parses an album/book id from the query string', () => {
  assert.deepEqual(parseAudioUrl('/music', '?album=42'), { section: 'music', view: 'album', id: 42 });
  assert.deepEqual(parseAudioUrl('/audiobooks', '?book=7'), { section: 'audiobooks', view: 'book', id: 7 });
});

test('an invalid or malformed id falls back to the section overview/grid', () => {
  const invalid = ['0', '-1', '1.5', 'abc', '01', '99999999999999999'];
  for (const raw of invalid) {
    assert.deepEqual(parseAudioUrl('/music', `?album=${raw}`), { section: 'music', view: 'overview', id: null }, raw);
    assert.deepEqual(parseAudioUrl('/audiobooks', `?book=${raw}`), { section: 'audiobooks', view: 'grid', id: null }, raw);
  }
});

test('an unrelated query parameter is ignored', () => {
  assert.deepEqual(parseAudioUrl('/music', '?sort=title'), { section: 'music', view: 'overview', id: null });
});

test('audioUrl round-trips every parseAudioUrl result back to its canonical URL', () => {
  const cases = [
    ['/music', ''],
    ['/music', '?album=42'],
    ['/audiobooks', ''],
    ['/audiobooks', '?book=7'],
  ];
  for (const [pathname, search] of cases) {
    const route = parseAudioUrl(pathname, search);
    assert.equal(audioUrl(route), pathname + search);
  }
});

test('audioUrl collapses an invalid id to the plain section URL', () => {
  const route = parseAudioUrl('/music', '?album=not-a-number');
  assert.equal(audioUrl(route), '/music');
});

test('audioUrl ignores a mismatched view/id pairing (defensive)', () => {
  assert.equal(audioUrl({ section: 'music', view: 'overview', id: 5 }), '/music');
  assert.equal(audioUrl({ section: 'audiobooks', view: 'grid', id: 5 }), '/audiobooks');
});
