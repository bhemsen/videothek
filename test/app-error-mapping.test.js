/**
 * Covers `app.js`'s dispatch error mapping (`handleDispatchError` and the
 * `new URL(...)` parse guard ahead of it) — split out of `app.test.js` to
 * keep that file under the constitution's 300-line cap. Handlers are
 * injected straight onto the running app's own router (`app.router`, from
 * `startTestApp`) rather than adding test-only routes to `src/http/routes.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HttpError } from '../src/http/respond.js';
import { startTestApp } from './helpers/app.js';

/**
 * Issues a raw HTTP request against the running test app, `agent: false` so
 * the socket closes right away and `close()` never hangs waiting on a
 * pooled keep-alive connection.
 * @param {string} baseUrl
 * @param {string} method
 * @param {string} pathname
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
function request(baseUrl, method, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${pathname}`, { method, headers, agent: false }, (res) => {
      const chunks = /** @type {Buffer[]} */ ([]);
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: /** @type {number} */ (res.statusCode),
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

test('a request-target the URL constructor cannot parse answers 404 instead of throwing', async () => {
  // Node's own HTTP parser rejects most malformed request-targets with a
  // `400` before a listener ever runs, so this goes straight at the
  // listener via `server.emit('request', ...)` with a `req.url` value
  // (`new URL('http://localhost:garbage')` reads `:garbage` as an invalid
  // port and throws `Invalid URL`) chosen to reach app.js's own catch.
  const app = await startTestApp();
  try {
    /** @type {{ status: number | undefined, body: string }} */
    const result = await new Promise((resolve) => {
      const fakeReq = { url: ':garbage', method: 'GET', headers: {} };
      /** @type {number | undefined} */
      let status;
      const fakeRes = {
        setHeader() {},
        writeHead(/** @type {number} */ code) {
          status = code;
        },
        end(/** @type {string | undefined} */ body) {
          resolve({ status, body: body ?? '' });
        },
      };
      app.server.emit('request', fakeReq, fakeRes);
    });
    assert.equal(result.status, 404);
    assert.deepEqual(JSON.parse(result.body), { error: 'not_found' });
  } finally {
    await app.close();
  }
});

test('dispatch error mapping: a thrown HttpError is mapped to its own status/code/headers', async () => {
  const app = await startTestApp();
  try {
    app.router.add('GET', '/__test/http-error', () => {
      throw new HttpError(418, 'teapot', { 'X-Test': 'yes' });
    });
    const res = await request(app.baseUrl, 'GET', '/__test/http-error');
    assert.equal(res.status, 418);
    assert.deepEqual(JSON.parse(res.body), { error: 'teapot' });
    assert.equal(res.headers['x-test'], 'yes');
  } finally {
    await app.close();
  }
});

test('dispatch error mapping: a thrown non-HttpError on /api/* answers 500 {"error":"internal"} plus a request_error log line', async () => {
  const app = await startTestApp();
  try {
    app.router.add('GET', '/api/__test/boom', () => {
      throw new Error('boom-api');
    });
    const res = await request(app.baseUrl, 'GET', '/api/__test/boom');
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.body), { error: 'internal' });
    assert.ok(
      app.deps.logLines.some(
        (line) =>
          line.includes('request_error') &&
          line.includes('"method":"GET"') &&
          line.includes('"path":"/api/__test/boom"') &&
          line.includes('boom-api'),
      ),
    );
  } finally {
    await app.close();
  }
});

test('dispatch error mapping: a thrown non-HttpError on a non-GET method answers 500 JSON even off /api/*', async () => {
  const app = await startTestApp();
  try {
    app.router.add('POST', '/__test/boom-post', () => {
      throw new Error('boom-post');
    });
    const host = app.baseUrl.replace('http://', '');
    const res = await request(app.baseUrl, 'POST', '/__test/boom-post', { Origin: `http://${host}` });
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.body), { error: 'internal' });
  } finally {
    await app.close();
  }
});

test('dispatch error mapping: a thrown non-HttpError on a GET page path answers plain German 500 text', async () => {
  const app = await startTestApp();
  try {
    app.router.add('GET', '/__test/boom-page', () => {
      throw new Error('boom-page');
    });
    const res = await request(app.baseUrl, 'GET', '/__test/boom-page');
    assert.equal(res.status, 500);
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(res.body, 'Interner Fehler.');
  } finally {
    await app.close();
  }
});

test('dispatch error mapping: once headers are already sent, a later throw destroys the socket', async () => {
  const app = await startTestApp();
  try {
    app.router.add('GET', '/__test/boom-after-headers', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      throw new Error('boom-after-headers');
    });
    await assert.rejects(() => request(app.baseUrl, 'GET', '/__test/boom-after-headers'));
  } finally {
    await app.close();
  }
});

test('dispatch error mapping: a session store that throws is caught and mapped, not left to crash the process', async () => {
  const throwingSessions = {
    resolve() {
      throw new Error('boom-session');
    },
  };
  const app = await startTestApp({ sessions: throwingSessions });
  try {
    const res = await request(app.baseUrl, 'GET', '/healthz', { Cookie: 'vt_session=anything' });
    assert.equal(res.status, 500);
    assert.equal(res.body, 'Interner Fehler.');
    assert.ok(
      app.deps.logLines.some((line) => line.includes('request_error') && line.includes('boom-session')),
    );
  } finally {
    await app.close();
  }
});
