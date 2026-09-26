import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanName, sortKey, parseYear, episodeCode } from '../../../src/library/parsers/text.js';

const NOW_2026 = () => Date.UTC(2026, 8, 26);

test('cleanName: scene-release name is cut at the first release token', () => {
  assert.equal(cleanName('Blade.Runner.2049.2017.1080p.BluRay.x264'), 'Blade Runner 2049 2017');
});

test('cleanName: underscore always becomes a space, dot only without a space', () => {
  assert.equal(cleanName('Dark_S01E05'), 'Dark S01E05');
});

test('cleanName: dots are preserved when the name already contains a space', () => {
  assert.equal(cleanName('Mr. Robot Special'), 'Mr. Robot Special');
});

test('cleanName: bracketed groups are removed', () => {
  assert.equal(cleanName("Movie [Director's Cut] 2016"), 'Movie 2016');
});

test('cleanName: trailing separators are trimmed', () => {
  assert.equal(cleanName('Interview -'), 'Interview');
  assert.equal(cleanName('Interview._'), 'Interview');
});

test('cleanName: whitespace runs collapse', () => {
  assert.equal(cleanName('Making   of'), 'Making of');
});

test('cleanName: a name that cuts to empty falls back to despeparatorised text', () => {
  assert.equal(cleanName('1080p'), '1080p');
});

test('cleanName: a name of only separators falls back to itself unchanged', () => {
  assert.equal(cleanName('.'), '.');
});

test('cleanName: empty input stays empty', () => {
  assert.equal(cleanName(''), '');
});

test('sortKey: digit runs are left-padded for natural order', () => {
  assert.ok(sortKey('Teil 2') < sortKey('Teil 10'));
});

test('sortKey: accents are stripped and case is folded', () => {
  assert.equal(sortKey('Über'), sortKey('Uber'));
  assert.equal(sortKey('ÜBER'), 'uber');
});

test('sortKey: no article stripping', () => {
  assert.ok(sortKey('Das Boot').startsWith('das'));
  assert.ok(sortKey('The Office').startsWith('the'));
});

const YEAR_CASES = [
  { token: '2016', expected: 2016 },
  { token: '1888', expected: 1888 },
  { token: '1887', expected: null },
  { token: '2027', expected: 2027 },
  { token: '2028', expected: null },
  { token: 'abcd', expected: null },
  { token: '12345', expected: null },
  { token: '203', expected: null }
];

for (const { token, expected } of YEAR_CASES) {
  test(`parseYear(${JSON.stringify(token)}) -> ${expected}`, () => {
    assert.equal(parseYear(token, NOW_2026), expected);
  });
}

test('episodeCode: season and episode known', () => {
  assert.equal(episodeCode({ season: 1, episode: 6, episodeEnd: null }), 'S01E06');
});

test('episodeCode: multi-episode range with season', () => {
  assert.equal(episodeCode({ season: 1, episode: 1, episodeEnd: 2 }), 'S01E01-E02');
});

test('episodeCode: season unknown', () => {
  assert.equal(episodeCode({ season: null, episode: 6, episodeEnd: null }), 'E06');
});

test('episodeCode: multi-episode range, season unknown', () => {
  assert.equal(episodeCode({ season: null, episode: 6, episodeEnd: 7 }), 'E06-E07');
});

test('episodeCode: episode unknown -> null', () => {
  assert.equal(episodeCode({ season: 1, episode: null, episodeEnd: null }), null);
  assert.equal(episodeCode({ season: undefined, episode: undefined, episodeEnd: undefined }), null);
});

test('episodeCode: two-digit minimum, no truncation above it', () => {
  assert.equal(episodeCode({ season: 9, episode: 1, episodeEnd: null }), 'S09E01');
  assert.equal(episodeCode({ season: undefined, episode: 130, episodeEnd: null }), 'E130');
});
