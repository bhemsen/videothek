import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { trackNavOffset } from '../../public/js/audio/nav-offset.js';

/**
 * `public/js/audio/nav-offset.js` (issue 193): the audio bar's
 * `--audio-bar-nav-offset` follows the measured border-box height of the
 * mobile bottom nav, including changes that only touch its padding
 * (safe-area inset), instead of assuming `--bar-height-mobile`.
 */

const g = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
const SAVED_RO = g.ResizeObserver;

afterEach(() => {
  g.ResizeObserver = SAVED_RO;
});

/** @type {{ callback: () => void, observed: { target: unknown, options: unknown }[] }[]} */
let observers;

function installResizeObserver() {
  observers = [];
  g.ResizeObserver = class {
    /** @param {() => void} callback */
    constructor(callback) {
      this.record = { callback, observed: /** @type {{ target: unknown, options: unknown }[]} */ ([]) };
      observers.push(this.record);
    }
    /** @param {unknown} target @param {unknown} options */
    observe(target, options) { this.record.observed.push({ target, options }); }
    disconnect() {}
  };
}

/** @returns {{ bar: HTMLElement, props: Map<string, string> }} */
function fakeBar() {
  /** @type {Map<string, string>} */
  const props = new Map();
  /** @param {string} key @param {string} value */
  const setProperty = (key, value) => props.set(key, value);
  const bar = { style: { setProperty } };
  return { bar: /** @type {HTMLElement} */ (/** @type {unknown} */ (bar)), props };
}

/** @param {{ height: number } | null} nav @returns {Pick<Document, 'querySelector'>} */
function fakeDoc(nav) {
  const node = nav === null ? null : { getBoundingClientRect: () => ({ height: nav.height }) };
  return /** @type {Pick<Document, 'querySelector'>} */ (/** @type {unknown} */ ({
    /** @param {string} selector */
    querySelector: (selector) => (selector === '.app-nav' ? node : null),
  }));
}

test('writes the measured nav height, not --bar-height-mobile, and follows border-box resizes', () => {
  installResizeObserver();
  const nav = { height: 47 };
  const { bar, props } = fakeBar();
  const observer = trackNavOffset(bar, fakeDoc(nav));
  assert.notEqual(observer, null);
  assert.equal(props.get('--audio-bar-nav-offset'), '47px', 'measured once immediately');
  assert.equal(observers.length, 1);
  assert.deepEqual(observers[0].observed[0].options, { box: 'border-box' }, 'padding-only (safe-area) changes must fire');

  nav.height = 47 + 34; // a safe-area inset appears: only the nav's padding grows
  observers[0].callback();
  assert.equal(props.get('--audio-bar-nav-offset'), '81px', 'kept live by the ResizeObserver');
});

test('is a no-op without a bottom nav', () => {
  installResizeObserver();
  const { bar, props } = fakeBar();
  assert.equal(trackNavOffset(bar, fakeDoc(null)), null);
  assert.equal(props.size, 0, 'bar falls back to the CSS default bottom: 0');
  assert.equal(observers.length, 0);
});

test('is a no-op without ResizeObserver', () => {
  g.ResizeObserver = undefined;
  const { bar, props } = fakeBar();
  assert.equal(trackNavOffset(bar, fakeDoc({ height: 47 })), null);
  assert.equal(props.size, 0);
});
