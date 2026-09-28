// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertUser } from '../../src/db/users.js';
import { makeDb } from '../helpers/audio-meta-seed.js';
import { seedAudio, seedProgress } from '../helpers/home-seed.js';
import { listStartedBookGroupKeys } from '../../src/db/home-queries.js';

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
