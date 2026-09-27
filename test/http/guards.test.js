import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireUser, requireAdmin } from '../../src/http/guards.js';

/**
 * @typedef {import('../../src/http/router.js').RequestContext} RequestContext
 */

/**
 * A minimal `ServerResponse` test double capturing what was sent. Typed
 * `any` so assertions can read back the captured `statusCode`/`headers`/
 * `body` fields a real `ServerResponse` does not expose.
 * @returns {any}
 */
function makeRes() {
  /** @type {any} */
  const res = { statusCode: undefined, headers: undefined, body: undefined };
  res.writeHead = (/** @type {number} */ status, /** @type {Record<string, string>} */ headers) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.end = (/** @type {string | undefined} */ chunk) => {
    res.body = chunk;
  };
  return res;
}

/** @type {import('node:http').IncomingMessage} */
const fakeReq = /** @type {any} */ ({});

/**
 * @param {RequestContext['user']} user
 * @returns {RequestContext}
 */
function makeCtx(user) {
  return { user, params: {}, url: new URL('http://x/'), sessionId: user ? 's1' : null };
}

test('requireUser answers 401 unauthorized when ctx.user is null', () => {
  let called = false;
  const handler = requireUser(() => {
    called = true;
  });
  const res = makeRes();

  handler(fakeReq, res, makeCtx(null));

  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body, JSON.stringify({ error: 'unauthorized' }));
});

test('requireUser calls the handler when a user is present', async () => {
  const ctx = makeCtx({ id: 1, username: 'julia', role: 'user' });
  /** @type {RequestContext | undefined} */
  let received;
  const handler = requireUser((req, res, c) => {
    received = c;
    return Promise.resolve();
  });

  await handler(fakeReq, makeRes(), ctx);
  assert.equal(received, ctx);
});

test('requireAdmin answers 401 unauthorized when ctx.user is null (not 403)', () => {
  let called = false;
  const handler = requireAdmin(() => {
    called = true;
  });
  const res = makeRes();

  handler(fakeReq, res, makeCtx(null));

  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body, JSON.stringify({ error: 'unauthorized' }));
});

test('requireAdmin answers 403 forbidden for a non-admin user', () => {
  let called = false;
  const handler = requireAdmin(() => {
    called = true;
  });
  const res = makeRes();

  handler(fakeReq, res, makeCtx({ id: 1, username: 'julia', role: 'user' }));

  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, JSON.stringify({ error: 'forbidden' }));
});

test('requireAdmin calls the handler for an admin user', () => {
  let called = false;
  const handler = requireAdmin(() => {
    called = true;
  });

  handler(fakeReq, makeRes(), makeCtx({ id: 1, username: 'admin', role: 'admin' }));

  assert.equal(called, true);
});
