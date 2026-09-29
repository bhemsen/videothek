/**
 * Shared fake DOM for the `public/js/lib/convert-control.js` +
 * `convert-poller.js` tests (#227): a minimal element tree (attrs, dataset,
 * click bubbling, `querySelectorAll('[data-x]')`, `isConnected`) plus fake
 * `document`, `location` and `fetch`, since the project has no jsdom
 * dependency and `test/helpers/player-page-fakes.js` has no
 * `querySelectorAll`. Split out of `test/public/convert-control.test.js` so
 * the decorator tests stay under the constitution's 300-line cap.
 */

import { decorateConversionsFor } from '../../public/js/lib/convert-control.js';
import { stopPolling } from '../../public/js/lib/convert-poller.js';

/** @typedef {import('../../public/js/lib/conversions-api.js').ConversionEntry} ConversionEntry */

export const g = /** @type {Record<string, any>} */ (/** @type {unknown} */ (globalThis));

/** Minimal fake element: attrs, dataset, a tree, click bubbling, `querySelectorAll('[data-x]')`. */
export class Node {
  /** @param {string} tag */
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.dataset = /** @type {Record<string, string>} */ ({});
    /** @type {Map<string, string>} */
    this.attrs = new Map();
    /** @type {(Node | { text: string })[]} */
    this.children = [];
    /** @type {Node | null} */
    this.parent = null;
    this.disabled = false;
    /** @type {((event: { stopPropagation: () => void }) => void)[]} */
    this.clickHandlers = [];
  }

  /** @param {string} name @param {string} value */
  setAttribute(name, value) { this.attrs.set(name, value); }
  /** @param {string} name @returns {string | null} */
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  /** @param {string} type @param {(event: { stopPropagation: () => void }) => void} fn */
  addEventListener(type, fn) { if (type === 'click') this.clickHandlers.push(fn); }
  /** @param {...(Node | { text: string } | string)} nodes */
  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof Node) { node.remove(); node.parent = this; this.children.push(node); }
      else this.children.push(typeof node === 'string' ? { text: node } : node);
    }
  }
  remove() {
    if (this.parent === null) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  /** Supports only `[data-x]` attribute selectors, the only ones the SUT uses.
   * @param {string} selector @returns {Node[]} */
  querySelectorAll(selector) {
    const key = /^\[data-([\w-]+)]$/.exec(selector)?.[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()) ?? '';
    const out = /** @type {Node[]} */ ([]);
    const walk = (/** @type {Node} */ n) => {
      for (const c of n.children) if (c instanceof Node) { if (c.dataset[key] !== undefined) out.push(c); walk(c); }
    };
    walk(this);
    return out;
  }
  get isConnected() {
    /** @type {Node} */
    let n = this;
    while (n.parent !== null) n = n.parent;
    return n === g.document.body;
  }
  /** @returns {string} */
  get textContent() {
    return this.children.map((c) => (c instanceof Node ? c.textContent : c.text)).join('');
  }
}

/**
 * Mutable fake-network state, reset by {@link setup}: every `fetch` call is
 * recorded; GETs answer via `responder`; POSTs answer `postStatus` with
 * `postBody` once `postGate` (if set) resolves.
 * @type {{ calls: { url: string, method: string }[], responder: (url: string) => Promise<{ status: number, body: unknown }>, postStatus: number, postBody: unknown, postGate: Promise<void> | null }}
 */
export const net = { calls: [], responder: async () => ({ status: 200, body: { enabled: true, items: [] } }), postStatus: 202, postBody: { error: 'x' }, postGate: null };

/** @type {Node[]} */
let rootsUsed = [];

/** Stops every poller a test armed (call from `afterEach`). @returns {void} */
export function stopAllPollers() {
  for (const root of rootsUsed) stopPolling(/** @type {any} */ (root));
  rootsUsed = [];
}

/** Installs a fresh fake `document`/`location`/`fetch` and a detached `root`. @returns {{ root: Node, body: Node, head: Node }} */
export function setup() {
  const head = Object.assign(new Node('head'), {
    querySelector: (/** @type {string} */ sel) => head.children.find((c) => c instanceof Node && sel === `link[href="${c.getAttribute('href')}"]`) ?? null,
  });
  const body = new Node('body');
  g.document = { head, body, hidden: false, createElement: (/** @type {string} */ tag) => new Node(tag), createTextNode: (/** @type {string} */ t) => ({ text: t }) };
  g.location = { pathname: '/movies', search: '', reloads: 0, reload() { this.reloads += 1; }, assign() {} };
  Object.assign(net, { calls: [], postStatus: 202, postBody: { error: 'x' }, postGate: null, responder: async () => ({ status: 200, body: { enabled: true, items: [] } }) });
  g.fetch = async (/** @type {string} */ url, /** @type {{ method: string }} */ init) => {
    net.calls.push({ url, method: init.method });
    let result;
    if (init.method === 'POST') {
      if (net.postGate !== null) await net.postGate;
      result = { status: net.postStatus, body: net.postBody };
    } else {
      result = await net.responder(url);
    }
    return { status: result.status, text: async () => JSON.stringify(result.body), headers: { get: () => null } };
  };
  const root = new Node('div');
  rootsUsed.push(root);
  return { root, body, head };
}

/** @param {string} tag @param {string} cls @param {number} id @returns {Node} */
export function host(tag, cls, id) {
  const node = new Node(tag);
  node.setAttribute('class', cls);
  node.dataset.itemId = String(id);
  return node;
}

/** @param {number} id @param {Partial<ConversionEntry>} overrides @returns {ConversionEntry} */
export function entry(id, overrides = {}) {
  return /** @type {ConversionEntry} */ ({
    itemId: id, item: {}, convertible: true, target: 'web', status: 'none', position: null, error: null,
    errorDetail: null, notes: [], outputSize: null, queuedAt: null, startedAt: null, finishedAt: null, ...overrides,
  });
}

/** A GET responder answering `200 { enabled: true, items }`. @param {ConversionEntry[]} items */
export const answer = (items) => async () => ({ status: 200, body: { enabled: true, items } });

/** Every `.convert-control` child of the host. @param {Node} h @returns {Node[]} */
export const controlsOf = (h) => /** @type {Node[]} */ (h.children.filter((c) => c instanceof Node && c.getAttribute('class') === 'convert-control'));
/** The host's `.convert-control`, if any. @param {Node} h @returns {Node | undefined} */
export const controlOf = (h) => controlsOf(h)[0];
/** The control's `role="status"` span text (`''` without one). @param {Node} h @returns {string} */
export function textOnly(h) {
  const span = controlOf(h)?.children.find((c) => c instanceof Node && c.getAttribute('role') === 'status');
  return span instanceof Node ? span.textContent : '';
}
/** @param {Node} h @returns {Node | undefined} */
export const button = (h) => /** @type {Node | undefined} */ (controlOf(h)?.children.find((c) => c instanceof Node && c.tagName === 'BUTTON'));
/** @param {Node} h @returns {string} */
export const buttonText = (h) => button(h)?.textContent ?? '';

/** Simulates a click, bubbling up through `parent` until `stopPropagation`. @param {Node | undefined} node */
export function click(node) {
  const event = { stopped: false, stopPropagation() { this.stopped = true; } };
  /** @type {Node | null} */
  let n = node ?? null;
  while (n !== null) {
    for (const fn of n.clickHandlers) fn(event);
    if (event.stopped) return;
    n = n.parent;
  }
}

/** Flushes pending microtasks and I/O callbacks. @returns {Promise<void>} */
export const flush = () => new Promise((resolve) => setImmediate(resolve));
/** @param {Node} root @returns {Promise<void>} */
export const decorate = (root) => decorateConversionsFor(/** @type {any} */ (root));

/** A promise plus its resolver, for holding a fake response open. @returns {{ promise: Promise<void>, release: () => void }} */
export function gate() {
  /** @type {() => void} */
  let release = () => {};
  const promise = new Promise((resolve) => { release = () => resolve(undefined); });
  return { promise, release };
}
