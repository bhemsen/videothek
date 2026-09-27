import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { coverImg } from '../../public/js/audio/cover-img.js';

/**
 * Minimal fake DOM element builder: just enough of `Element` (attributes,
 * `append`/`remove`, `dataset`) plus `EventTarget` for `coverImg`'s `el()`-
 * and `icon()`-built tree, with no real `document` (this project has no
 * jsdom dependency).
 */
class FakeNode extends EventTarget {
  /** @param {string} tagName */
  constructor(tagName) {
    super();
    this.tagName = tagName;
    /** @type {Map<string, string>} */
    this.attrs = new Map();
    /** @type {(FakeNode | { text: string })[]} */
    this.children = [];
    /** @type {FakeNode | null} */
    this.parent = null;
    this.dataset = {};
  }

  /** @param {string} name @param {unknown} value @returns {void} */
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }

  /** @param {string} name @returns {string | null} */
  getAttribute(name) {
    return this.attrs.has(name) ? /** @type {string} */ (this.attrs.get(name)) : null;
  }

  /** @param {FakeNode | string} node @returns {void} */
  append(node) {
    if (typeof node === 'string') {
      this.children.push({ text: node });
      return;
    }
    node.parent = this;
    this.children.push(node);
  }

  /** @returns {void} */
  remove() {
    if (this.parent === null) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}

/** Installs a fake `document` covering `el()`/`icon()`'s DOM surface. @returns {void} */
function installFakeDocument() {
  /** @type {{ document?: unknown }} */ (globalThis).document = {
    createElement: (/** @type {string} */ tag) => new FakeNode(tag),
    createElementNS: (/** @type {string} */ _ns, /** @type {string} */ tag) => new FakeNode(tag),
    createTextNode: (/** @type {string} */ text) => ({ text }),
  };
}

/** @type {unknown} */
let savedDocument;

beforeEach(() => {
  savedDocument = /** @type {{ document?: unknown }} */ (globalThis).document;
  installFakeDocument();
});

afterEach(() => {
  /** @type {{ document?: unknown }} */ (globalThis).document = savedDocument;
});

/**
 * Flattens a fake element tree (depth-first, including `node` itself).
 * @param {FakeNode} node
 * @returns {FakeNode[]}
 */
function flatten(node) {
  const out = [node];
  for (const child of node.children) {
    if (child instanceof FakeNode) out.push(...flatten(child));
  }
  return out;
}

/** @param {FakeNode[]} nodes @returns {boolean} */
function hasPlaceholder(nodes) {
  return nodes.some((n) => n.attrs.get('class') === 'cover-img__placeholder');
}

test('coverId null shows the placeholder glyph immediately, no <img> at all', () => {
  const wrapper = /** @type {FakeNode} */ (/** @type {unknown} */ (coverImg({ coverId: null, kind: 'album' })));
  const all = flatten(wrapper);
  assert.equal(all.some((n) => n.tagName === 'img'), false);
  assert.equal(hasPlaceholder(all), true);
});

test('a coverId renders an <img> pointed at the cover route, no placeholder yet', () => {
  const wrapper = /** @type {FakeNode} */ (/** @type {unknown} */ (coverImg({ coverId: 12, kind: 'book', alt: 'Cover' })));
  const all = flatten(wrapper);
  const img = all.find((n) => n.tagName === 'img');
  assert.ok(img, 'an <img> is rendered');
  assert.equal(/** @type {FakeNode} */ (img).getAttribute('src'), '/media/12/cover');
  assert.equal(/** @type {FakeNode} */ (img).getAttribute('alt'), 'Cover');
  assert.equal(hasPlaceholder(all), false);
});

test('an error event on the <img> replaces it with the placeholder glyph', () => {
  const wrapper = /** @type {FakeNode} */ (/** @type {unknown} */ (coverImg({ coverId: 12, kind: 'album' })));
  const img = /** @type {FakeNode} */ (flatten(wrapper).find((n) => n.tagName === 'img'));
  img.dispatchEvent(new Event('error'));
  const all = flatten(wrapper);
  assert.equal(all.some((n) => n.tagName === 'img'), false, 'the failed <img> is removed');
  assert.equal(hasPlaceholder(all), true);
});

test('no src-less <img> is ever left in the wrapper, across the null/loaded/error paths', () => {
  const wrapper = /** @type {FakeNode} */ (/** @type {unknown} */ (coverImg({ coverId: 5, kind: 'book' })));
  for (const node of flatten(wrapper)) {
    if (node.tagName !== 'img') continue;
    assert.ok(node.getAttribute('src'), 'every <img> present has a src');
    node.dispatchEvent(new Event('error'));
  }
  assert.equal(flatten(wrapper).some((n) => n.tagName === 'img' && !n.getAttribute('src')), false);
});
