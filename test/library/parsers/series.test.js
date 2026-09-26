import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEpisode } from '../../../src/library/parsers/series.js';

const NOW_2026 = () => Date.UTC(2026, 8, 26);

test('SxxEyy with an episode title suffix', () => {
  const result = parseEpisode('Dark (2017)/Staffel 1/Dark S01E01 - Geheimnisse.mp4', NOW_2026);
  assert.deepEqual(result, {
    seriesKey: 'Dark (2017)',
    seriesTitle: 'Dark',
    seriesYear: 2017,
    season: 1,
    episode: 1,
    episodeEnd: null,
    title: 'Geheimnisse'
  });
});

test('multi-episode file, "-E" form', () => {
  const result = parseEpisode('Dark (2017)/Staffel 1/Dark S01E01-E02 - Doppelfolge.mp4', NOW_2026);
  assert.equal(result.season, 1);
  assert.equal(result.episode, 1);
  assert.equal(result.episodeEnd, 2);
  assert.equal(result.title, 'Doppelfolge');
});

test('multi-episode file, bare hyphen form', () => {
  const result = parseEpisode('Dark (2017)/Staffel 1/Dark S01E01-02.mp4', NOW_2026);
  assert.equal(result.episode, 1);
  assert.equal(result.episodeEnd, 2);
});

test('"1x02" scene form; loose scene name -> episode code fallback title', () => {
  const result = parseEpisode('Stromberg/Season 01/Stromberg - 1x02.avi', NOW_2026);
  assert.deepEqual(result, {
    seriesKey: 'Stromberg',
    seriesTitle: 'Stromberg',
    seriesYear: null,
    season: 1,
    episode: 2,
    episodeEnd: null,
    title: 'S01E02'
  });
});

test('"1920x1080" is not read as a season/episode pair', () => {
  const result = parseEpisode('Show/Show 1920x1080.mp4', NOW_2026);
  assert.equal(result.season, null);
  assert.equal(result.episode, null);
});

test('unnumbered episode falls back to the cleaned stem as title', () => {
  const result = parseEpisode('Dark (2017)/Extras/Interview.mp4', NOW_2026);
  assert.deepEqual(result, {
    seriesKey: 'Dark (2017)',
    seriesTitle: 'Dark',
    seriesYear: 2017,
    season: null,
    episode: null,
    episodeEnd: null,
    title: 'Interview'
  });
});

test('season folder + "Folge N" word, with an episode title suffix', () => {
  const result = parseEpisode('MyShow/Staffel 2/MyShow Folge 3 - Der Anfang.mp4', NOW_2026);
  assert.equal(result.season, 2);
  assert.equal(result.episode, 3);
  assert.equal(result.title, 'Der Anfang');
});

test('season folder + leading number', () => {
  const result = parseEpisode('MyShow/Staffel 2/03 - Der Anfang.mp4', NOW_2026);
  assert.equal(result.season, 2);
  assert.equal(result.episode, 3);
  assert.equal(result.title, 'Der Anfang');
});

test('Specials folder maps to season 0', () => {
  const result = parseEpisode('Dark (2017)/Specials/Folge 1 - Making-of.mp4', NOW_2026);
  assert.equal(result.season, 0);
  assert.equal(result.episode, 1);
  assert.equal(result.title, 'Making-of');
});

test('a season folder alone (no episode token) keeps the season, episode unknown', () => {
  const result = parseEpisode('MyShow/Staffel 4/random-file.mp4', NOW_2026);
  assert.equal(result.season, 4);
  assert.equal(result.episode, null);
});

test('loose root file: series key/title derived from the text before the token, year null', () => {
  const result = parseEpisode('Babylon.Berlin.S01E01.mp4', NOW_2026);
  assert.deepEqual(result, {
    seriesKey: 'Babylon Berlin',
    seriesTitle: 'Babylon Berlin',
    seriesYear: null,
    season: 1,
    episode: 1,
    episodeEnd: null,
    title: 'S01E01'
  });
});

test('loose root file with no season/episode token at all', () => {
  const result = parseEpisode('Just A File.mp4', NOW_2026);
  assert.deepEqual(result, {
    seriesKey: 'Just A File',
    seriesTitle: 'Just A File',
    seriesYear: null,
    season: null,
    episode: null,
    episodeEnd: null,
    title: 'Just A File'
  });
});

test('episode title is never empty', () => {
  const result = parseEpisode('Dark (2017)/Staffel 1/Dark S01E09.mp4', NOW_2026);
  assert.notEqual(result.title, '');
  assert.equal(result.title, 'S01E09');
});

test('series folder name with a dot after an abbreviation is not read as an extension', () => {
  const result = parseEpisode('Mr. Robot/Season 1/Mr. Robot S01E01.mkv', NOW_2026);
  assert.deepEqual(result, {
    seriesKey: 'Mr. Robot',
    seriesTitle: 'Mr. Robot',
    seriesYear: null,
    season: 1,
    episode: 1,
    episodeEnd: null,
    title: 'S01E01'
  });
});

test('series folder name with a dotted title and a year keeps both title and year', () => {
  const result = parseEpisode('Dr. House (2004)/Staffel 1/S01E01.mp4', NOW_2026);
  assert.equal(result.seriesKey, 'Dr. House (2004)');
  assert.equal(result.seriesTitle, 'Dr. House');
  assert.equal(result.seriesYear, 2004);
  assert.equal(result.season, 1);
  assert.equal(result.episode, 1);
});

test('episode word without a season folder: season null, episode from the word', () => {
  const result = parseEpisode('MyShow/Folge 3 - Der Anfang.mp4', NOW_2026);
  assert.equal(result.season, null);
  assert.equal(result.episode, 3);
  assert.equal(result.title, 'Der Anfang');
});
