import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  HttpError,
  sendJson,
  sendError,
  sendNoContent,
  redirect,
  readJson,
} from '../../src/http/respond.js';

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

/**
 * A minimal `IncomingMessage` test double streaming a fixed body.
 * @param {Record<string, string>} headers
 * @param {(Buffer | string)[]} [bodyChunks]
 * @returns {import('node:http').IncomingMessage}
 */
function makeReq(headers, bodyChunks = []) {
  // objectMode: false makes Readable.from push each chunk through Buffer
  // encoding, matching how a real IncomingMessage emits Buffer chunks.
  const req = /** @type {any} */ (Readable.from(bodyChunks, { objectMode: false }));
  req.headers = headers;
  return req;
}

test('HttpError carries status, code and headers', () => {
  const err = new HttpError(429, 'too_many_attempts', { 'Retry-After': '60' });
  assert.equal(err.status, 429);
  assert.equal(err.code, 'too_many_attempts');
  assert.deepEqual(err.headers, { 'Retry-After': '60' });
});

test('HttpError defaults headers to an empty object', () => {
  const err = new HttpError(404, 'not_found');
  assert.deepEqual(err.headers, {});
});

test('sendJson sets no-store JSON headers and the serialized body', () => {
  const res = makeRes();
  sendJson(res, 200, { id: 1 });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.body, JSON.stringify({ id: 1 }));
});

test('sendError sends { error: code } and merges extra headers', () => {
  const res = makeRes();
  sendError(res, 405, 'method_not_allowed', { Allow: 'GET, HEAD' });

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers.Allow, 'GET, HEAD');
  assert.equal(res.body, JSON.stringify({ error: 'method_not_allowed' }));
});

test('sendNoContent sends an empty 204', () => {
  const res = makeRes();
  sendNoContent(res);

  assert.equal(res.statusCode, 204);
  assert.equal(res.body, undefined);
});

test('redirect defaults to 302 and sets Location', () => {
  const res = makeRes();
  redirect(res, '/login');

  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, '/login');
});

test('redirect accepts a custom status', () => {
  const res = makeRes();
  redirect(res, '/', 301);

  assert.equal(res.statusCode, 301);
});

test('readJson resolves undefined when there is no body', async () => {
  const req = makeReq({});
  assert.equal(await readJson(req), undefined);
});

test('readJson resolves undefined for a zero Content-Length', async () => {
  const req = makeReq({ 'content-length': '0' });
  assert.equal(await readJson(req), undefined);
});

test('readJson rejects 415 for a non-JSON content type', async () => {
  const req = makeReq(
    { 'content-length': '2', 'content-type': 'text/plain' },
    ['{}'],
  );
  await assert.rejects(readJson(req), (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 415);
    assert.equal(err.code, 'unsupported_media_type');
    return true;
  });
});

test('readJson accepts a Content-Type with charset parameters', async () => {
  const body = JSON.stringify({ a: 1 });
  const req = makeReq(
    { 'content-length': String(body.length), 'content-type': 'application/json; charset=utf-8' },
    [body],
  );
  assert.deepEqual(await readJson(req), { a: 1 });
});

test('readJson rejects 413 for a body over the limit', async () => {
  const body = JSON.stringify({ a: 'x'.repeat(50) });
  const req = makeReq(
    { 'content-length': String(body.length), 'content-type': 'application/json' },
    [body],
  );
  await assert.rejects(readJson(req, { limit: 10 }), (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 413);
    assert.equal(err.code, 'payload_too_large');
    return true;
  });
});

test('readJson rejects 400 for invalid JSON', async () => {
  const req = makeReq(
    { 'content-length': '9', 'content-type': 'application/json' },
    ['not-json}'],
  );
  await assert.rejects(readJson(req), (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_json');
    return true;
  });
});

test('readJson treats a Transfer-Encoding header as a body present', async () => {
  const body = JSON.stringify({ ok: true });
  const req = makeReq(
    { 'transfer-encoding': 'chunked', 'content-type': 'application/json' },
    [body],
  );
  assert.deepEqual(await readJson(req), { ok: true });
});
