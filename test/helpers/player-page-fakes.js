/**
 * Shared fake DOM for `public/js/player.js` page tests and the resume toast
 * (`public/js/lib/resume-toast.js`) tests: a minimal `EventTarget`-based
 * node/video pair plus fake `document`, `location`, `history`, `window`,
 * `fetch` and `requestAnimationFrame`, since the project has no jsdom
 * dependency. Split out of `test/public/player-page.test.js` so the page
 * tests stay under the constitution's 300-line cap.
 */

export const g = /** @type {Record<string, any>} */ (/** @type {unknown} */ (globalThis));
const SAVED = ['document', 'location', 'history', 'fetch', 'window', 'requestAnimationFrame'].map((k) => [k, g[k]]);

export class FakeNode extends EventTarget {
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
    this.focusCalls = 0;
    /** @type {null | object} */
    this.sheet = null;
    /** @type {Set<string>} */
    this.classes = new Set();
    this.classList = { add: (/** @type {string} */ c) => this.classes.add(c) };
    /** @type {Map<string, string>} */
    this.styleProps = new Map();
    this.style = { setProperty: (/** @type {string} */ k, /** @type {string} */ v) => this.styleProps.set(k, v) };
  }

  /** @param {string} name @param {string} value @returns {void} */
  setAttribute(name, value) {
    this.attrs.set(name, value);
    if (name === 'hidden') this.hidden = true;
  }

  /** @param {string} name @returns {string | null} */
  getAttribute(name) {
    return this.attrs.get(name) ?? null;
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

  /** @param {FakeNode} node @returns {void} */
  after(node) {
    const parent = /** @type {FakeNode} */ (this.parent);
    node.remove();
    node.parent = parent;
    parent.children.splice(parent.children.indexOf(this) + 1, 0, node);
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

  /** @param {unknown} other @returns {boolean} */
  contains(other) {
    /** @type {FakeNode | null} */
    let node = other instanceof FakeNode ? other : null;
    while (node !== null && node !== this) node = node.parent;
    return node === this;
  }

  /** @returns {FakeNode | null} */
  get parentElement() {
    return this.parent;
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
  focus() {
    this.focusCalls += 1;
  }
}

export class FakeVideo extends FakeNode {
  constructor() {
    super('video');
    this.srcSets = 0;
    this.plays = 0;
    this.loads = 0;
    this.currentTime = 0;
    this.readyState = 0;
    this.duration = NaN;
    this.offsetTop = 0;
    this.offsetHeight = 0;
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
export let requests = [];
/** @type {FakeVideo[]} */
export let videos = [];
/** @type {((event: unknown) => void) | null} */
export let keydown = null;
/** @type {(() => void)[]} */
export let frames = [];

/** Installs just the fake `document` (with `head` and `body`) and `requestAnimationFrame`. @returns {void} */
export function installDocument() {
  videos = [];
  keydown = null;
  frames = [];
  const head = Object.assign(new FakeNode('head'), {
    querySelector: (/** @type {string} */ sel) =>
      head.children.find((c) => c instanceof FakeNode && sel === `link[href="${c.getAttribute('href')}"]`) ?? null,
  });
  g.document = {
    head,
    body: new FakeNode('body'),
    title: 'Videothek',
    referrer: '',
    fullscreenElement: null,
    visibilityState: 'visible',
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
    removeEventListener() {},
  };
  g.requestAnimationFrame = (/** @type {() => void} */ fn) => frames.push(fn);
}

/** Runs every queued animation frame callback. @returns {void} */
export function flushFrames() {
  const queued = frames;
  frames = [];
  for (const fn of queued) fn();
}

/**
 * Installs every fake; `item` answers `GET /api/library/items/:id`, `headStatus`
 * the `HEAD` probe, `progress` `GET /api/progress/:id` (status + JSON body),
 * released only once `progressGate` resolves.
 * @param {{ search: string, item?: unknown, headStatus?: number, progress?: { status: number, body: unknown }, progressGate?: Promise<void> }} opts
 * @returns {void}
 */
export function install({ search, item = null, headStatus = 200, progress = { status: 200, body: { state: 'none' } }, progressGate }) {
  requests = [];
  installDocument();
  g.location = { search, origin: 'http://h', pathname: '/player', assign() {}, replace() {}, reload() {} };
  g.history = { length: 1, back() {} };
  // P4's progress tracker (trackPlayback) attaches a `pagehide` listener unconditionally.
  g.window = { addEventListener() {}, removeEventListener() {} };
  g.fetch = async (/** @type {string} */ url, /** @type {{ method: string }} */ init) => {
    requests.push({ url, method: init.method });
    if (url.startsWith('/api/progress/')) {
      await progressGate;
      return { status: progress.status, text: async () => JSON.stringify(progress.body), headers: { get: () => null } };
    }
    const status = init.method === 'HEAD' ? headStatus : item === null ? 404 : 200;
    const body = init.method === 'HEAD' || item === null ? '' : JSON.stringify(item);
    return { status, text: async () => body, headers: { get: () => null } };
  };
}

/** Restores every global the fakes replaced. @returns {void} */
export function restoreGlobals() {
  for (const [key, value] of SAVED) g[key] = value;
}

const PAGE_URL = new URL('../../public/js/player.js', import.meta.url).href;
let caseNo = 0;
/** Imports a fresh page instance (`?case=N`) and lets its async work settle. @returns {Promise<void>} */
export async function loadPage() {
  caseNo += 1;
  await import(`${PAGE_URL}?case=${caseNo}`);
  await settle();
}

/** @returns {Promise<void>} */
export async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** @param {FakeNode} node @returns {FakeNode[]} */
export function flatten(node) {
  return [node, ...node.children.flatMap((c) => (c instanceof FakeNode ? flatten(c) : []))];
}

/** @param {string} text @param {FakeNode} [root] @returns {FakeNode | undefined} */
export function findByText(text, root = g.document.body) {
  return flatten(root).find((n) => n.children.some((c) => !(c instanceof FakeNode) && c.text === text));
}

/** @param {Partial<Record<string, unknown>>} [overrides] @returns {Record<string, unknown>} */
export function movie(overrides = {}) {
  return {
    id: 7, category: 'movies', title: 'Film', ext: 'mkv', playable: true,
    seriesTitle: null, season: null, episode: null, episodeEnd: null,
    next: null, subtitles: [{ index: 0, lang: 'de', label: null }], ...overrides,
  };
}
