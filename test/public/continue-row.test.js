import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardMeta, guardRemoval, nextFocusIndex } from '../../public/js/lib/continue-row.js';

test('cardMeta: a movie shows only the remaining time', () => {
  assert.equal(
    cardMeta({
      itemId: 1,
      position: 1080,
      duration: 7800,
      state: 'in_progress',
      updatedAt: null,
      item: { seriesId: null, seriesTitle: null, title: 'Der Name der Rose', season: null, episode: null },
    }),
    'Noch 1 Std. 52 Min.',
  );
});

test('cardMeta: an episode prefixes its season/episode before the remaining time', () => {
  assert.equal(
    cardMeta({
      itemId: 2,
      position: 560,
      duration: 2000,
      state: 'in_progress',
      updatedAt: null,
      item: { seriesId: 5, seriesTitle: 'Dark', title: 'S01E03', season: 1, episode: 3 },
    }),
    'S1 · F3 · Noch 24 Min.',
  );
});

test('cardMeta: season 0 is labelled "Special"', () => {
  assert.equal(
    cardMeta({
      itemId: 3,
      position: 560,
      duration: 2000,
      state: 'in_progress',
      updatedAt: null,
      item: { seriesId: 5, seriesTitle: 'Dark', title: 'Special 3', season: 0, episode: 3 },
    }),
    'Special · F3 · Noch 24 Min.',
  );
});

test('cardMeta: an unnumbered episode omits the season/episode part', () => {
  assert.equal(
    cardMeta({
      itemId: 4,
      position: 560,
      duration: 2000,
      state: 'in_progress',
      updatedAt: null,
      item: { seriesId: 5, seriesTitle: 'Dark', title: 'Bonus', season: null, episode: null },
    }),
    'Noch 24 Min.',
  );
});

test('cardMeta: a next_up card shows only the season/episode part, never the remaining time', () => {
  assert.equal(
    cardMeta({
      itemId: 5,
      position: 0,
      duration: null,
      state: 'next_up',
      updatedAt: null,
      item: { seriesId: 5, seriesTitle: 'Babylon Berlin', title: 'S02E05', season: 2, episode: 5 },
    }),
    'S2 · F5',
  );
});

test('nextFocusIndex: removing the first of several cards focuses the next one', () => {
  assert.equal(nextFocusIndex(4, 0), 0);
});

test('nextFocusIndex: removing a middle card focuses the next one', () => {
  assert.equal(nextFocusIndex(4, 1), 1);
});

test('nextFocusIndex: removing the last card focuses the previous one', () => {
  assert.equal(nextFocusIndex(4, 3), 2);
});

test('nextFocusIndex: removing the only card leaves no focus target', () => {
  assert.equal(nextFocusIndex(1, 0), -1);
});

/**
 * A guarded removal whose `remove` resolves/rejects only when the test says
 * so, recording every hook call in order.
 * @returns {{ run: () => Promise<void>, calls: string[], settle: (ok: boolean) => void, removeCount: () => number }}
 */
function makeGuarded() {
  /** @type {string[]} */
  const calls = [];
  let removeCount = 0;
  /** @type {((ok: boolean) => void)[]} */
  const pending = [];
  const run = guardRemoval(
    () => {
      removeCount += 1;
      return new Promise((resolve, reject) => pending.push((ok) => (ok ? resolve() : reject(new Error('x')))));
    },
    {
      setPending: (p) => calls.push(`pending:${p}`),
      onSuccess: () => calls.push('success'),
      onFailure: () => calls.push('failure'),
    },
  );
  return { run, calls, settle: (ok) => /** @type {(ok: boolean) => void} */ (pending.shift())(ok), removeCount: () => removeCount };
}

test('guardRemoval: a second activation while the request is pending is ignored', async () => {
  const g = makeGuarded();
  const first = g.run();
  const second = g.run();
  g.settle(true);
  await Promise.all([first, second]);
  assert.equal(g.removeCount(), 1);
  assert.deepEqual(g.calls, ['pending:true', 'success']);
});

test('guardRemoval: an activation after a successful removal is ignored', async () => {
  const g = makeGuarded();
  const first = g.run();
  g.settle(true);
  await first;
  await g.run();
  assert.equal(g.removeCount(), 1);
  assert.deepEqual(g.calls, ['pending:true', 'success']);
});

test('guardRemoval: a failure re-arms the handler so a retry can succeed', async () => {
  const g = makeGuarded();
  const first = g.run();
  g.settle(false);
  await first;
  const retry = g.run();
  g.settle(true);
  await retry;
  assert.equal(g.removeCount(), 2);
  assert.deepEqual(g.calls, ['pending:true', 'pending:false', 'failure', 'pending:true', 'success']);
});
