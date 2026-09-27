/**
 * `POST /login` throttle under concurrency, input bounds (over-long
 * password, over-long/invalid username) and log hygiene. Split from
 * `auth.test.js` to keep both files under the 300-line limit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '../helpers/app.js';
import { request, sessionCookie } from '../helpers/auth-http.js';

const PASSWORD = 'correct-horse-battery';

/**
 * @param {string[]} logLines
 * @param {string} event
 * @returns {Array<Record<string, unknown>>}
 */
function logEntries(logLines, event) {
  return logLines.map((line) => JSON.parse(line)).filter((entry) => entry.event === event);
}

test('parallel wrong-password attempts for one username get at most 5 verifies; the rest answer 429', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('jack', PASSWORD);
    const attempts = Array.from({ length: 12 }, () =>
      request(app.baseUrl, 'POST', '/login', { json: { username: 'jack', password: 'wrong-password' } }),
    );
    const statuses = (await Promise.all(attempts)).map((res) => res.status);
    assert.equal(statuses.filter((s) => s === 401).length, 5, statuses.join(','));
    assert.equal(statuses.filter((s) => s === 429).length, 7, statuses.join(','));
    assert.equal(logEntries(app.deps.logLines, 'login_failed').length, 5);

    // The window is still full, so even the right password is refused now.
    const right = await request(app.baseUrl, 'POST', '/login', { json: { username: 'jack', password: PASSWORD } });
    assert.equal(right.status, 429);
  } finally {
    await app.close();
  }
});

test('a successful login still resets the counter after the attempt was pre-counted', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('kate', PASSWORD);
    for (let i = 0; i < 4; i += 1) {
      const res = await request(app.baseUrl, 'POST', '/login', { json: { username: 'kate', password: 'wrong' } });
      assert.equal(res.status, 401);
    }
    const ok = await request(app.baseUrl, 'POST', '/login', { json: { username: 'kate', password: PASSWORD } });
    assert.equal(ok.status, 200);
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app.baseUrl, 'POST', '/login', { json: { username: 'kate', password: 'wrong' } });
      assert.equal(res.status, 401, `attempt ${i + 1} after the reset`);
    }
  } finally {
    await app.close();
  }
});

test('a throttled login leaves the caller\'s prior session valid', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('liam', PASSWORD);
    const login = await request(app.baseUrl, 'POST', '/login', { json: { username: 'liam', password: PASSWORD } });
    const cookie = sessionCookie(login.headers);
    for (let i = 0; i < 5; i += 1) {
      await request(app.baseUrl, 'POST', '/login', { json: { username: 'liam', password: 'wrong' } });
    }
    const throttled = await request(app.baseUrl, 'POST', '/login', {
      headers: { Cookie: cookie },
      json: { username: 'liam', password: PASSWORD },
    });
    assert.equal(throttled.status, 429);
    assert.equal(throttled.headers['set-cookie'], undefined);

    const me = await request(app.baseUrl, 'GET', '/api/me', { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
  } finally {
    await app.close();
  }
});

test('a password over 256 code points is verified against DUMMY_HASH, never the stored hash', async () => {
  const app = await startTestApp();
  try {
    // The helper hashes without validating, so the stored hash really
    // matches this over-long password; only the dummy-hash path rejects it.
    const longPassword = 'p'.repeat(257);
    await app.createUser('mona', longPassword);
    const res = await request(app.baseUrl, 'POST', '/login', { json: { username: 'mona', password: longPassword } });
    assert.equal(res.status, 401);
    assert.deepEqual(JSON.parse(res.body), { error: 'invalid_credentials' });
  } finally {
    await app.close();
  }
});

test('an over-long username is rejected as unknown and logged and throttled by a 64-code-point prefix', async () => {
  const app = await startTestApp();
  try {
    const longName = 'n'.repeat(5000);
    for (let i = 0; i < 5; i += 1) {
      // Each attempt differs after the prefix, yet all share one throttle key.
      const res = await request(app.baseUrl, 'POST', '/login', {
        json: { username: `${longName}${i}`, password: 'wrong-password' },
      });
      assert.equal(res.status, 401);
    }
    const sixth = await request(app.baseUrl, 'POST', '/login', { json: { username: longName, password: 'x' } });
    assert.equal(sixth.status, 429);

    const users = [
      ...logEntries(app.deps.logLines, 'login_failed'),
      ...logEntries(app.deps.logLines, 'login_throttled'),
    ].map((entry) => entry.user);
    assert.equal(users.length, 6);
    for (const user of users) assert.equal(user, 'n'.repeat(64));
  } finally {
    await app.close();
  }
});

test('no log line contains a session token or a password', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('nina', PASSWORD);
    await request(app.baseUrl, 'POST', '/login', { json: { username: 'nina', password: 'wrong-password' } });
    const login = await request(app.baseUrl, 'POST', '/login', { json: { username: 'nina', password: PASSWORD } });
    const cookie = sessionCookie(login.headers);
    const token = cookie.slice('vt_session='.length);
    assert.ok(token.length > 0);
    const logout = await request(app.baseUrl, 'POST', '/logout', { headers: { Cookie: cookie } });
    assert.equal(logout.status, 204);

    assert.ok(app.deps.logLines.length >= 3);
    for (const line of app.deps.logLines) {
      assert.ok(!line.includes(token), `token leaked: ${line}`);
      assert.ok(!line.includes(PASSWORD) && !line.includes('wrong-password'), `password leaked: ${line}`);
    }
  } finally {
    await app.close();
  }
});
