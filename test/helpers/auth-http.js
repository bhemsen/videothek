/**
 * Raw `node:http` request helper plus `Set-Cookie` accessors shared by the
 * `POST /login` / `POST /logout` / `GET /api/me` tests. A raw request (no
 * `fetch`) keeps full control over `Cookie`/`Origin` headers.
 */

import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * @param {string} baseUrl
 * @param {string} method
 * @param {string} pathname
 * @param {{ headers?: Record<string, string>, json?: unknown }} [options]
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
export function request(baseUrl, method, pathname, { headers = {}, json } = {}) {
  return new Promise((resolve, reject) => {
    const body = json === undefined ? undefined : JSON.stringify(json);
    const reqHeaders = body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' };
    const req = http.request(`${baseUrl}${pathname}`, { method, headers: reqHeaders, agent: false }, (res) => {
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
    req.end(body);
  });
}

/**
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @returns {string[]}
 */
export function setCookies(headers) {
  return headers['set-cookie'] ?? [];
}

/**
 * The full `vt_session` `Set-Cookie` line (with attributes); fails the test
 * when the response set none.
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @returns {string}
 */
export function sessionSetCookie(headers) {
  const cookie = setCookies(headers).find((c) => c.startsWith('vt_session='));
  assert.ok(cookie, `expected a vt_session Set-Cookie among ${JSON.stringify(setCookies(headers))}`);
  return /** @type {string} */ (cookie);
}

/**
 * The `vt_session=<token>` pair from a response, ready for a `Cookie` header.
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @returns {string}
 */
export function sessionCookie(headers) {
  return sessionSetCookie(headers).split(';')[0];
}
