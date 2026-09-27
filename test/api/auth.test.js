/**
 * `POST /login`, `POST /logout`, `GET /api/me` — session cookie, throttling
 * and fixation-defence scenarios. Uses the raw `http` request helper other
 * `startTestApp`-based tests already share (see `test/app.test.js`); the
 * restart test builds its own `createApp` pair against one `DATA_DIR`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashPassword } from '../../src/auth/password.js';
import { createApp } from '../../src/app.js';
import { migrate, openDatabase } from '../../src/db/index.js';
import { insertUser } from '../../src/db/users.js';
import { createLogger } from '../../src/log.js';
import { startTestApp } from '../helpers/app.js';

const PASSWORD = 'correct-horse-battery';

/**
 * @param {string} baseUrl
 * @param {string} method
 * @param {string} pathname
 * @param {{ headers?: Record<string, string>, json?: unknown }} [options]
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
function request(baseUrl, method, pathname, { headers = {}, json } = {}) {
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
function setCookies(headers) {
  return headers['set-cookie'] ?? [];
}

/**
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @returns {string}
 */
function sessionCookie(headers) {
  const cookie = setCookies(headers).find((c) => c.startsWith('vt_session='));
  assert.ok(cookie, `expected a vt_session Set-Cookie among ${JSON.stringify(setCookies(headers))}`);
  return /** @type {string} */ (cookie).split(';')[0];
}

test('correct credentials answer 200 with the user and a session cookie; GET /api/me then works', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', PASSWORD);
    const login = await request(app.baseUrl, 'POST', '/login', { json: { username: 'alice', password: PASSWORD } });
    assert.equal(login.status, 200);
    assert.deepEqual(JSON.parse(login.body), { id: 1, username: 'alice', role: 'user' });
    const cookie = sessionCookie(login.headers);
    assert.match(cookie, /^vt_session=/);
    assert.ok(app.deps.logLines.some((line) => line.includes('login_ok')));

    const me = await request(app.baseUrl, 'GET', '/api/me', { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
    assert.deepEqual(JSON.parse(me.body), { id: 1, username: 'alice', role: 'user' });
  } finally {
    await app.close();
  }
});

test('a malformed body answers 400 invalid_json; wrong password and an unknown user both answer 401', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('bob', PASSWORD);
    const noBody = await request(app.baseUrl, 'POST', '/login', { json: { username: 'bob' } });
    assert.equal(noBody.status, 400);
    assert.deepEqual(JSON.parse(noBody.body), { error: 'invalid_json' });

    const wrongPassword = await request(app.baseUrl, 'POST', '/login', {
      json: { username: 'bob', password: 'wrong-password' },
    });
    assert.equal(wrongPassword.status, 401);
    assert.deepEqual(JSON.parse(wrongPassword.body), { error: 'invalid_credentials' });
    assert.ok(app.deps.logLines.some((line) => line.includes('login_failed') && line.includes('"user":"bob"')));
    assert.ok(!app.deps.logLines.some((line) => line.includes('wrong-password')));

    const unknownUser = await request(app.baseUrl, 'POST', '/login', {
      json: { username: 'nobody', password: 'irrelevant' },
    });
    assert.equal(unknownUser.status, 401);
    assert.deepEqual(JSON.parse(unknownUser.body), { error: 'invalid_credentials' });
  } finally {
    await app.close();
  }
});

test('the 6th failed attempt for a username within the window answers 429 with Retry-After, even for the right password', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('carol', PASSWORD);
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app.baseUrl, 'POST', '/login', { json: { username: 'carol', password: 'wrong' } });
      assert.equal(res.status, 401);
    }
    const sixth = await request(app.baseUrl, 'POST', '/login', { json: { username: 'carol', password: 'wrong' } });
    assert.equal(sixth.status, 429);
    assert.deepEqual(JSON.parse(sixth.body), { error: 'too_many_attempts' });
    const retryAfter = Number(sixth.headers['retry-after']);
    assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 900, String(sixth.headers['retry-after']));
    assert.ok(app.deps.logLines.some((line) => line.includes('login_throttled')));

    const stillThrottled = await request(app.baseUrl, 'POST', '/login', {
      json: { username: 'carol', password: PASSWORD },
    });
    assert.equal(stillThrottled.status, 429);
  } finally {
    await app.close();
  }
});

test('a successful login revokes the caller\'s prior session (fixation defence)', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('dana', PASSWORD);
    const first = await request(app.baseUrl, 'POST', '/login', { json: { username: 'dana', password: PASSWORD } });
    const firstCookie = sessionCookie(first.headers);

    const second = await request(app.baseUrl, 'POST', '/login', {
      headers: { Cookie: firstCookie },
      json: { username: 'dana', password: PASSWORD },
    });
    const secondCookie = sessionCookie(second.headers);
    assert.notEqual(secondCookie, firstCookie);

    const meWithFirst = await request(app.baseUrl, 'GET', '/api/me', { headers: { Cookie: firstCookie } });
    assert.equal(meWithFirst.status, 401);
    const meWithSecond = await request(app.baseUrl, 'GET', '/api/me', { headers: { Cookie: secondCookie } });
    assert.equal(meWithSecond.status, 200);
  } finally {
    await app.close();
  }
});

test('a failed login attempt while a valid session cookie is present leaves that session valid', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('erin', PASSWORD);
    const login = await request(app.baseUrl, 'POST', '/login', { json: { username: 'erin', password: PASSWORD } });
    const cookie = sessionCookie(login.headers);

    const failed = await request(app.baseUrl, 'POST', '/login', {
      headers: { Cookie: cookie },
      json: { username: 'erin', password: 'wrong-password' },
    });
    assert.equal(failed.status, 401);

    const me = await request(app.baseUrl, 'GET', '/api/me', { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
  } finally {
    await app.close();
  }
});

test('the session cookie is HttpOnly/SameSite=Lax/Max-Age=2592000 and Secure only when forwarded as https', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('frank', PASSWORD);
    const plain = await request(app.baseUrl, 'POST', '/login', { json: { username: 'frank', password: PASSWORD } });
    const plainCookie = /** @type {string} */ (setCookies(plain.headers).find((c) => c.startsWith('vt_session=')));
    assert.match(plainCookie, /HttpOnly/);
    assert.match(plainCookie, /SameSite=Lax/);
    assert.match(plainCookie, /Max-Age=2592000/);
    assert.doesNotMatch(plainCookie, /Secure/);

    const secure = await request(app.baseUrl, 'POST', '/login', {
      headers: { 'X-Forwarded-Proto': 'https' },
      json: { username: 'frank', password: PASSWORD },
    });
    const secureCookie = /** @type {string} */ (setCookies(secure.headers).find((c) => c.startsWith('vt_session=')));
    assert.match(secureCookie, /Secure/);
  } finally {
    await app.close();
  }
});

test('logout answers 204 and clears the cookie; logging out again with the same cookie answers 401', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('gina', PASSWORD);
    const login = await request(app.baseUrl, 'POST', '/login', { json: { username: 'gina', password: PASSWORD } });
    const cookie = sessionCookie(login.headers);

    const logout = await request(app.baseUrl, 'POST', '/logout', { headers: { Cookie: cookie } });
    assert.equal(logout.status, 204);
    assert.equal(logout.body, '');
    const cleared = /** @type {string} */ (setCookies(logout.headers).find((c) => c.startsWith('vt_session=')));
    assert.match(cleared, /Max-Age=0/);
    assert.ok(app.deps.logLines.some((line) => line.includes('"event":"logout"')));

    const again = await request(app.baseUrl, 'POST', '/logout', { headers: { Cookie: cookie } });
    assert.equal(again.status, 401);
    assert.deepEqual(JSON.parse(again.body), { error: 'unauthorized' });

    const me = await request(app.baseUrl, 'GET', '/api/me', { headers: { Cookie: cookie } });
    assert.equal(me.status, 401);
    assert.deepEqual(JSON.parse(me.body), { error: 'unauthorized' });
  } finally {
    await app.close();
  }
});

test('a foreign Origin on POST /logout is rejected 403 before the session is touched', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('holly', PASSWORD);
    const login = await request(app.baseUrl, 'POST', '/login', { json: { username: 'holly', password: PASSWORD } });
    const cookie = sessionCookie(login.headers);

    const res = await request(app.baseUrl, 'POST', '/logout', {
      headers: { Cookie: cookie, Origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(JSON.parse(res.body), { error: 'forbidden_origin' });

    const me = await request(app.baseUrl, 'GET', '/api/me', { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
  } finally {
    await app.close();
  }
});

/**
 * @param {import('node:http').Server} server
 * @returns {Promise<string>}
 */
function listenAndBaseUrl(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

test('a session survives an app restart against the same DATA_DIR', async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'videothek-auth-restart-'));
  const mediaRoot = path.join(tempRoot, 'media');
  mkdirSync(mediaRoot, { recursive: true });
  const dataDir = path.join(tempRoot, 'data');
  const config = /** @type {any} */ ({ mediaRoot, dataDir });
  try {
    let db = openDatabase(dataDir);
    migrate(db);
    insertUser(db, {
      username: 'ivan',
      passwordHash: await hashPassword(PASSWORD),
      role: 'user',
      createdAt: Date.now(),
    });
    let app = createApp({ config, db, log: createLogger({ out: { write() {} }, err: { write() {} } }) });
    let baseUrl = await listenAndBaseUrl(app.server);
    const login = await request(baseUrl, 'POST', '/login', { json: { username: 'ivan', password: PASSWORD } });
    const cookie = sessionCookie(login.headers);
    await app.close();
    db.close();

    db = openDatabase(dataDir);
    migrate(db);
    app = createApp({ config, db, log: createLogger({ out: { write() {} }, err: { write() {} } }) });
    baseUrl = await listenAndBaseUrl(app.server);
    const me = await request(baseUrl, 'GET', '/api/me', { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
    assert.deepEqual(JSON.parse(me.body), { id: 1, username: 'ivan', role: 'user' });
    await app.close();
    db.close();
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
