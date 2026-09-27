import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeNode, FakeVideo, g, installDocument, flushFrames, settle, findByText, restoreGlobals } from '../helpers/player-page-fakes.js';

/**
 * `public/js/lib/resume-toast.js` (spec-progress-resume.md "Resume toast",
 * issue #56): stylesheet injection, insertion after the stylesheet loaded,
 * next-frame fill, auto-hide pause/restart, close paths and focus return,
 * media `emptied`/`error`, desktop `--resume-toast-top` via `ResizeObserver`.
 * The module is imported fresh per test (`?case=N`) since it caches its
 * stylesheet promise at module level.
 */

const MODULE_URL = new URL('../../public/js/lib/resume-toast.js', import.meta.url).href;
const SAVED_RO = g.ResizeObserver;
let caseNo = 0;

afterEach(() => {
  restoreGlobals();
  g.ResizeObserver = SAVED_RO;
});

/** @type {{ callback: () => void, observed: unknown[], disconnected: boolean }[]} */
let observers;

/** Fake DOM, a video in a host in `<body>`, a recording `ResizeObserver`, the module freshly imported. */
async function setup() {
  installDocument();
  observers = [];
  g.ResizeObserver = class {
    /** @param {() => void} callback */
    constructor(callback) {
      this.record = { callback, observed: /** @type {unknown[]} */ ([]), disconnected: false };
      observers.push(this.record);
    }
    /** @param {unknown} target */
    observe(target) { this.record.observed.push(target); }
    disconnect() { this.record.disconnected = true; }
  };
  const host = new FakeNode('div');
  const media = new FakeVideo();
  host.append(media);
  g.document.body.append(host);
  caseNo += 1;
  const mod = await import(`${MODULE_URL}?case=${caseNo}`);
  return { host, media, /** @type {typeof import('../../public/js/lib/resume-toast.js').showResumeToast} */ show: mod.showResumeToast };
}

/** @returns {FakeNode[]} */
function links() {
  return /** @type {FakeNode[]} */ (g.document.head.children);
}

/** Fires `load` on the injected stylesheet and flushes the insertion + next-frame fill. */
async function loadStylesheet() {
  links()[0].dispatchEvent(new Event('load'));
  await settle();
  flushFrames();
}

/** @param {FakeNode} host @returns {FakeNode | undefined} */
function toastIn(host) {
  return /** @type {FakeNode[]} */ (host.children).find((c) => c.getAttribute('class') === 'resume-toast');
}

/** @param {FakeNode} toast @param {string} type @param {unknown} [relatedTarget] */
function fire(toast, type, relatedTarget = null) {
  toast.dispatchEvent(Object.assign(new Event(type), { relatedTarget }));
}

test('injects the stylesheet once and inserts the toast after the video only once it has loaded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // no real 8 s timer outlives a test
  const { host, media, show } = await setup();
  media.offsetTop = 90; // pre-stylesheet layout: offsetParent is <body>
  media.offsetHeight = 400;
  const first = show({ media, position: 754 });
  assert.equal(links().length, 1);
  assert.equal(links()[0].getAttribute('rel'), 'stylesheet');
  await settle();
  assert.equal(toastIn(host), undefined, 'never laid out unstyled');

  media.offsetTop = 0; // host is `position: relative` now
  await loadStylesheet();
  const toast = /** @type {FakeNode} */ (toastIn(host));
  assert.equal(host.children.indexOf(toast), host.children.indexOf(media) + 1);
  assert.ok(host.classes.has('resume-toast-host'));
  assert.equal(host.styleProps.get('--resume-toast-top'), '400px', 'measured after the stylesheet loaded');
  assert.deepEqual(observers[0].observed, [media]);

  media.offsetHeight = 300;
  observers[0].callback();
  assert.equal(host.styleProps.get('--resume-toast-top'), '300px', 'kept live by the ResizeObserver');

  first.hide();
  show({ media, position: 10 });
  assert.equal(links().length, 1, 'a second toast reuses the stylesheet');
  await settle();
  flushFrames();
  assert.ok(findByText('Fortgesetzt bei 0:10', host));
  assert.equal(observers[0].disconnected, true, 'hide() disconnects its observer');
});

test('a failed stylesheet load still shows the toast', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // no real 8 s timer outlives a test
  const { host, media, show } = await setup();
  show({ media, position: 5 });
  links()[0].dispatchEvent(new Event('error'));
  await settle();
  assert.ok(toastIn(host));
});

test('role=status is inserted empty and filled on the next animation frame', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // no real 8 s timer outlives a test
  const { host, media, show } = await setup();
  show({ media, position: 754 });
  links()[0].dispatchEvent(new Event('load'));
  await settle();
  const toast = /** @type {FakeNode} */ (toastIn(host));
  assert.equal(toast.getAttribute('role'), 'status');
  assert.equal(toast.children.length, 0);
  flushFrames();
  assert.ok(findByText('Fortgesetzt bei 12:34', toast));
  assert.ok(findByText('Von vorn', toast));
  const close = /** @type {FakeNode[]} */ (toast.children).find((c) => c.getAttribute('aria-label') === 'Hinweis schließen');
  assert.ok(close);
  assert.equal(close.getAttribute('type'), 'button');
});

test('auto-hides after 8 s; paused while pointer over OR focus inside, full 8 s once neither holds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, media, show } = await setup();
  show({ media, position: 754 });
  await loadStylesheet();
  const toast = /** @type {FakeNode} */ (toastIn(host));
  const button = /** @type {FakeNode} */ (findByText('Von vorn', toast));

  fire(toast, 'pointerenter');
  fire(toast, 'focusin');
  fire(toast, 'pointerleave');
  t.mock.timers.tick(20_000);
  assert.equal(toast.parent, host, 'focus still inside keeps it paused after pointerleave');

  fire(toast, 'focusout', button);
  fire(toast, 'focusin');
  t.mock.timers.tick(20_000);
  assert.equal(toast.parent, host, 'focus moving between its own buttons keeps it paused');

  fire(toast, 'pointerenter');
  fire(toast, 'focusout', null);
  t.mock.timers.tick(20_000);
  assert.equal(toast.parent, host, 'pointer still over it keeps it paused after focusout');

  fire(toast, 'pointerleave');
  t.mock.timers.tick(7_999);
  assert.equal(toast.parent, host, 'restarted with a full 8 s');
  t.mock.timers.tick(1);
  assert.equal(toast.parent, null);
});

test('"Von vorn" seeks to 0, closes and focuses the video', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // no real 8 s timer outlives a test
  const { host, media, show } = await setup();
  media.currentTime = 754;
  show({ media, position: 754 });
  await loadStylesheet();
  /** @type {FakeNode} */ (findByText('Von vorn', host)).dispatchEvent(new Event('click'));
  assert.equal(media.currentTime, 0);
  assert.equal(toastIn(host), undefined);
  assert.equal(media.focusCalls, 1);
});

test('"×" and Escape close the toast and return focus to the video', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // no real 8 s timer outlives a test
  for (const how of ['close', 'escape']) {
    const { host, media, show } = await setup();
    show({ media, position: 754 });
    await loadStylesheet();
    const toast = /** @type {FakeNode} */ (toastIn(host));
    if (how === 'close') {
      const close = /** @type {FakeNode[]} */ (toast.children).find((c) => c.getAttribute('aria-label') === 'Hinweis schließen');
      /** @type {FakeNode} */ (close).dispatchEvent(new Event('click'));
    } else {
      fire(toast, 'keydown');
      assert.equal(toast.parent, host, 'only Escape closes');
      toast.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    }
    assert.equal(toast.parent, null, how);
    assert.equal(media.focusCalls, 1, how);
  }
});

test('media emptied/error hide it, also before the stylesheet has loaded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // no real 8 s timer outlives a test
  for (const type of ['emptied', 'error']) {
    const { host, media, show } = await setup();
    show({ media, position: 754 });
    await loadStylesheet();
    media.dispatchEvent(new Event(type));
    assert.equal(toastIn(host), undefined, type);
    assert.equal(media.focusCalls, 0, `${type} never moves focus`);
  }
  const { host, media, show } = await setup();
  show({ media, position: 754 });
  media.dispatchEvent(new Event('error'));
  await loadStylesheet();
  assert.equal(toastIn(host), undefined, 'hidden before insertion stays hidden');
  assert.equal(observers.length, 0, 'no observer was ever started');
});
