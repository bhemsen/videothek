import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderChrome } from '../../public/js/lightbox.js';

const g = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
const savedDocument = g.document;
/** @type {{ activeElement: unknown }} */
let fakeDocument;

/**
 * A button stand-in whose `focus()`, like a real disabled `<button>`, is a
 * no-op while `disabled` is set.
 * @param {string} name
 */
function fakeButton(name) {
  const button = {
    name,
    disabled: false,
    focus() {
      if (!button.disabled) fakeDocument.activeElement = button;
    },
  };
  return button;
}

/** @returns {import('../../public/js/lightbox.js').LightboxDom} */
function fakeDom() {
  const text = () => ({ textContent: '' });
  return /** @type {any} */ ({
    counter: text(),
    captionName: text(),
    captionDate: text(),
    prevButton: fakeButton('prev'),
    nextButton: fakeButton('next'),
    closeButton: fakeButton('close'),
    // An open dialog that contains exactly the three buttons above.
    dialog: {
      open: true,
      /** @param {unknown} node */
      contains(node) {
        return ['prev', 'next', 'close'].includes(/** @type {any} */ (node)?.name);
      },
    },
  });
}

/** @param {number} id */
const item = (id) =>
  /** @type {any} */ ({ id, name: `b${id}.jpg`, kind: 'image', playable: true, takenAt: '2024-05-01T10:00:00Z' });

beforeEach(() => {
  fakeDocument = { activeElement: null };
  g.document = fakeDocument;
});

afterEach(() => {
  g.document = savedDocument;
});

test('renderChrome sets counter and disables prev at the first item', () => {
  const dom = fakeDom();
  renderChrome(dom, [item(1), item(2), item(3)], 0);
  assert.equal(dom.counter.textContent, '1 / 3');
  assert.equal(dom.captionName.textContent, 'b1.jpg');
  assert.equal(dom.prevButton.disabled, true);
  assert.equal(dom.nextButton.disabled, false);
});

test('focused next reaching the end moves focus to prev, even when prev was disabled before', () => {
  const dom = fakeDom();
  const sequence = [item(1), item(2)];
  renderChrome(dom, sequence, 0);
  dom.nextButton.focus();
  renderChrome(dom, sequence, 1);
  assert.equal(fakeDocument.activeElement, dom.prevButton, 'focus stays inside the dialog');
  assert.equal(dom.nextButton.disabled, true);
  assert.equal(dom.prevButton.disabled, false);
});

test('focused prev reaching the start moves focus to next, even when next was disabled before', () => {
  const dom = fakeDom();
  const sequence = [item(1), item(2)];
  renderChrome(dom, sequence, 1);
  dom.prevButton.focus();
  renderChrome(dom, sequence, 0);
  assert.equal(fakeDocument.activeElement, dom.nextButton);
  assert.equal(dom.prevButton.disabled, true);
});

test('focused nav button in a one-item sequence falls back to Schliessen', () => {
  const dom = fakeDom();
  dom.nextButton.focus();
  renderChrome(dom, [item(1)], 0);
  assert.equal(fakeDocument.activeElement, dom.closeButton);
  assert.equal(dom.prevButton.disabled, true);
  assert.equal(dom.nextButton.disabled, true);
});

test('focus elsewhere is left untouched', () => {
  const dom = fakeDom();
  dom.closeButton.focus();
  renderChrome(dom, [item(1), item(2)], 1);
  assert.equal(fakeDocument.activeElement, dom.closeButton);
});

test('focus that left the open dialog (focused video replaced by the slide) returns to Schliessen', () => {
  const dom = fakeDom();
  const sequence = [item(1), item(2), item(3)];
  renderChrome(dom, sequence, 0);
  fakeDocument.activeElement = { name: 'body' };
  renderChrome(dom, sequence, 1);
  assert.equal(fakeDocument.activeElement, dom.closeButton, 'arrow keys need focus inside the dialog');
});

test('before showModal (dialog closed) focus outside is left alone', () => {
  const dom = fakeDom();
  /** @type {any} */ (dom.dialog).open = false;
  const tile = { name: 'tile' };
  fakeDocument.activeElement = tile;
  renderChrome(dom, [item(1), item(2)], 0);
  assert.equal(fakeDocument.activeElement, tile);
});
