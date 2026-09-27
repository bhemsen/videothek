import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Page-level tests for `public/js/player.js` (spec-video-streaming.md,
 * issue #50 acceptance item 3): the module is imported fresh per test
 * (`?case=N`) against a minimal fake DOM, `location`, `history` and `fetch`,
 * since the project has no jsdom dependency.
 */

const g = /** @type {Record<string, any>} */ (/** @type {unknown} */ (globalThis));
const PAGE_URL = new URL('../../public/js/player.js', import.meta.url).href;
const SAVED = ['document', 'location', 'history', 'fetch'].map((k) => [k, g[k]]);

class FakeNode extends EventTarget {
  /** @param {string} tagName */
  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
    /** @type {Map<string, string>} */
    this.attrs = new Map();
    /** @type {(FakeNode | { text: string })[]} */
    this.children = [];
    /** @type {FakeNode | null} */
    this.parent = null;
    this.dataset = {};
    this.hidden = false;
    this.isContentEditable = false;
  }

  /** @param {string} name @param {string} value @returns {void} */
  setAttribute(name, value) {
    this.attrs.set(name, value);
    if (name === 'hidden') this.hidden = true;
  }

  /** @param {...(FakeNode | { text: string })} nodes @returns {void} */
  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof FakeNode) {
        node.remove();
        node.parent = this;
      }
      this.children.push(node);
    }
  }

  /** @param {...(FakeNode | { text: string })} nodes @returns {void} */
  replaceChildren(...nodes) {
    for (const child of this.children) if (child instanceof FakeNode) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }

  /** @returns {void} */
  remove() {
    if (this.parent === null) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  /** @returns {boolean} */
  get isConnected() {
    /** @type {FakeNode | null} */
    let node = this;
    while (node.parent !== null) node = node.parent;
    return node === g.document.body;
  }

  /** @param {string} value */
  set textContent(value) {
    this.children = [{ text: value }];
  }

  /** @returns {string} */
  get textContent() {
    return this.children.map((c) => (c instanceof FakeNode ? c.textContent : c.text)).join('');
  }

  /** @returns {void} */
  focus() {}
}

class FakeVideo extends FakeNode {
  constructor() {
    super('video');
    this.srcSets = 0;
    this.plays = 0;
    this.loads = 0;
    this.currentTime = 0;
    this.readyState = 0;
    /** @type {{ code: number } | null} */
    this.error = null;
    this.paused = true;
  }

  /** @param {string} value */
  set src(value) {
    this.srcSets += 1;
    this.attrs.set('src', value);
  }

  /** @returns {Promise<void>} */
  play() {
    this.plays += 1;
    return Promise.resolve();
  }

  /** Simulates the load algorithm: metadata gone, a `timeupdate` at 0. @returns {void} */
  load() {
    this.loads += 1;
    this.readyState = 0;
    this.currentTime = 0;
    this.error = null;
    this.dispatchEvent(new Event('timeupdate'));
  }
}

/** @type {{ url: string, method: string }[]} */
let requests;
/** @type {FakeVideo[]} */
let videos;
/** @type {((event: unknown) => void) | null} */
let keydown;

/**
 * Installs the fakes; `item` answers `GET /api/library/items/:id`, `headStatus` the `HEAD` probe.
 * @param {{ search: string, item?: unknown, headStatus?: number }} opts
 * @returns {void}
 */
function install({ search, item = null, headStatus = 200 }) {
  requests = [];
  videos = [];
  keydown = null;
  g.document = {
    body: new FakeNode('body'),
    title: 'Videothek',
    referrer: '',
    fullscreenElement: null,
    createElement: (/** @type {string} */ tag) => {
      if (tag !== 'video') return new FakeNode(tag);
      const video = new FakeVideo();
      videos.push(video);
      return video;
    },
    createElementNS: (/** @type {string} */ _ns, /** @type {string} */ tag) => new FakeNode(tag),
    createTextNode: (/** @type {string} */ text) => ({ text }),
    addEventListener: (/** @type {string} */ type, /** @type {(event: unknown) => void} */ fn) => {
      if (type === 'keydown') keydown = fn;
    },
  };
  g.location = { search, origin: 'http://h', pathname: '/player', assign() {}, replace() {}, reload() {} };
  g.history = { length: 1, back() {} };
  g.fetch = async (/** @type {string} */ url, /** @type {{ method: string }} */ init) => {
    requests.push({ url, method: init.method });
    const status = init.method === 'HEAD' ? headStatus : item === null ? 404 : 200;
    const body = init.method === 'HEAD' || item === null ? '' : JSON.stringify(item);
    return { status, text: async () => body, headers: { get: () => null } };
  };
}

let caseNo = 0;
/** Imports a fresh page instance and lets its async work settle. @returns {Promise<void>} */
async function loadPage() {
  caseNo += 1;
  await import(`${PAGE_URL}?case=${caseNo}`);
  await settle();
}

/** @returns {Promise<void>} */
async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** @param {FakeNode} node @returns {FakeNode[]} */
function flatten(node) {
  return [node, ...node.children.flatMap((c) => (c instanceof FakeNode ? flatten(c) : []))];
}

/** @param {string} text @returns {FakeNode | undefined} */
function findByText(text) {
  return flatten(g.document.body).find((n) => n.children.some((c) => !(c instanceof FakeNode) && c.text === text));
}

/** @param {Partial<Record<string, unknown>>} [overrides] @returns {Record<string, unknown>} */
function movie(overrides = {}) {
  return {
    id: 7, category: 'movies', title: 'Film', ext: 'mkv', playable: true,
    seriesTitle: null, season: null, episode: null, episodeEnd: null,
    next: null, subtitles: [{ index: 0, lang: 'de', label: null }], ...overrides,
  };
}

afterEach(() => {
  for (const [key, value] of SAVED) g[key] = value;
});

test('an invalid id shows "Titel nicht gefunden" without any request', async () => {
  install({ search: '?id=0x1' });
  await loadPage();
  assert.deepEqual(requests, []);
  assert.ok(findByText('Titel nicht gefunden'));
  assert.equal(videos.length, 0);
});

test('a non-playable item makes no /media/ request and creates no <video>', async () => {
  install({ search: '?id=7', item: movie({ playable: false }) });
  await loadPage();
  assert.deepEqual(requests, [{ url: '/api/library/items/7', method: 'GET' }]);
  assert.equal(videos.length, 0);
  assert.ok(findByText('Dieses Video kann nicht abgespielt werden'));
  assert.ok(findByText('Nicht abspielbar'));
});

test('a playable item gets exactly one <video> with its track and src, started once', async () => {
  install({ search: '?id=7', item: movie() });
  await loadPage();
  assert.equal(videos.length, 1);
  const [video] = videos;
  assert.equal(video.isConnected, true);
  assert.equal(video.attrs.get('src'), '/media/7');
  assert.equal(video.srcSets, 1);
  assert.equal(video.children.filter((c) => c instanceof FakeNode && c.tagName === 'TRACK').length, 1);
  assert.equal(video.plays, 1);
});

test('a playback error + HEAD 404 detaches the video; retry reuses it without re-running startPlayback', async () => {
  install({ search: '?id=7', item: movie(), headStatus: 404 });
  await loadPage();
  const [video] = videos;
  video.readyState = 4;
  video.currentTime = 42;
  video.dispatchEvent(new Event('timeupdate'));
  video.error = { code: 4 };
  video.dispatchEvent(new Event('error'));
  await settle();
  assert.equal(video.isConnected, false, 'the element is detached in the error state');
  assert.deepEqual(requests.at(-1), { url: '/media/7', method: 'HEAD' });
  assert.ok(findByText('Datei nicht gefunden'));

  const playsBefore = video.plays;
  /** @type {FakeNode} */ (findByText('Erneut versuchen')).dispatchEvent(new Event('click'));
  assert.equal(video.isConnected, true, 'the same element is re-attached');
  assert.equal(video.loads, 1);
  video.readyState = 1;
  video.dispatchEvent(new Event('loadedmetadata'));
  await settle();
  assert.equal(video.currentTime, 42);

  // A second failure after retry: load()'s timeupdate at 0 must not have clobbered lastTime.
  video.error = { code: 4 };
  video.dispatchEvent(new Event('error'));
  await settle();
  /** @type {FakeNode} */ (findByText('Erneut versuchen')).dispatchEvent(new Event('click'));
  video.readyState = 1;
  video.dispatchEvent(new Event('loadedmetadata'));
  await settle();
  assert.equal(video.currentTime, 42, 'the second retry resumes at lastTime too');
  assert.equal(video.loads, 2);
  assert.equal(videos.length, 1, 'no second <video>');
  assert.equal(video.srcSets, 1, 'src is never re-set (startPlayback not re-run)');
  assert.equal(video.children.filter((c) => c instanceof FakeNode && c.tagName === 'TRACK').length, 1);
  assert.equal(video.plays, playsBefore + 2);
});

test('the keyboard listener is inert while the video is detached', async () => {
  install({ search: '?id=7', item: movie(), headStatus: 200 });
  await loadPage();
  const [video] = videos;
  const press = () => {
    let prevented = false;
    /** @type {(event: unknown) => void} */ (keydown)({
      key: 'm', ctrlKey: false, altKey: false, metaKey: false,
      target: { tagName: 'BODY', isContentEditable: false },
      preventDefault: () => { prevented = true; },
    });
    return prevented;
  };
  assert.equal(press(), true);
  video.error = { code: 2 };
  video.dispatchEvent(new Event('error'));
  await settle();
  assert.ok(findByText('Verbindung unterbrochen'));
  assert.equal(press(), false);
});
