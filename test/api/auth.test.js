/**
 * `POST /login`, `POST /logout`, `GET /api/me` — session cookie, throttling
 * and fixation-defence scenarios (concurrent throttling, log hygiene and
 * input-bound cases live in `auth-throttle.test.js`). The restart test
 * builds its own `createApp` pair against one `DATA_DIR`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashPassword } from '../../src/auth/password.js';
import { createApp } from '../../src/app.js';
import { migrate, openDatabase } from '../../src/db/index.js';
import { insertUser } from '../../src/db/users.js';
import { createLogger } from '../../src/log.js';
import { startTestApp } from '../helpers/app.js';
import { request, sessionCookie, sessionSetCookie } from '../helpers/auth-http.js';

const PASSWORD = 'correct-horse-battery';

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
    const failed = app.deps.logLines.map((line) => JSON.parse(line)).find((entry) => entry.event === 'login_failed');
    assert.equal(failed?.user, 'bob');
    assert.equal(failed?.ip, '127.0.0.1');
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
    const plainCookie = sessionSetCookie(plain.headers);
    assert.match(plainCookie, /HttpOnly/);
    assert.match(plainCookie, /SameSite=Lax/);
    assert.match(plainCookie, /Max-Age=2592000/);
    assert.doesNotMatch(plainCookie, /Secure/);

    const secure = await request(app.baseUrl, 'POST', '/login', {
      headers: { 'X-Forwarded-Proto': 'https' },
      json: { username: 'frank', password: PASSWORD },
    });
    const secureCookie = sessionSetCookie(secure.headers);
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
    assert.match(sessionSetCookie(logout.headers), /Max-Age=0/);
    assert.ok(app.deps.logLines.some((line) => line.includes('"event":"logout"')));

    const again = await request(app.baseUrl, 'POST', '/logout', { headers: { Cookie: cookie } });
    assert.equal(again.status, 401);
    assert.deepEqual(JSON.parse(again.body), { error: 'unauthorized' });
    assert.match(sessionSetCookie(again.headers), /Max-Age=0/);

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
  const config = /** @type {any} */ ({ mediaRoot, dataDir: path.join(tempRoot, 'data') });
  /** @type {Array<() => unknown>} releases the running instance, newest first */
  const cleanups = [];
  const stop = async () => {
    for (let fn = cleanups.pop(); fn; fn = cleanups.pop()) await fn();
  };
  const boot = async () => {
    const db = openDatabase(config.dataDir);
    cleanups.push(() => db.close());
    migrate(db);
    const app = createApp({ config, db, log: createLogger({ out: { write() {} }, err: { write() {} } }) });
    const baseUrl = await listenAndBaseUrl(app.server);
    cleanups.push(() => app.close());
    return { db, baseUrl };
  };
  try {
    const first = await boot();
    const passwordHash = await hashPassword(PASSWORD);
    insertUser(first.db, { username: 'ivan', passwordHash, role: 'user', createdAt: Date.now() });
    const login = await request(first.baseUrl, 'POST', '/login', { json: { username: 'ivan', password: PASSWORD } });
    const cookie = sessionCookie(login.headers);
    await stop();

    const second = await boot();
    const me = await request(second.baseUrl, 'GET', '/api/me', { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
    assert.deepEqual(JSON.parse(me.body), { id: 1, username: 'ivan', role: 'user' });
  } finally {
    // Server and DB are released even when an assertion failed, so the temp
    // dir removal cannot hit a locked DB file (EBUSY on Windows).
    await stop();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
