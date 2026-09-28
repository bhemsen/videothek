import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mountBatchedItems } from '../../public/js/image-batch.js';

const g = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
const savedDocument = g.document;
const savedObserver = g.IntersectionObserver;

/** Minimal element stand-in: attributes, dataset and an ordered child list. */
class FakeNode {
  /** @param {string} tagName */
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    /** @type {Record<string, string>} */
    this.attributes = {};
    /** @type {Record<string, string>} */
    this.dataset = {};
    /** @type {FakeNode[]} */
    this.children = [];
    /** @type {FakeNode | null} */
    this.parent = null;
  }

  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  addEventListener() {}

  /** @param {...FakeNode} nodes */
  append(...nodes) {
    for (const node of nodes) this.insertBefore(node, null);
  }

  /** @param {FakeNode} node @param {FakeNode | null} ref */
  insertBefore(node, ref) {
    node.remove();
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at === -1) this.children.push(node);
    else this.children.splice(at, 0, node);
    node.parent = this;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
}

/** Records observe/unobserve/disconnect and lets a test fire the callback. */
class FakeObserver {
  /** @param {(entries: { isIntersecting: boolean }[]) => void} callback */
  constructor(callback) {
    this.callback = callback;
    /** @type {Set<unknown>} */
    this.observed = new Set();
    this.disconnected = false;
    lastObserver = this;
  }

  /** @param {unknown} target */
  observe(target) {
    this.observed.add(target);
  }

  /** @param {unknown} target */
  unobserve(target) {
    this.observed.delete(target);
  }

  disconnect() {
    this.observed.clear();
    this.disconnected = true;
  }

  /** @param {boolean} isIntersecting */
  fire(isIntersecting) {
    this.callback([{ isIntersecting }]);
  }
}

/** @type {FakeObserver} */
let lastObserver;

/** @param {number} count */
const videoItems = (count) =>
  /** @type {any[]} */ (
    Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `v${i + 1}.mp4`, kind: 'video', playable: true }))
  );

/** @param {FakeNode} grid @returns {string[]} item ids of the rendered tiles, in order */
const tileIds = (grid) => grid.children.filter((c) => c.dataset.itemId).map((c) => c.dataset.itemId);

/** @param {FakeNode} grid */
const hasSentinel = (grid) => grid.children.some((c) => c.attributes.class === 'gallery-sentinel');

/** @param {number} count */
function mount(count) {
  const grid = new FakeNode('div');
  const controller = mountBatchedItems(/** @type {any} */ (grid), videoItems(count));
  return { grid, controller };
}

beforeEach(() => {
  g.document = {
    /** @param {string} tag */
    createElement: (tag) => new FakeNode(tag),
    /** @param {string} _ns @param {string} tag */
    createElementNS: (_ns, tag) => new FakeNode(tag),
    /** @param {string} text */
    createTextNode: (text) => Object.assign(new FakeNode('#text'), { textContent: text }),
  };
  g.IntersectionObserver = FakeObserver;
});

afterEach(() => {
  g.document = savedDocument;
  g.IntersectionObserver = savedObserver;
});

test('mountBatchedItems renders the first batch and observes a trailing sentinel', () => {
  const { grid } = mount(300);
  const ids = tileIds(grid);
  assert.equal(ids.length, 120);
  assert.equal(ids[0], '1');
  assert.equal(ids[119], '120');
  assert.equal(grid.children.at(-1)?.attributes.class, 'gallery-sentinel');
  assert.equal(lastObserver.observed.size, 1);
});

test('an intersecting sentinel renders the next batch; a non-intersecting one does nothing', () => {
  const { grid } = mount(300);
  lastObserver.fire(false);
  assert.equal(tileIds(grid).length, 120);
  lastObserver.fire(true);
  assert.equal(tileIds(grid).length, 240);
  assert.ok(hasSentinel(grid));
  lastObserver.fire(true);
  assert.equal(tileIds(grid).length, 300);
  assert.equal(hasSentinel(grid), false);
  assert.equal(lastObserver.disconnected, true);
});

test('ensureRendered renders every tile up to a not-yet-rendered item, in order', () => {
  const { grid, controller } = mount(300);
  controller.ensureRendered(201);
  const ids = tileIds(grid);
  assert.equal(ids.length, 201);
  assert.deepEqual(ids, Array.from({ length: 201 }, (_, i) => String(i + 1)));
  assert.equal(grid.children.at(-1)?.attributes.class, 'gallery-sentinel');
  assert.equal(lastObserver.disconnected, false);
});

test('ensureRendered for the last item renders all and removes the sentinel', () => {
  const { grid, controller } = mount(300);
  controller.ensureRendered(300);
  assert.equal(tileIds(grid).length, 300);
  assert.equal(hasSentinel(grid), false);
  assert.equal(lastObserver.disconnected, true);
});

test('ensureRendered is a no-op for an already rendered or unknown item', () => {
  const { grid, controller } = mount(300);
  controller.ensureRendered(5);
  controller.ensureRendered(9999);
  assert.equal(tileIds(grid).length, 120);
  assert.ok(hasSentinel(grid));
});

test('a folder that fits in one batch never observes and drops the sentinel', () => {
  const { grid } = mount(3);
  assert.deepEqual(tileIds(grid), ['1', '2', '3']);
  assert.equal(hasSentinel(grid), false);
  assert.equal(lastObserver.observed.size, 0);
});
