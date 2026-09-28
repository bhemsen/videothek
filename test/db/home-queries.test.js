// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertUser } from '../../src/db/users.js';
import { makeDb } from '../helpers/audio-meta-seed.js';
import { seedAudio, seedEpisode, seedImage, seedMovie, seedProgress } from '../helpers/home-seed.js';
import {
  countHomeCategories,
  listRecentAudioGroupKeys,
  listRecentImageFolders,
  listRecentMovies,
  listRecentSeries,
  listStartedBookGroupKeys,
} from '../../src/db/home-queries.js';

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} username
 * @returns {number}
 */
function makeUser(db, username) {
  return insertUser(db, { username, passwordHash: 'x', role: 'user', createdAt: 1 }).id;
}

test('listStartedBookGroupKeys: only counted rows (finished, or at/above the threshold) count', () => {
  const db = makeDb();
  try {
    const userId = makeUser(db, 'alice');
    seedAudio(db, {
      category: 'audiobooks', relPath: 'Hörbücher/Below/01.mp3', groupKey: 'Hörbücher/Below',
      groupTitle: 'Below', title: 'Teil 1', addedAt: 1,
    });
    seedProgress(db, { userId, relPath: 'Hörbücher/Below/01.mp3', position: 20, duration: 180, updatedAt: 1 });

    seedAudio(db, {
      category: 'audiobooks', relPath: 'Hörbücher/Started/01.mp3', groupKey: 'Hörbücher/Started',
      groupTitle: 'Started', title: 'Teil 1', addedAt: 1,
    });
    seedProgress(db, { userId, relPath: 'Hörbücher/Started/01.mp3', position: 40, duration: 180, updatedAt: 1 });

    seedAudio(db, {
      category: 'audiobooks', relPath: 'Hörbücher/Finished/01.mp3', groupKey: 'Hörbücher/Finished',
      groupTitle: 'Finished', title: 'Teil 1', addedAt: 1,
    });
    seedProgress(db, {
      userId, relPath: 'Hörbücher/Finished/01.mp3', position: 180, duration: 180, finished: true, updatedAt: 1,
    });

    assert.deepEqual(
      listStartedBookGroupKeys(db, { userId, startThreshold: 30 }).sort(),
      ['Hörbücher/Finished', 'Hörbücher/Started']
    );
  } finally {
    db.close();
  }
});

test('listStartedBookGroupKeys: only audiobooks, only the given user, distinct keys', () => {
  const db = makeDb();
  try {
    const alice = makeUser(db, 'alice');
    const bob = makeUser(db, 'bob');

    seedAudio(db, {
      category: 'music', relPath: 'Musik/A/01.mp3', groupKey: 'Musik/A', groupTitle: 'A', title: 'Titel', addedAt: 1,
    });
    seedProgress(db, { userId: alice, relPath: 'Musik/A/01.mp3', position: 40, duration: 180, updatedAt: 1 });

    seedAudio(db, {
      category: 'audiobooks', relPath: 'Hörbücher/Buch/01.mp3', groupKey: 'Hörbücher/Buch',
      groupTitle: 'Buch', title: 'Teil 1', addedAt: 1,
    });
    seedAudio(db, {
      category: 'audiobooks', relPath: 'Hörbücher/Buch/02.mp3', groupKey: 'Hörbücher/Buch',
      groupTitle: 'Buch', title: 'Teil 2', trackNo: 2, addedAt: 1,
    });
    seedProgress(db, { userId: alice, relPath: 'Hörbücher/Buch/01.mp3', position: 40, duration: 180, updatedAt: 1 });
    seedProgress(db, { userId: alice, relPath: 'Hörbücher/Buch/02.mp3', position: 40, duration: 180, updatedAt: 2 });
    seedProgress(db, { userId: bob, relPath: 'Hörbücher/Buch/01.mp3', position: 40, duration: 180, updatedAt: 3 });

    // Only audiobooks: the music row never surfaces. Distinct keys: the book's
    // two counted rows still yield its group key once.
    assert.deepEqual(listStartedBookGroupKeys(db, { userId: alice, startThreshold: 30 }), ['Hörbücher/Buch']);
    // Per-user: Bob has his own counted row on the same book.
    assert.deepEqual(listStartedBookGroupKeys(db, { userId: bob, startThreshold: 30 }), ['Hörbücher/Buch']);
  } finally {
    db.close();
  }
});

test('listStartedBookGroupKeys: the threshold is a bound parameter, never a literal 30', () => {
  const db = makeDb();
  try {
    const userId = makeUser(db, 'alice');
    seedAudio(db, {
      category: 'audiobooks', relPath: 'Hörbücher/Buch/01.mp3', groupKey: 'Hörbücher/Buch',
      groupTitle: 'Buch', title: 'Teil 1', addedAt: 1,
    });
    seedProgress(db, { userId, relPath: 'Hörbücher/Buch/01.mp3', position: 40, duration: 180, updatedAt: 1 });

    assert.deepEqual(listStartedBookGroupKeys(db, { userId, startThreshold: 30 }), ['Hörbücher/Buch']);
    // At threshold 50 the same 40 s row no longer counts.
    assert.deepEqual(listStartedBookGroupKeys(db, { userId, startThreshold: 50 }), []);
  } finally {
    db.close();
  }
});

test('countHomeCategories: non-playable movies count, series are distinct, meta-less items excluded, a grouped album counts once, images = image_meta rows', () => {
  const db = makeDb();
  try {
    seedMovie(db, { relPath: 'Filme/A.mp4', title: 'A', addedAt: 1, playable: false });
    seedMovie(db, { relPath: 'Filme/B.mp4', title: 'B', addedAt: 1 });

    seedEpisode(db, { seriesKey: 'S', seriesTitle: 'S', relPath: 'Serien/S/S1E1.mp4', addedAt: 1 });
    seedEpisode(db, { seriesKey: 'S', seriesTitle: 'S', relPath: 'Serien/S/S1E2.mp4', addedAt: 1, episode: 2 });

    seedAudio(db, {
      category: 'music', relPath: 'Musik/NoMeta.mp3', groupKey: 'Musik/NoMeta', groupTitle: null,
      title: 'X', addedAt: 1, withMeta: false,
    });
    seedAudio(db, {
      category: 'music', relPath: 'Musik/A/Album/01.mp3', groupKey: 'Musik/A/Album',
      groupTitle: 'Album', groupArtist: 'A', title: 'Eins', trackNo: 1, addedAt: 1,
    });
    seedAudio(db, {
      category: 'music', relPath: 'Musik/A/Album/02.mp3', groupKey: 'Musik/A/Album',
      groupTitle: 'Album', groupArtist: 'A', title: 'Zwei', trackNo: 2, addedAt: 1,
    });

    seedImage(db, { relPath: 'Bilder/A/x.jpg', folder: 'A', addedAt: 1 });
    seedImage(db, { relPath: 'Bilder/A/y.jpg', folder: 'A', addedAt: 1 });

    assert.deepEqual(countHomeCategories(db), { movies: 2, series: 1, music: 1, audiobooks: 0, images: 2 });
  } finally {
    db.close();
  }
});

test('listRecentMovies: added_at desc, mtime_ms desc, id asc tie-breaks, limit, other categories excluded', () => {
  const db = makeDb();
  try {
    const older = seedMovie(db, { relPath: 'Filme/Old.mp4', title: 'Old', addedAt: 1, mtimeMs: 100 });
    const newer = seedMovie(db, { relPath: 'Filme/New.mp4', title: 'New', addedAt: 2, mtimeMs: 100 });
    const tieA = seedMovie(db, { relPath: 'Filme/TieA.mp4', title: 'TieA', addedAt: 2, mtimeMs: 200 });
    const tieB = seedMovie(db, { relPath: 'Filme/TieB.mp4', title: 'TieB', addedAt: 2, mtimeMs: 200 });
    seedEpisode(db, { seriesKey: 'S', seriesTitle: 'S', relPath: 'Serien/S/S1E1.mp4', addedAt: 5 });

    const rows = listRecentMovies(db, 10);
    assert.deepEqual(rows.map((row) => row.id), [tieA, tieB, newer, older]);
    assert.ok(rows.every((row) => row.category === 'movies'));
    assert.equal(listRecentMovies(db, 1).length, 1);
  } finally {
    db.close();
  }
});

test('listRecentSeries: MAX(added_at) desc, ls.id desc tie-break (same as /series?sort=added), limit', () => {
  const db = makeDb();
  try {
    seedEpisode(db, { seriesKey: 'Old', seriesTitle: 'Old', relPath: 'Serien/Old/S1E1.mp4', addedAt: 1 });
    seedEpisode(db, { seriesKey: 'New', seriesTitle: 'New', relPath: 'Serien/New/S1E1.mp4', addedAt: 2 });
    // Same addedAt as "New" but created after it -> the higher library_series id wins the tie.
    seedEpisode(db, { seriesKey: 'TieA', seriesTitle: 'TieA', relPath: 'Serien/TieA/S1E1.mp4', addedAt: 2 });

    assert.deepEqual(listRecentSeries(db, 10).map((row) => row.title), ['TieA', 'New', 'Old']);
    assert.equal(listRecentSeries(db, 1).length, 1);
  } finally {
    db.close();
  }
});

test('listRecentAudioGroupKeys: newest group first by MAX(added_at), then MAX(mtime_ms), then group_key', () => {
  const db = makeDb();
  try {
    seedAudio(db, {
      category: 'music', relPath: 'Musik/Old/Album/01.mp3', groupKey: 'Musik/Old/Album',
      groupTitle: 'Album', groupArtist: 'Old', title: 'Titel', addedAt: 1, mtimeMs: 100,
    });
    // Same added_at as the ties below, but a lower mtime_ms and a key that sorts before both
    // — this is the only pair that can catch the MAX(mtime_ms) tie-break level being dropped
    // or its direction flipped (TieA/TieB alone would still sort correctly either way).
    seedAudio(db, {
      category: 'music', relPath: 'Musik/Mid/Album/01.mp3', groupKey: 'Musik/Mid/Album',
      groupTitle: 'Album', groupArtist: 'Mid', title: 'Titel', addedAt: 2, mtimeMs: 150,
    });
    seedAudio(db, {
      category: 'music', relPath: 'Musik/TieB/Album/01.mp3', groupKey: 'Musik/TieB/Album',
      groupTitle: 'Album', groupArtist: 'TieB', title: 'Titel', addedAt: 2, mtimeMs: 200,
    });
    seedAudio(db, {
      category: 'music', relPath: 'Musik/TieA/Album/01.mp3', groupKey: 'Musik/TieA/Album',
      groupTitle: 'Album', groupArtist: 'TieA', title: 'Titel', addedAt: 2, mtimeMs: 200,
    });

    assert.deepEqual(
      listRecentAudioGroupKeys(db, 'music', 10),
      ['Musik/TieA/Album', 'Musik/TieB/Album', 'Musik/Mid/Album', 'Musik/Old/Album']
    );
  } finally {
    db.close();
  }
});

test('listRecentAudioGroupKeys: category filter holds, meta-less items excluded, limit honoured', () => {
  const db = makeDb();
  try {
    seedAudio(db, {
      category: 'music', relPath: 'Musik/NoMeta.mp3', groupKey: 'Musik/NoMeta', groupTitle: null,
      title: 'X', addedAt: 1, withMeta: false,
    });
    seedAudio(db, {
      category: 'music', relPath: 'Musik/Old/Album/01.mp3', groupKey: 'Musik/Old/Album',
      groupTitle: 'Album', groupArtist: 'Old', title: 'Titel', addedAt: 1,
    });
    seedAudio(db, {
      category: 'music', relPath: 'Musik/New/Album/01.mp3', groupKey: 'Musik/New/Album',
      groupTitle: 'Album', groupArtist: 'New', title: 'Titel', addedAt: 2,
    });
    seedAudio(db, {
      category: 'audiobooks', relPath: 'Hörbücher/Buch/01.mp3', groupKey: 'Hörbücher/Buch',
      groupTitle: 'Buch', groupArtist: 'Autor', title: 'Teil 1', addedAt: 3,
    });

    assert.deepEqual(listRecentAudioGroupKeys(db, 'music', 10), ['Musik/New/Album', 'Musik/Old/Album']);
    assert.deepEqual(listRecentAudioGroupKeys(db, 'music', 1), ['Musik/New/Album']);
    assert.deepEqual(listRecentAudioGroupKeys(db, 'audiobooks', 10), ['Hörbücher/Buch']);
  } finally {
    db.close();
  }
});

test('listRecentImageFolders: top-level aggregation of a subtree, root excluded, limit', () => {
  const db = makeDb();
  try {
    seedImage(db, { relPath: 'Bilder/A/x.jpg', folder: 'A', addedAt: 1, mtimeMs: 100 });
    seedImage(db, { relPath: 'Bilder/A/B/y.jpg', folder: 'A/B', addedAt: 2, mtimeMs: 100 });
    seedImage(db, { relPath: 'Bilder/C/z.jpg', folder: 'C', addedAt: 3, mtimeMs: 300 });
    seedImage(db, { relPath: 'Bilder/r.jpg', folder: '', addedAt: 4 });

    assert.deepEqual(listRecentImageFolders(db, 10), [
      { folderKey: 'C', count: 1 },
      { folderKey: 'A', count: 2 },
    ]);
    assert.equal(listRecentImageFolders(db, 1).length, 1);
  } finally {
    db.close();
  }
});

test('listRecentImageFolders: MAX(added_at) ties break on MAX(mtime_ms), then on the folder key', () => {
  const db = makeDb();
  try {
    seedImage(db, { relPath: 'Bilder/Low/x.jpg', folder: 'Low', addedAt: 1, mtimeMs: 100 });
    seedImage(db, { relPath: 'Bilder/TieB/x.jpg', folder: 'TieB', addedAt: 1, mtimeMs: 200 });
    seedImage(db, { relPath: 'Bilder/TieA/x.jpg', folder: 'TieA', addedAt: 1, mtimeMs: 200 });

    assert.deepEqual(
      listRecentImageFolders(db, 10).map((folder) => folder.folderKey),
      ['TieA', 'TieB', 'Low']
    );
  } finally {
    db.close();
  }
});
