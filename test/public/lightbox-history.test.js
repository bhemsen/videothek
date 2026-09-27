import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLightboxHistory } from '../../public/js/lightbox-history.js';

const g = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
/** @type {{ window: unknown, history: unknown }} */
const saved = { window: undefined, history: undefined };

/**
 * Minimal in-memory session history: a stack of `{ state, url }` entries and
 * a cursor. `back()` moves the cursor and dispatches `popstate` synchronously
 * (real browsers dispatch it asynchronously; ordering is irrelevant here).
 */
class FakeHistory {
  /** @param {(state: unknown) => void} dispatch */
  constructor(dispatch) {
    this.dispatch = dispatch;
    /** @type {{ state: unknown, url: string }[]} */
    this.entries = [{ state: null, url: '/images?folder=a' }];
    this.index = 0;
    this.backCalls = 0;
  }
  get state() {
    return this.entries[this.index].state;
  }
  /** @param {unknown} state @param {string} _title @param {string} url */
  pushState(state, _title, url) {
    this.entries.splice(this.index + 1, Infinity, { state, url });
    this.index += 1;
  }
  /** @param {unknown} state @param {string} _title @param {string} url */
  replaceState(state, _title, url) {
    this.entries[this.index] = { state, url };
  }
  back() {
    this.backCalls += 1;
    this.go(-1);
  }
  forward() {
    this.go(1);
  }
  /** @param {number} delta */
  go(delta) {
    const next = this.index + delta;
    if (next < 0 || next >= this.entries.length) return;
    this.index = next;
    this.dispatch(this.state);
  }
}

/** @type {Set<(event: { state: unknown }) => void>} */
let listeners;
/** @type {FakeHistory} */
let fake;

beforeEach(() => {
  saved.window = g.window;
  saved.history = g.history;
  listeners = new Set();
  g.window = {
    /** @param {string} type @param {(event: { state: unknown }) => void} fn */
    addEventListener: (type, fn) => type === 'popstate' && listeners.add(fn),
    /** @param {string} type @param {(event: { state: unknown }) => void} fn */
    removeEventListener: (type, fn) => type === 'popstate' && listeners.delete(fn),
  };
  fake = new FakeHistory((state) => {
    for (const fn of listeners) fn({ state });
  });
  g.history = fake;
});

afterEach(() => {
  g.window = saved.window;
  g.history = saved.history;
});

test('push adds one #bild-<id> entry above the folder entry', () => {
  const lh = createLightboxHistory({ onPop: () => {} });
  lh.push(7);
  assert.equal(fake.entries.length, 2);
  assert.deepEqual(fake.entries[1], { state: { lightbox: 7 }, url: '#bild-7' });
});

test('replace keeps a single lightbox entry while navigating', () => {
  const lh = createLightboxHistory({ onPop: () => {} });
  lh.push(7);
  lh.replace(8);
  lh.replace(9);
  assert.equal(fake.entries.length, 2);
  assert.deepEqual(fake.entries[1], { state: { lightbox: 9 }, url: '#bild-9' });
});

test('release steps back once to the folder entry and fires onPop there', () => {
  let pops = 0;
  const lh = createLightboxHistory({ onPop: () => (pops += 1) });
  lh.push(7);
  lh.release();
  assert.equal(fake.index, 0);
  assert.equal(fake.backCalls, 1);
  assert.equal(pops, 1);
});

test('release does not step back when a back navigation already left the lightbox entry', () => {
  const lh = createLightboxHistory({ onPop: () => {} });
  lh.push(7);
  fake.back();
  lh.release();
  assert.equal(fake.backCalls, 1, 'only the user back step, none from release');
  assert.equal(fake.index, 0);
});

test('popstate onto a lightbox state does not call onPop', () => {
  let pops = 0;
  const lh = createLightboxHistory({ onPop: () => (pops += 1) });
  lh.push(7);
  lh.release();
  pops = 0;
  fake.forward();
  assert.equal(pops, 0);
});

test('open after Forward onto a stale lightbox entry reuses it, so one close returns to the folder', () => {
  const lh = createLightboxHistory({ onPop: () => {} });
  lh.push(7);
  lh.release();
  fake.forward();
  lh.push(9);
  assert.equal(fake.entries.length, 2, 'no extra entry stacked on the stale one');
  assert.deepEqual(fake.entries[1], { state: { lightbox: 9 }, url: '#bild-9' });
  lh.release();
  assert.equal(fake.index, 0);
  assert.equal(fake.state, null);
});

test('dispose removes the popstate listener', () => {
  let pops = 0;
  const lh = createLightboxHistory({ onPop: () => (pops += 1) });
  lh.push(7);
  lh.dispose();
  fake.back();
  assert.equal(pops, 0);
  assert.equal(listeners.size, 0);
});

test('reload with #bild-<id> that reopens: browser Back closes the lightbox and stays in the folder', () => {
  // Browsers keep history.state across a reload: the reloaded entry still
  // carries { lightbox: 5 } above the folder entry it was pushed from.
  fake.entries.push({ state: { lightbox: 5 }, url: '#bild-5' });
  fake.index = 1;
  let pops = 0;
  const lh = createLightboxHistory({ onPop: () => (pops += 1) });
  // images.js openFromInitialHash: keep the state when reopening, then open().
  fake.replaceState(fake.state, '', '/images?folder=a');
  lh.push(5);
  assert.equal(fake.entries.length, 2, 'reopen reuses the reloaded entry');
  fake.back();
  assert.equal(pops, 1, 'Back must reach a state without lightbox and close the dialog');
  assert.equal(fake.index, 0);
  assert.equal(fake.entries[0].url, '/images?folder=a');
});

test('shared link with #bild-<id> (no prior state): Back closes the lightbox onto the plain folder URL', () => {
  fake.entries[0] = { state: null, url: '/images?folder=a#bild-5' };
  let pops = 0;
  const lh = createLightboxHistory({ onPop: () => (pops += 1) });
  fake.replaceState(fake.state, '', '/images?folder=a');
  lh.push(5);
  assert.equal(fake.entries.length, 2);
  fake.back();
  assert.equal(pops, 1);
  assert.deepEqual(fake.entries[0], { state: null, url: '/images?folder=a' });
});
