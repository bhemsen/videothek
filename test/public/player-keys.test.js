import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyAction } from '../../public/js/lib/player-keys.js';

/** @returns {import('../../public/js/lib/player-keys.js').PlayerKeyEvent} */
function baseEvent(overrides = {}) {
  return {
    key: ' ',
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    tagName: 'DIV',
    isContentEditable: false,
    ...overrides,
  };
}

test('maps each shortcut key to its action, including upper case', () => {
  const cases = [
    [' ', 'toggle'],
    ['k', 'toggle'],
    ['K', 'toggle'],
    ['ArrowLeft', 'back'],
    ['ArrowRight', 'forward'],
    ['f', 'fullscreen'],
    ['F', 'fullscreen'],
    ['m', 'mute'],
    ['M', 'mute'],
  ];
  for (const [key, expected] of cases) {
    assert.equal(keyAction(baseEvent({ key })), expected, `key ${JSON.stringify(key)}`);
  }
});

test('returns null for an unmapped key', () => {
  for (const key of ['Escape', 'Enter', 'Tab', 'a', 'ArrowUp', 'ArrowDown', '']) {
    assert.equal(keyAction(baseEvent({ key })), null, `key ${JSON.stringify(key)}`);
  }
});

test('returns null when a modifier key is held', () => {
  assert.equal(keyAction(baseEvent({ key: ' ', ctrlKey: true })), null);
  assert.equal(keyAction(baseEvent({ key: 'k', altKey: true })), null);
  assert.equal(keyAction(baseEvent({ key: 'f', metaKey: true })), null);
  assert.equal(keyAction(baseEvent({ key: 'ArrowLeft', ctrlKey: true, altKey: true, metaKey: true })), null);
});

test('returns null for content-editable targets', () => {
  assert.equal(keyAction(baseEvent({ key: ' ', isContentEditable: true })), null);
  assert.equal(keyAction(baseEvent({ key: 'm', tagName: 'DIV', isContentEditable: true })), null);
});

test('returns null for ignored target tags', () => {
  for (const tagName of ['VIDEO', 'BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']) {
    assert.equal(keyAction(baseEvent({ key: ' ', tagName })), null, `tagName ${tagName}`);
    assert.equal(keyAction(baseEvent({ key: 'ArrowRight', tagName })), null, `tagName ${tagName}`);
  }
});

test('acts normally on a non-ignored target tag', () => {
  for (const tagName of ['DIV', 'BODY', 'MAIN', 'SPAN', 'H1']) {
    assert.equal(keyAction(baseEvent({ key: ' ', tagName })), 'toggle', `tagName ${tagName}`);
  }
});
