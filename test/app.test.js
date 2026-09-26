import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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

/**
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @returns {string[]}
 */
function setCookies(headers) {
  const raw = headers['set-cookie'];
  return raw ?? [];
}

test('createApp wires config/db/log/now/sessions and passes extra deps through', async () => {
  const app = await startTestApp({ library: { marker: 'p2-placeholder' } });
  try {
    assert.equal(app.deps.config, app.config);
    assert.equal(app.deps.db, app.db);
    assert.equal(typeof app.deps.now, 'function');
    assert.equal(typeof app.deps.sessions.create, 'function');
    assert.deepEqual(app.deps.library, { marker: 'p2-placeholder' });
  } finally {
    await app.close();
  }
});

test('every response carries the security headers', async () => {
  const app = await startTestApp();
  try {
    const res = await request(app.baseUrl, 'GET', '/healthz');
    assert.match(String(res.headers['content-security-policy']), /default-src 'self'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'same-origin');
    assert.equal(res.headers['x-frame-options'], 'DENY');
  } finally {
    await app.close();
  }
});

test('GET /healthz answers 200 without a session', async () => {
  const app = await startTestApp();
  try {
    const res = await request(app.baseUrl, 'GET', '/healthz');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { status: 'ok' });
  } finally {
    await app.close();
  }
});

test('HEAD /healthz answers 200 with no body', async () => {
  const app = await startTestApp();
  try {
    const res = await request(app.baseUrl, 'HEAD', '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body, '');
  } finally {
    await app.close();
  }
});

test('POST /healthz (method mismatch on a registered route) answers 405 + Allow', async () => {
  const app = await startTestApp();
  try {
    const res = await request(app.baseUrl, 'POST', '/healthz');
    assert.equal(res.status, 405);
    assert.match(String(res.headers.allow), /GET/);
    assert.match(String(res.headers.allow), /HEAD/);
  } finally {
    await app.close();
  }
});

test('an unregistered /api/* path answers 404 {"error":"not_found"}, no session required', async () => {
  const app = await startTestApp();
  try {
    const res = await request(app.baseUrl, 'GET', '/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.deepEqual(JSON.parse(res.body), { error: 'not_found' });
  } finally {
    await app.close();
  }
});

test('an unknown non-API path serves the 404 page', async () => {
  const app = await startTestApp();
  try {
    const res = await request(app.baseUrl, 'GET', '/does-not-exist');
    assert.equal(res.status, 404);
    assert.match(res.body, /Seite nicht gefunden/);
  } finally {
    await app.close();
  }
});

test('a static asset is reachable through the app dispatch without a session', async () => {
  const app = await startTestApp();
  try {
    const res = await request(app.baseUrl, 'GET', '/css/tokens.css');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/css; charset=utf-8');
  } finally {
    await app.close();
  }
});

test('/ without a session redirects to /login?next=%2F', async () => {
  const app = await startTestApp();
  try {
    const res = await request(app.baseUrl, 'GET', '/');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/login?next=%2F');
  } finally {
    await app.close();
  }
});

test('/ with a valid session cookie serves the home page', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('julia', 'ein-sicheres-passwort');
    const cookie = await app.login('julia', 'ein-sicheres-passwort');
    const res = await request(app.baseUrl, 'GET', '/', { Cookie: cookie });
    assert.equal(res.status, 200);
    assert.match(res.body, /Start/);
  } finally {
    await app.close();
  }
});

test('an invalid session cookie is cleared and the request is treated as anonymous', async () => {
  const app = await startTestApp();
  try {
    const res = await request(app.baseUrl, 'GET', '/', { Cookie: 'vt_session=not-a-real-token' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/login?next=%2F');
    assert.ok(setCookies(res.headers).some((c) => c.startsWith('vt_session=;') && c.includes('Max-Age=0')));
  } finally {
    await app.close();
  }
});

test('a session close to its 30-day idle expiry is refreshed (cookie re-sent)', async () => {
  let currentTime = Date.parse('2026-01-01T00:00:00Z');
  const app = await startTestApp({ now: () => currentTime });
  try {
    await app.createUser('julia', 'ein-sicheres-passwort');
    const cookie = await app.login('julia', 'ein-sicheres-passwort');
    currentTime += 29.5 * 24 * 60 * 60 * 1000; // inside the 29-day refresh threshold
    const res = await request(app.baseUrl, 'GET', '/healthz', { Cookie: cookie });
    assert.equal(res.status, 200);
    assert.ok(setCookies(res.headers).some((c) => c.startsWith('vt_session=') && !c.includes('Max-Age=0')));
  } finally {
    await app.close();
  }
});

test('a fresh session is not refreshed (no Set-Cookie)', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('julia', 'ein-sicheres-passwort');
    const cookie = await app.login('julia', 'ein-sicheres-passwort');
    const res = await request(app.baseUrl, 'GET', '/healthz', { Cookie: cookie });
    assert.equal(setCookies(res.headers).length, 0);
  } finally {
    await app.close();
  }
});

test('mutation guard: a cross-origin POST is rejected before route matching (even to an unregistered path)', async () => {
  const app = await startTestApp();
  try {
    const res = await request(app.baseUrl, 'POST', '/anything', { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.deepEqual(JSON.parse(res.body), { error: 'forbidden_origin' });
  } finally {
    await app.close();
  }
});

test('mutation guard: a same-origin POST passes through to normal dispatch (404, not 403)', async () => {
  const app = await startTestApp();
  try {
    const host = app.baseUrl.replace('http://', '');
    const res = await request(app.baseUrl, 'POST', '/anything', { Origin: `http://${host}` });
    assert.equal(res.status, 404);
  } finally {
    await app.close();
  }
});

test('mutation guard: a POST without an Origin header is allowed through (curl/CLI)', async () => {
  const app = await startTestApp();
  try {
    const res = await request(app.baseUrl, 'POST', '/anything');
    assert.equal(res.status, 404);
  } finally {
    await app.close();
  }
});

test('close() stops the server: a subsequent request fails to connect', async () => {
  const app = await startTestApp();
  await app.close();
  await assert.rejects(() => request(app.baseUrl, 'GET', '/healthz'));
});
