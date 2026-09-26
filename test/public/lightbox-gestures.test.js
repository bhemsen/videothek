import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySwipe, keyAction } from '../../public/js/lightbox-gestures.js';

test('classifySwipe ignores swipes below the distance threshold', () => {
  assert.equal(classifySwipe(49, 0), null);
  assert.equal(classifySwipe(-49, 0), null);
});

test('classifySwipe classifies a leftward swipe at the threshold as next', () => {
  assert.equal(classifySwipe(-50, 0), 'next');
});

test('classifySwipe classifies a rightward swipe at the threshold as prev', () => {
  assert.equal(classifySwipe(50, 0), 'prev');
});

test('classifySwipe enforces the 1.5x horizontal/vertical ratio', () => {
  assert.equal(classifySwipe(60, 40), null);
  assert.equal(classifySwipe(61, 40), 'prev');
  assert.equal(classifySwipe(-61, 40), 'next');
});

test('classifySwipe ignores a mostly-vertical drag', () => {
  assert.equal(classifySwipe(60, 60), null);
  assert.equal(classifySwipe(0, 80), null);
});

test('keyAction maps a plain ArrowLeft/ArrowRight to prev/next', () => {
  const base = { targetTag: 'BUTTON', altKey: false, ctrlKey: false, metaKey: false };
  assert.equal(keyAction({ ...base, key: 'ArrowLeft' }), 'prev');
  assert.equal(keyAction({ ...base, key: 'ArrowRight' }), 'next');
});

test('keyAction ignores keys other than the arrows', () => {
  const base = { targetTag: 'BUTTON', altKey: false, ctrlKey: false, metaKey: false };
  assert.equal(keyAction({ ...base, key: 'Escape' }), null);
  assert.equal(keyAction({ ...base, key: 'Enter' }), null);
});

test('keyAction returns null when the target is the video (native seek)', () => {
  assert.equal(
    keyAction({ key: 'ArrowLeft', targetTag: 'VIDEO', altKey: false, ctrlKey: false, metaKey: false }),
    null,
  );
  assert.equal(
    keyAction({ key: 'ArrowRight', targetTag: 'VIDEO', altKey: false, ctrlKey: false, metaKey: false }),
    null,
  );
});

test('keyAction returns null when any modifier key is held', () => {
  const base = { key: 'ArrowLeft', targetTag: 'BUTTON' };
  assert.equal(keyAction({ ...base, altKey: true, ctrlKey: false, metaKey: false }), null);
  assert.equal(keyAction({ ...base, altKey: false, ctrlKey: true, metaKey: false }), null);
  assert.equal(keyAction({ ...base, altKey: false, ctrlKey: false, metaKey: true }), null);
});
