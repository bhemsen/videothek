import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  net, setup, stopAllPollers, host, entry, answer, controlOf, controlsOf, textOnly, button, buttonText, click, flush, decorate, gate,
} from '../helpers/convert-control-fakes.js';

/**
 * `convert-poller.js` + the decorator's per-root race guards (#227). Split
 * out of `convert-control.test.js` (300-line cap); DOM fakes:
 * `test/helpers/convert-control-fakes.js`.
 */

afterEach(stopAllPollers);

/** A GET responder that counts its calls. @param {() => { status: number, body: unknown }} make */
function counting(make) {
  const fn = async () => { fn.count += 1; return make(); };
  fn.count = 0;
  return fn;
}

const queuedBody = () => ({ status: 200, body: { enabled: true, items: [entry(1, { status: 'queued', position: 1 })] } });

/** @param {import('node:test').TestContext} t @returns {Promise<void>} */
async function tick5s(t) {
  t.mock.timers.tick(5000);
  await flush();
}

test('the poller pauses while hidden, survives a transient error, stops for good on 401, and stops once disconnected', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { root, body } = setup();
  body.append(root);
  const item = host('div', 'media-card', 1);
  root.append(item);
  const queued = counting(queuedBody);
  net.responder = queued;
  await decorate(root);
  assert.equal(queued.count, 1);

  const { document } = /** @type {any} */ (globalThis);
  document.hidden = true;
  await tick5s(t);
  assert.equal(queued.count, 1, 'paused while hidden');
  document.hidden = false;
  await tick5s(t);
  assert.equal(queued.count, 2, 'resumes once visible again');

  const failing = counting(() => { throw new Error('network down'); });
  net.responder = failing;
  await tick5s(t);
  await tick5s(t);
  assert.equal(failing.count, 2, 'a transient error keeps the interval running');
  assert.equal(textOnly(item), 'In Warteschlange · Platz 1', 'a failed poll keeps the last rendered state');

  const unauthorized = counting(() => ({ status: 401, body: { error: 'unauthorized' } }));
  net.responder = unauthorized;
  await tick5s(t);
  await tick5s(t);
  assert.equal(unauthorized.count, 1, 'stopped for good after 401');

  net.responder = queued;
  await decorate(root); // re-arms the poller
  const before = queued.count;
  root.remove();
  await tick5s(t);
  assert.equal(queued.count, before, 'no poll once disconnected');
});

test('a 403 poll stops the poller for good; a finished entry stops it too', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { root, body } = setup();
  body.append(root);
  const item = host('div', 'media-card', 1);
  root.append(item);
  net.responder = answer([entry(1, { status: 'queued', position: 2 })]);
  await decorate(root);

  const forbidden = counting(() => ({ status: 403, body: { error: 'forbidden' } }));
  net.responder = forbidden;
  await tick5s(t);
  await tick5s(t);
  assert.equal(forbidden.count, 1, 'stopped for good after 403');

  net.responder = answer([entry(1, { status: 'converting' })]);
  await decorate(root);
  const done = counting(() => ({ status: 200, body: { enabled: true, items: [entry(1, { status: 'playable' })] } }));
  net.responder = done;
  await tick5s(t);
  assert.equal(buttonText(item), 'Neu laden', 'the poll re-renders the host');
  await tick5s(t);
  assert.equal(done.count, 1, 'nothing active any more -> no further poll');
});

test('re-decorating a root cancels its active poller; a stale tick never stops the new one', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { root, body } = setup();
  body.append(root);
  root.append(host('div', 'media-card', 1));
  net.responder = answer([entry(1, { status: 'queued', position: 1 })]);
  await decorate(root);

  const idle = counting(() => ({ status: 200, body: { enabled: true, items: [entry(1, { status: 'none' })] } }));
  net.responder = idle;
  await decorate(root);
  assert.equal(idle.count, 1);
  await tick5s(t);
  await tick5s(t);
  assert.equal(idle.count, 1, 'the previous poller is gone and the new decoration has nothing active');

  net.responder = answer([entry(1, { status: 'queued', position: 1 })]);
  await decorate(root);
  const held = gate();
  net.responder = async () => { await held.promise; return { status: 401, body: { error: 'unauthorized' } }; };
  t.mock.timers.tick(5000); // old poller's tick now in flight
  await flush();
  const fresh = counting(queuedBody);
  net.responder = fresh;
  await decorate(root);
  held.release();
  await flush();
  await tick5s(t);
  assert.equal(fresh.count, 2, 'the new poller survived the stale 401 tick');
});

test('a POST that settles after a re-decoration is dropped: no second control, no stale error text', async () => {
  const { root } = setup();
  const item = host('div', 'media-card', 1);
  root.append(item);
  net.responder = answer([entry(1, { status: 'none' })]);
  await decorate(root);

  const held = gate();
  net.postGate = held.promise;
  net.postStatus = 500;
  click(button(item));
  await decorate(root);
  held.release();
  await flush();
  assert.equal(controlsOf(item).length, 1);
  assert.equal(textOnly(item), '', 'the stale generic error was not rendered');
  assert.equal(buttonText(item), 'Konvertieren');
  assert.equal(button(item)?.disabled, false, 'the new control is untouched');
});

test('a successful POST re-renders from the returned entry and arms the poller', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { root, body } = setup();
  body.append(root);
  const item = host('div', 'media-card', 1);
  root.append(item);
  net.responder = answer([entry(1, { status: 'none' })]);
  await decorate(root);
  net.postBody = entry(1, { status: 'queued', position: 4 });
  click(button(item));
  await flush();
  assert.equal(textOnly(item), 'In Warteschlange · Platz 4');
  const polled = counting(queuedBody);
  net.responder = polled;
  await tick5s(t);
  assert.equal(polled.count, 1, 'polling started because an entry is now queued');
});

test('overlapping decorations that resolve out of order keep the newest result', async () => {
  const { root } = setup();
  const item = host('div', 'media-card', 1);
  root.append(item);
  const held = gate();
  net.responder = async () => {
    await held.promise;
    return { status: 200, body: { enabled: true, items: [entry(1, { status: 'failed', error: 'converter_failed' })] } };
  };
  const older = decorate(root);
  net.responder = answer([entry(1, { status: 'none' })]);
  await decorate(root);
  held.release();
  await older;
  assert.equal(controlsOf(item).length, 1);
  assert.equal(buttonText(item), 'Konvertieren', 'the older response was dropped');
  assert.notEqual(controlOf(item), undefined);
});
