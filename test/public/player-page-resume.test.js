import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeNode, g, install, loadPage, settle, flushFrames, findByText, movie, restoreGlobals, requests, videos,
} from '../helpers/player-page-fakes.js';

/**
 * P4's seam in `public/js/player.js` (spec-progress-resume.md "Player hook",
 * issue #56): `getProgress` in parallel with the item fetch, `startPlayback`
 * only after both settled, a failed progress fetch plays from 0, and
 * `trackPlayback` armed with the fetched entry so the resume seek lands and
 * the resume toast appears right after the `<video>`.
 */

afterEach(restoreGlobals);

const IN_PROGRESS = { itemId: 7, position: 754, duration: 3000, state: 'in_progress', updatedAt: null };

/** @returns {{ promise: Promise<void>, resolve: () => void }} */
function deferred() {
  /** @type {() => void} */
  let resolve = () => {};
  const promise = new Promise((r) => { resolve = () => r(undefined); });
  return { promise, resolve };
}

/** @param {{ readyState: number, duration: number, dispatchEvent: (e: Event) => boolean }} video @returns {void} */
function metadataLoaded(video) {
  video.readyState = 1;
  video.duration = 3000;
  video.dispatchEvent(new Event('loadedmetadata'));
}

/** @returns {FakeNode | undefined} */
function stylesheetLink() {
  return /** @type {FakeNode[]} */ (g.document.head.children).find((c) => c.getAttribute('href') === '/css/resume-toast.css');
}

test('getProgress runs in parallel with the item fetch; nothing plays before it settles', async () => {
  const gate = deferred();
  install({ search: '?id=7', item: movie(), progress: { status: 200, body: IN_PROGRESS }, progressGate: gate.promise });
  await loadPage();
  assert.deepEqual(requests, [
    { url: '/api/library/items/7', method: 'GET' },
    { url: '/api/progress/7', method: 'GET' },
  ]);
  assert.equal(videos.length, 0, 'no <video> (so no autoplay at 0) while progress is pending');

  gate.resolve();
  await settle();
  assert.equal(videos.length, 1);
  assert.equal(videos[0].plays, 1);
  assert.equal(videos[0].attrs.get('src'), '/media/7');
});

test('an in-progress entry is handed to the tracker: resume seek, then the toast right after the video', async () => {
  install({ search: '?id=7', item: movie(), progress: { status: 200, body: IN_PROGRESS } });
  await loadPage();
  const [video] = videos;
  metadataLoaded(video);
  assert.equal(video.currentTime, 754, 'the tracker seeks to the fetched entry');
  assert.equal(requests.filter((r) => r.url.startsWith('/api/progress/')).length, 1, 'the entry is reused, not refetched');

  video.dispatchEvent(new Event('seeked'));
  const link = /** @type {FakeNode} */ (stylesheetLink());
  assert.ok(link, 'the toast injects its stylesheet');
  await settle();
  const host = /** @type {FakeNode} */ (video.parent);
  assert.deepEqual(host.children, [video], 'not inserted before the stylesheet has loaded');

  link.dispatchEvent(new Event('load'));
  await settle();
  flushFrames();
  const toast = /** @type {FakeNode} */ (host.children[host.children.indexOf(video) + 1]);
  assert.equal(toast.getAttribute('class'), 'resume-toast');
  assert.ok(findByText('Fortgesetzt bei 12:34', toast));
  assert.ok(host.classes.has('resume-toast-host'));

  video.error = { code: 4 };
  video.dispatchEvent(new Event('error'));
  await settle();
  assert.equal(toast.parent, null, 'a playback error removes the toast');
});

test('a failed progress fetch plays from 0 without a toast or a player error state', async () => {
  install({ search: '?id=7', item: movie(), progress: { status: 500, body: { error: 'internal' } } });
  await loadPage();
  assert.equal(videos.length, 1);
  const [video] = videos;
  assert.equal(video.plays, 1);
  assert.equal(video.isConnected, true);
  metadataLoaded(video);
  video.dispatchEvent(new Event('seeked'));
  await settle();
  assert.equal(video.currentTime, 0, 'no resume seek');
  assert.equal(stylesheetLink(), undefined, 'no toast');
});

test('a "none" entry starts at 0 and never shows the toast', async () => {
  install({ search: '?id=7', item: movie(), progress: { status: 200, body: { ...IN_PROGRESS, position: 0, state: 'none' } } });
  await loadPage();
  const [video] = videos;
  metadataLoaded(video);
  video.dispatchEvent(new Event('seeked'));
  await settle();
  assert.equal(video.currentTime, 0);
  assert.equal(stylesheetLink(), undefined);
});
