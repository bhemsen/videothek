import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../../public/js/audio/queue.js';

/** @typedef {import('../../public/js/audio/queue.js').QueueItem} QueueItem */

/**
 * @param {number} id @param {boolean} [playable] @param {number} [start]
 * @returns {QueueItem}
 */
function item(id, playable = true, start = 0) {
  return { id, title: `Track ${id}`, subtitle: null, groupTitle: null, coverId: null, duration: 100, playable, start };
}

test('starts at the given index among playable items', () => {
  const items = [item(1), item(2), item(3)];
  const queue = createQueue(items, { startIndex: 1 });
  assert.equal(queue.current()?.id, 2);
  assert.equal(queue.index(), 1);
});

test('a non-playable start item moves to the next playable one', () => {
  const items = [item(1), item(2, false), item(3)];
  const queue = createQueue(items, { startIndex: 1 });
  assert.equal(queue.current()?.id, 3);
});

test('wraps to the first playable item when none follow the start index', () => {
  const items = [item(1), item(2), item(3, false), item(4, false)];
  const queue = createQueue(items, { startIndex: 2 });
  assert.equal(queue.current()?.id, 1);
});

test('an all-non-playable queue has no current item', () => {
  const queue = createQueue([item(1, false), item(2, false)]);
  assert.equal(queue.current(), null);
  assert.equal(queue.advance(), null);
  assert.deepEqual(queue.back(0), { item: null, restart: true });
});

test('non-playable items are skipped entirely when walking the queue', () => {
  const items = [item(1), item(2, false), item(3), item(4, false), item(5)];
  const queue = createQueue(items);
  assert.equal(queue.current()?.id, 1);
  assert.equal(queue.advance()?.id, 3);
  assert.equal(queue.advance()?.id, 5);
  assert.equal(queue.advance(), null);
});

test('advance returns null at the end and leaves the last item current', () => {
  const queue = createQueue([item(1), item(2)]);
  assert.equal(queue.advance()?.id, 2);
  assert.equal(queue.advance(), null);
  assert.equal(queue.current()?.id, 2);
});

test('back restarts the first item regardless of elapsed time', () => {
  const queue = createQueue([item(1), item(2)]);
  assert.deepEqual(queue.back(0), { item: queue.current(), restart: true });
  assert.equal(queue.index(), 0);
});

test('back moves to the previous item at or under 3 s, restarts the current one past it', () => {
  const queue = createQueue([item(1), item(2), item(3)], { startIndex: 2 });
  const past = queue.back(3.01);
  assert.equal(past.restart, true);
  assert.equal(past.item?.id, 3);
  assert.equal(queue.index(), 2, 'restart never moves the position');

  const atBoundary = queue.back(3);
  assert.equal(atBoundary.restart, false);
  assert.equal(atBoundary.item?.id, 2);
  assert.equal(queue.index(), 1);
});

test('jump moves to the item with the given id, or leaves the queue unchanged when absent', () => {
  const queue = createQueue([item(1), item(2), item(3)]);
  assert.equal(queue.jump(3)?.id, 3);
  assert.equal(queue.index(), 2);
  assert.equal(queue.jump(999), null);
  assert.equal(queue.index(), 2, 'a failed jump does not move the position');
  assert.equal(queue.jump(2)?.id, 2);
});
