import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMovie } from '../../../src/library/parsers/movie.js';

const NOW_2026 = () => Date.UTC(2026, 8, 26);

const CASES = [
  { description: 'parenthesised year', rel: 'Arrival (2016).mp4', title: 'Arrival', year: 2016 },
  { description: 'bracketed year', rel: 'Arrival [2016].mp4', title: 'Arrival', year: 2016 },
  {
    description: 'scene-release name (Blade Runner 2049 (2017))',
    rel: 'Blade.Runner.2049.2017.1080p.BluRay.x264.mp4',
    title: 'Blade Runner 2049',
    year: 2017
  },
  {
    description: 'title starting with a year-like token',
    rel: '2001 A Space Odyssey 1968 1080p.mp4',
    title: '2001 A Space Odyssey',
    year: 1968
  },
  { description: 'no year anywhere', rel: 'Metropolis.mp4', title: 'Metropolis', year: null },
  {
    description: 'folder fallback',
    rel: 'Inception (2010)/inception.mp4',
    title: 'Inception',
    year: 2010
  },
  {
    description: 'nearest matching ancestor folder wins',
    rel: 'Inception (2010)/BluRay/inception.mkv',
    title: 'Inception',
    year: 2010
  },
  {
    description: 'year above now+1 rejected in parens -> no year',
    rel: 'Movie (2099).mp4',
    title: 'Movie (2099)',
    year: null
  },
  {
    description: 'year above now+1 rejected as a token -> stays part of the title',
    rel: 'Future.Movie.2099.1080p.x264.mp4',
    title: 'Future Movie 2099',
    year: null
  }
];

for (const { description, rel, title, year } of CASES) {
  test(`parseMovie: ${description}`, () => {
    assert.deepEqual(parseMovie(rel, NOW_2026), { title, year });
  });
}

test('parseMovie: title is never empty even for a name of only release tags', () => {
  const result = parseMovie('1080p.x264.mkv', NOW_2026);
  assert.notEqual(result.title, '');
});
