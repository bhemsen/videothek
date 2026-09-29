import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { decorateConversionsFor } from '../../public/js/lib/convert-control.js';
import { stopPolling } from '../../public/js/lib/convert-poller.js';

/**
 * `convert-control.js` + `convert-poller.js` (#227). DOM fakes in the style
 * of `test/helpers/player-page-fakes.js`, minimal to what `el()` needs.
 */

/** @typedef {import('../../public/js/lib/conversions-api.js').ConversionEntry} ConversionEntry */

const g = /** @type {Record<string, any>} */ (/** @type {unknown} */ (globalThis));

/** Minimal fake element: attrs, dataset, a tree, click bubbling, `querySelectorAll('[data-x]')`. */
class Node {
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

/** @type {{ url: string, method: string }[]} */
let calls;
/** @type {(url: string) => Promise<{ status: number, body: unknown }>} */
let responder;
let postStatus = 202;
/** @type {Node[]} */
let rootsUsed = [];

afterEach(() => {
  for (const root of rootsUsed) stopPolling(/** @type {any} */ (root));
  rootsUsed = [];
});

/** Installs a fresh fake `document`/`location`/`fetch` and a detached `root`. @returns {{ root: Node, body: Node }} */
function setup() {
  const head = Object.assign(new Node('head'), {
    querySelector: (/** @type {string} */ sel) => head.children.find((c) => c instanceof Node && sel === `link[href="${c.getAttribute('href')}"]`) ?? null,
  });
  const body = new Node('body');
  g.document = { head, body, hidden: false, createElement: (/** @type {string} */ tag) => new Node(tag), createTextNode: (/** @type {string} */ t) => ({ text: t }) };
  g.location = { pathname: '/movies', search: '', reloads: 0, reload() { this.reloads += 1; }, assign() {} };
  calls = [];
  postStatus = 202;
  responder = async () => ({ status: 200, body: { enabled: true, items: [] } });
  g.fetch = async (/** @type {string} */ url, /** @type {{ method: string }} */ init) => {
    calls.push({ url, method: init.method });
    const result = init.method === 'POST' ? { status: postStatus, body: { error: 'x' } } : await responder(url);
    return { status: result.status, text: async () => JSON.stringify(result.body), headers: { get: () => null } };
  };
  const root = new Node('div');
  rootsUsed.push(root);
  return { root, body };
}

/** @param {string} tag @param {string} cls @param {number} id @returns {Node} */
function host(tag, cls, id) {
  const node = new Node(tag);
  node.setAttribute('class', cls);
  node.dataset.itemId = String(id);
  return node;
}

/** @param {number} id @param {Partial<ConversionEntry>} overrides @returns {ConversionEntry} */
function entry(id, overrides = {}) {
  return /** @type {ConversionEntry} */ ({
    itemId: id, item: {}, convertible: true, target: 'web', status: 'none', position: null, error: null,
    errorDetail: null, notes: [], outputSize: null, queuedAt: null, startedAt: null, finishedAt: null, ...overrides,
  });
}

/** The host's `.convert-control`, if any. @param {Node} h @returns {Node | undefined} */
const controlOf = (h) => /** @type {Node | undefined} */ (h.children.find((c) => c instanceof Node && c.getAttribute('class') === 'convert-control'));
/** @param {Node} h @returns {string} */
function textOnly(h) {
  const p = controlOf(h)?.children.find((c) => c instanceof Node && c.tagName === 'P');
  return p instanceof Node ? p.textContent : '';
}
/** @param {Node} h @returns {Node | undefined} */
const button = (h) => /** @type {Node | undefined} */ (controlOf(h)?.children.find((c) => c instanceof Node && c.tagName === 'BUTTON'));
/** @param {Node} h @returns {string} */
const buttonText = (h) => button(h)?.textContent ?? '';

/** Simulates a click, bubbling up through `parent` until `stopPropagation`. @param {Node | undefined} node */
function click(node) {
  const event = { stopped: false, stopPropagation() { this.stopped = true; } };
  /** @type {Node | null} */
  let n = node ?? null;
  while (n !== null) {
    for (const fn of n.clickHandlers) fn(event);
    if (event.stopped) return;
    n = n.parent;
  }
}

/** Flushes pending microtasks. @returns {Promise<void>} */
const flush = () => new Promise((resolve) => setImmediate(resolve));
/** @param {Node} root @returns {Promise<void>} */
const decorate = (root) => decorateConversionsFor(/** @type {any} */ (root));

test('no matching host -> no request; a 403, a disabled feature or a failing fetch leaves the page untouched', async () => {
  const { root } = setup();
  root.append(host('div', 'something-else', 99));
  await decorate(root);
  assert.equal(calls.length, 0);

  const item = host('div', 'media-card', 1);
  root.append(item);
  responder = async () => ({ status: 200, body: { enabled: true, items: [entry(1, { status: 'none' })] } });
  await decorate(root);
  assert.equal(buttonText(item), 'Konvertieren');

  responder = async () => ({ status: 403, body: { error: 'forbidden' } });
  await decorate(root);
  assert.equal(buttonText(item), 'Konvertieren', 'untouched after 403');

  responder = async () => ({ status: 200, body: { enabled: false, items: [] } });
  await decorate(root);
  assert.equal(buttonText(item), 'Konvertieren', 'untouched while disabled');
});

test('renders the first-match control per status, table row by row, and stays idempotent on re-decoration', async () => {
  const { root } = setup();
  const none = host('div', 'media-card', 1);
  const queued = host('div', 'episode-row', 2);
  const converting = host('div', 'track-row track-row--unplayable', 3);
  const failed = host('div', 'file-row file-row--unplayable', 4);
  const playable = host('div', 'media-card', 5);
  const hidden = host('div', 'media-card', 6);
  root.append(none, queued, converting, failed, playable, hidden);
  responder = async () => ({
    status: 200,
    body: {
      enabled: true,
      items: [
        entry(1, { status: 'none' }), entry(2, { status: 'queued', position: 3 }), entry(3, { status: 'converting' }),
        entry(4, { status: 'failed', error: 'converter_failed' }), entry(5, { status: 'playable' }),
        entry(6, { status: 'none', convertible: false }),
      ],
    },
  });
  await decorate(root);
  assert.equal(buttonText(none), 'Konvertieren');
  assert.equal(textOnly(queued), 'In Warteschlange · Platz 3');
  assert.equal(button(queued), undefined);
  assert.equal(textOnly(converting), 'Wird konvertiert …');
  assert.equal(textOnly(failed), 'Konvertierung fehlgeschlagen: Der Konverter meldet einen Fehler');
  assert.equal(buttonText(failed), 'Erneut versuchen');
  assert.equal(textOnly(playable), 'Konvertiert');
  assert.equal(buttonText(playable), 'Neu laden');
  assert.equal(controlOf(hidden), undefined);

  responder = async () => ({ status: 200, body: { enabled: true, items: [entry(1, { status: 'stale' })] } });
  await decorate(root);
  assert.equal(none.children.filter((c) => c instanceof Node && c.getAttribute('class') === 'convert-control').length, 1);
  assert.equal(buttonText(none), 'Konvertieren');
});

test('splits listConversions into batches of at most 500 ids', async () => {
  const { root } = setup();
  for (let id = 1; id <= 501; id += 1) root.append(host('div', 'media-card', id));
  await decorate(root);
  assert.equal(calls.filter((c) => c.method === 'GET').length, 2);
});

test('POST error mapping: 409 -> Konvertiert (+ Neu laden reloads), 400/404/503 -> removed, other -> retry enabled; clicks never reach the host', async () => {
  const { root } = setup();
  const a = host('div', 'media-card', 1);
  const b = host('div', 'media-card', 2);
  const c = host('div', 'media-card', 3);
  let hostClicks = 0;
  a.addEventListener('click', () => { hostClicks += 1; });
  root.append(a, b, c);
  responder = async () => ({
    status: 200,
    body: { enabled: true, items: [entry(1, { status: 'none' }), entry(2, { status: 'none' }), entry(3, { status: 'none' })] },
  });
  await decorate(root);

  postStatus = 409;
  click(button(a));
  await flush();
  assert.equal(textOnly(a), 'Konvertiert');
  assert.equal(buttonText(a), 'Neu laden');
  assert.equal(hostClicks, 0, 'the control click never reached the host');
  click(button(a));
  assert.equal(g.location.reloads, 1);

  postStatus = 404;
  click(button(b));
  await flush();
  assert.equal(controlOf(b), undefined);

  postStatus = 500;
  const btn = button(c);
  click(btn);
  assert.equal(btn?.disabled, true, 'disabled synchronously on click, before the POST settles');
  await flush();
  assert.equal(textOnly(c), 'Konvertieren nicht möglich. Bitte erneut versuchen.');
  assert.equal(buttonText(c), 'Konvertieren');
  assert.equal(button(c)?.disabled, false, 're-enabled after a generic error');
});

test('the poller pauses while hidden, survives a transient error, stops for good on 401, and stops once disconnected', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { root, body } = setup();
  body.append(root);
  root.append(host('div', 'media-card', 1));
  let polls = 0;
  const queuedOnce = async () => { polls += 1; return { status: 200, body: { enabled: true, items: [entry(1, { status: 'queued', position: 1 })] } }; };
  responder = queuedOnce;
  await decorate(root);
  assert.equal(polls, 1);

  g.document.hidden = true;
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(polls, 1, 'paused while hidden');
  g.document.hidden = false;

  let attempts = 0;
  responder = async () => { attempts += 1; throw new Error('network down'); };
  t.mock.timers.tick(5000);
  await flush();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(attempts, 2, 'a transient error keeps the interval running');

  responder = async () => { polls += 1; return { status: 401, body: { error: 'unauthorized' } }; };
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(polls, 2);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(polls, 2, 'stopped for good after 401');

  responder = queuedOnce;
  await decorate(root); // re-arms the poller
  assert.equal(polls, 3);
  root.remove();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(polls, 3, 'no poll once disconnected');
});
