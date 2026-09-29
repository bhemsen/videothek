import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  g, Node, net, setup, stopAllPollers, host, entry, answer, controlOf, controlsOf, textOnly, button, buttonText, click, flush, decorate,
} from '../helpers/convert-control-fakes.js';

/**
 * `convert-control.js` (#227): host collection, the first-match control
 * table, batching and the POST error mapping. Poller and race cases live in
 * `convert-control-poller.test.js`; the stylesheet rules in
 * `convert-control-css.test.js`. DOM fakes: `test/helpers/convert-control-fakes.js`.
 */

afterEach(stopAllPollers);

test('no matching host -> no request; a 403, a disabled feature or a failing fetch leaves the page untouched', async () => {
  const { root } = setup();
  root.append(host('div', 'something-else', 99), host('a', 'media-card', 98), host('a', 'episode-row', 97));
  await decorate(root);
  assert.equal(net.calls.length, 0, 'link cards/rows (playable) are never hosts');

  const item = host('div', 'media-card', 1);
  root.append(item);
  net.responder = answer([entry(1, { status: 'none' })]);
  await decorate(root);
  assert.equal(buttonText(item), 'Konvertieren');

  net.responder = async () => ({ status: 403, body: { error: 'forbidden' } });
  await decorate(root);
  assert.equal(buttonText(item), 'Konvertieren', 'untouched after 403');

  net.responder = async () => ({ status: 200, body: { enabled: false, items: [] } });
  await decorate(root);
  assert.equal(buttonText(item), 'Konvertieren', 'untouched while disabled');

  net.responder = async () => { throw new Error('network down'); };
  await decorate(root);
  assert.equal(buttonText(item), 'Konvertieren', 'untouched after a failing fetch');
});

test('a 403 or a disabled feature on a fresh page adds no control and no stylesheet', async () => {
  for (const responder of [
    async () => ({ status: 403, body: { error: 'forbidden' } }),
    async () => ({ status: 200, body: { enabled: false, items: [] } }),
  ]) {
    const { root, head } = setup();
    const item = host('div', 'episode-row', 1);
    root.append(item);
    net.responder = responder;
    await decorate(root);
    assert.equal(net.calls.length, 1);
    assert.equal(controlOf(item), undefined);
    assert.equal(head.children.length, 0, 'no stylesheet injected for a non-admin / disabled feature');
  }
  const { root, head } = setup();
  root.append(host('div', 'media-card', 1));
  net.responder = answer([entry(1)]);
  await decorate(root);
  assert.equal(head.children.length, 1, 'stylesheet injected once controls render');
  assert.equal(/** @type {Node} */ (head.children[0]).getAttribute('href'), '/css/convert-control.css');
});

test('renders the first-match control per status, table row by row, and stays idempotent on re-decoration', async () => {
  const { root } = setup();
  const none = host('div', 'media-card', 1);
  const queued = host('div', 'episode-row', 2);
  const converting = host('div', 'track-row track-row--unplayable', 3);
  const failed = host('div', 'file-row file-row--unplayable', 4);
  const playable = host('div', 'media-card', 5);
  const hidden = host('div', 'media-card', 6);
  const stale = host('li', 'track-row track-row--unplayable', 7);
  const failedGone = host('div', 'media-card', 8);
  const staleGone = host('div', 'media-card', 9);
  const queuedKept = host('div', 'media-card', 10);
  const convertingKept = host('div', 'media-card', 11);
  const playableKept = host('div', 'media-card', 12);
  const noEntry = host('div', 'media-card', 13);
  root.append(none, queued, converting, failed, playable, hidden, stale, failedGone, staleGone, queuedKept, convertingKept, playableKept, noEntry);
  net.responder = answer([
    entry(1, { status: 'none' }), entry(2, { status: 'queued', position: 3 }), entry(3, { status: 'converting' }),
    entry(4, { status: 'failed', error: 'converter_failed' }), entry(5, { status: 'playable' }),
    entry(6, { status: 'none', convertible: false }), entry(7, { status: 'stale' }),
    entry(8, { status: 'failed', error: 'converter_failed', convertible: false }), entry(9, { status: 'stale', convertible: false }),
    entry(10, { status: 'queued', position: 1, convertible: false }), entry(11, { status: 'converting', convertible: false }),
    entry(12, { status: 'playable', convertible: false }),
  ]);
  await decorate(root);
  assert.equal(buttonText(none), 'Konvertieren');
  assert.equal(textOnly(none), '', '`none` shows only the button');
  assert.equal(textOnly(queued), 'In Warteschlange · Platz 3');
  assert.equal(button(queued), undefined);
  assert.equal(textOnly(converting), 'Wird konvertiert …');
  assert.equal(button(converting), undefined);
  assert.equal(textOnly(failed), 'Konvertierung fehlgeschlagen: Der Konverter meldet einen Fehler');
  assert.equal(buttonText(failed), 'Erneut versuchen');
  assert.equal(textOnly(playable), 'Konvertiert');
  assert.equal(buttonText(playable), 'Neu laden');
  assert.equal(buttonText(stale), 'Konvertieren', 'any host tag for the track/file hosts');
  for (const gone of [hidden, failedGone, staleGone, noEntry]) assert.equal(controlOf(gone), undefined);
  assert.equal(textOnly(queuedKept), 'In Warteschlange · Platz 1', 'queued shows regardless of convertible');
  assert.equal(textOnly(convertingKept), 'Wird konvertiert …', 'converting shows regardless of convertible');
  assert.equal(buttonText(playableKept), 'Neu laden', 'playable shows regardless of convertible');

  const status = /** @type {Node} */ (controlOf(queued)?.children[0]);
  assert.equal(status.tagName, 'SPAN');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(button(none)?.getAttribute('class'), 'btn btn-secondary');
  assert.equal(button(none)?.getAttribute('type'), 'button');

  net.responder = answer([entry(1, { status: 'stale' })]);
  await decorate(root);
  assert.equal(controlsOf(none).length, 1);
  assert.equal(buttonText(none), 'Konvertieren');
  assert.equal(root.querySelectorAll('[data-convert-control]').length, 1, 'earlier controls removed');
});

test('splits listConversions into batches of at most 500 ids', async () => {
  const { root } = setup();
  for (let id = 1; id <= 1001; id += 1) root.append(host('div', 'media-card', id));
  await decorate(root);
  const gets = net.calls.filter((c) => c.method === 'GET');
  const counts = gets.map((c) => (new URL(c.url, 'http://x').searchParams.get('ids') ?? '').split(',').length);
  assert.deepEqual(counts, [500, 500, 1]);
});

test('POST error mapping: 409 -> Konvertiert (+ Neu laden reloads), 400/404/503 -> removed, other -> retry enabled; clicks never reach the host', async () => {
  const { root } = setup();
  const hosts = [1, 2, 3, 4, 5].map((id) => host('div', 'media-card', id));
  const [a, b, c, d, e] = hosts;
  let hostClicks = 0;
  for (const h of hosts) h.addEventListener('click', () => { hostClicks += 1; });
  root.addEventListener('click', () => { hostClicks += 1; });
  root.append(...hosts);
  net.responder = answer([1, 2, 3, 4, 5].map((id) => entry(id, { status: id === 5 ? 'failed' : 'none', error: 'converter_failed' })));
  await decorate(root);

  net.postStatus = 409;
  click(button(a));
  await flush();
  assert.equal(textOnly(a), 'Konvertiert');
  assert.equal(buttonText(a), 'Neu laden');
  click(button(a));
  assert.equal(g.location.reloads, 1);

  for (const [status, h] of /** @type {[number, Node][]} */ ([[400, b], [404, c], [503, d]])) {
    net.postStatus = status;
    click(button(h));
    await flush();
    assert.equal(controlOf(h), undefined, `${status} removes the control`);
  }

  net.postStatus = 500;
  const btn = button(e);
  click(btn);
  assert.equal(btn?.disabled, true, 'disabled synchronously on click, before the POST settles');
  await flush();
  assert.equal(textOnly(e), 'Konvertieren nicht möglich. Bitte erneut versuchen.');
  assert.equal(buttonText(e), 'Erneut versuchen', 'same label as before the click');
  assert.equal(button(e)?.disabled, false, 're-enabled after a generic error');
  assert.equal(controlsOf(e).length, 1);

  const posts = net.calls.filter((call) => call.method === 'POST').length;
  click(button(e));
  await flush();
  assert.equal(net.calls.filter((call) => call.method === 'POST').length, posts + 1, 'the retry button POSTs again');
  assert.equal(controlsOf(e).length, 1);
  assert.equal(hostClicks, 0, 'no control click ever reached a host or the root');
});
