import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { startTestApp } from '../helpers/app.js';

/**
 * Issues a raw HTTP request against the running test app, optionally with a
 * JSON body (sets `Content-Type`/`Content-Length` and parses the response
 * body as JSON when present).
 * @param {string} baseUrl
 * @param {string} method
 * @param {string} pathname
 * @param {{ headers?: Record<string, string>, json?: unknown }} [options]
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, data: unknown }>}
 */
function request(baseUrl, method, pathname, { headers = {}, json } = {}) {
  const payload = json === undefined ? undefined : JSON.stringify(json);
  const reqHeaders = { ...headers };
  if (payload !== undefined) {
    reqHeaders['Content-Type'] = 'application/json';
    reqHeaders['Content-Length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${pathname}`, { method, headers: reqHeaders, agent: false }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: /** @type {number} */ (res.statusCode),
          headers: res.headers,
          data: body.length > 0 ? JSON.parse(body) : null,
        });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * Casts a response body to a plain object, for a partial `deepEqual` shape check.
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asObject(value) {
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * A minimal `ServerResponse` double capturing status/body (same style as
 * `test/api/health.test.js`'s), for driving a registered handler directly.
 * @returns {{ res: import('node:http').ServerResponse, status: () => number | undefined, data: () => unknown }}
 */
function mockRes() {
  /** @type {number | undefined} */
  let status;
  let body = '';
  const res = /** @type {import('node:http').ServerResponse} */ (/** @type {unknown} */ ({
    writeHead: (/** @type {number} */ s) => (status = s),
    end: (/** @type {string | undefined} */ chunk) => (body = chunk ?? ''),
  }));
  return { res, status: () => status, data: () => (body.length > 0 ? JSON.parse(body) : null) };
}

/**
 * A minimal `IncomingMessage` double satisfying `readJson` (headers plus
 * `data`/`end` events), for driving a route handler without a real socket.
 * @param {unknown} json
 * @returns {import('node:http').IncomingMessage}
 */
function fakeJsonReq(json) {
  const body = Buffer.from(JSON.stringify(json));
  const emitter = new EventEmitter();
  const headers = { 'content-type': 'application/json', 'content-length': String(body.length) };
  const req = /** @type {import('node:http').IncomingMessage} */ (/** @type {unknown} */ (Object.assign(emitter, { headers })));
  queueMicrotask(() => {
    emitter.emit('data', body);
    emitter.emit('end');
  });
  return req;
}

/**
 * Drives `method`'s registered handler (incl. `requireAdmin`) directly,
 * twice: first as real admin `a` acting on `b` (must succeed), then as `b`
 * acting on `a` with a ctx still saying `role: 'admin'` even though `a`'s
 * call already demoted/deleted `b` — exactly what a genuinely concurrent
 * second request's already-resolved ctx.user snapshot would hold (app.js
 * never re-reads it mid-handler). Reproduces the interleaving
 * `setRoleGuarded`/`deleteUserGuarded`'s transaction guards against (see
 * `test/db/users.test.js`'s DB-level "concurrent demotion" test) without two
 * real HTTP round trips having to interleave in time.
 * @param {Awaited<ReturnType<typeof startTestApp>>} app
 * @param {'PATCH' | 'DELETE'} method
 * @param {{ id: number, username: string }} a
 * @param {{ id: number, username: string }} b
 * @returns {Promise<{ first: ReturnType<typeof mockRes>, second: ReturnType<typeof mockRes> }>}
 */
async function raceLastAdmin(app, method, a, b) {
  const match = (/** @type {number} */ id) =>
    /** @type {{ handler: import('../../src/http/router.js').Handler }} */ (app.router.match(method, `/api/users/${id}`));
  const fakeReq = () => (method === 'PATCH' ? fakeJsonReq({ role: 'user' }) : /** @type {any} */ ({}));
  const ctx = (/** @type {{ id: number, username: string }} */ user, /** @type {number} */ targetId, /** @type {string} */ sid) => ({
    user: { id: user.id, username: user.username, role: /** @type {'admin'} */ ('admin') },
    params: { id: String(targetId) },
    url: new URL(`${app.baseUrl}/api/users/${targetId}`),
    sessionId: sid,
  });
  const first = mockRes();
  await match(b.id).handler(fakeReq(), first.res, ctx(a, b.id, 'session-a'));
  const second = mockRes();
  await match(a.id).handler(fakeReq(), second.res, ctx(b, a.id, 'session-b'));
  return { first, second };
}

/**
 * Boots the test app with one bootstrap admin, logged in.
 * @returns {Promise<{
 *   app: Awaited<ReturnType<typeof startTestApp>>,
 *   adminCookie: string,
 *   adminId: number,
 * }>}
 */
async function setup() {
  const app = await startTestApp();
  const admin = await app.createUser('root', 'ein-sicheres-passwort', 'admin');
  const adminCookie = await app.login('root', 'ein-sicheres-passwort');
  return { app, adminCookie, adminId: admin.id };
}

test('non-admin (and anonymous) requests get 403/401 on every /api/users* route, never the handler', async () => {
  const { app, adminId } = await setup();
  try {
    await app.createUser('julia', 'ein-sicheres-passwort', 'user');
    const userCookie = await app.login('julia', 'ein-sicheres-passwort');
    const routes = /** @type {const} */ ([
      ['GET', '/api/users'],
      ['POST', '/api/users'],
      ['PUT', `/api/users/${adminId}/password`],
      ['PATCH', `/api/users/${adminId}`],
      ['DELETE', `/api/users/${adminId}`],
    ]);
    for (const [method, pathname] of routes) {
      const res = await request(app.baseUrl, method, pathname, { headers: { Cookie: userCookie } });
      assert.equal(res.status, 403, `${method} ${pathname}`);
      assert.deepEqual(res.data, { error: 'forbidden' });
    }
  } finally {
    await app.close();
  }
});

test('GET /api/users lists every user ordered by username with the public shape', async () => {
  const { app, adminCookie } = await setup();
  try {
    await app.createUser('zoe', 'ein-sicheres-passwort', 'user');
    await app.createUser('alice', 'ein-sicheres-passwort', 'user');
    const res = await request(app.baseUrl, 'GET', '/api/users', { headers: { Cookie: adminCookie } });
    assert.equal(res.status, 200);
    const usernames = /** @type {{ username: string }[]} */ (res.data).map((u) => u.username);
    assert.deepEqual(usernames, ['alice', 'root', 'zoe']);
    const row = /** @type {any[]} */ (res.data)[0];
    assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'id', 'role', 'username']);
    assert.match(row.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await app.close();
  }
});

test('POST /api/users validates fields in order, creates (role defaults to user), rejects a duplicate username, and logs', async () => {
  const { app, adminCookie } = await setup();
  try {
    const headers = { Cookie: adminCookie };
    const badCases = [
      [{ password: 'ein-passwort', role: 'user' }, 'invalid_username'],
      [{ username: 'a b', password: 'ein-passwort' }, 'invalid_username'],
      [{ username: 'julia', password: 'short' }, 'invalid_password'],
      [{ username: 'julia', password: 'ein-passwort', role: 'superadmin' }, 'invalid_role'],
    ];
    for (const [json, code] of badCases) {
      const res = await request(app.baseUrl, 'POST', '/api/users', { headers, json });
      assert.equal(res.status, 400, JSON.stringify(json));
      assert.deepEqual(res.data, { error: code });
    }

    const created = await request(app.baseUrl, 'POST', '/api/users', { headers, json: { username: 'Julia', password: 'ein-sicheres-passwort' } });
    assert.equal(created.status, 201);
    assert.deepEqual(created.data, { ...asObject(created.data), username: 'julia', role: 'user' });
    assert.ok(app.deps.logLines.some((l) => l.includes('"event":"user_created"') && l.includes('"user":"julia"') && l.includes('"by":"root"')));

    const dup = await request(app.baseUrl, 'POST', '/api/users', { headers, json: { username: 'julia', password: 'ein-anderes-passwort' } });
    assert.equal(dup.status, 409);
    assert.deepEqual(dup.data, { error: 'username_taken' });
  } finally {
    await app.close();
  }
});

test('PUT .../password: validates, 404s unknown/non-integer ids, revokes the target\'s other sessions (keeping the caller\'s own), and logs', async () => {
  const { app, adminCookie, adminId } = await setup();
  try {
    const headers = { Cookie: adminCookie };
    const bad = await request(app.baseUrl, 'PUT', `/api/users/${adminId}/password`, { headers, json: { password: 'x' } });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.data, { error: 'invalid_password' });
    for (const id of ['999999', 'not-a-number']) {
      const res = await request(app.baseUrl, 'PUT', `/api/users/${id}/password`, { headers, json: { password: 'ein-sicheres-passwort' } });
      assert.equal(res.status, 404, id);
      assert.deepEqual(res.data, { error: 'not_found' });
    }

    // Admin resets julia's password: julia's session must die.
    const julia = await app.createUser('julia', 'altes-passwort', 'user');
    const juliaCookie = await app.login('julia', 'altes-passwort');
    const secondAdminCookie = await app.login('root', 'ein-sicheres-passwort');
    const res = await request(app.baseUrl, 'PUT', `/api/users/${julia.id}/password`, { headers, json: { password: 'neues-passwort-123' } });
    assert.equal(res.status, 204);
    assert.equal((await request(app.baseUrl, 'GET', '/api/users', { headers: { Cookie: juliaCookie } })).status, 401);
    assert.ok(app.deps.logLines.some((l) => l.includes('"event":"password_reset"') && l.includes('"user":"julia"') && l.includes('"by":"root"')));

    // Admin resets their own password: the OTHER session dies, but the
    // session making this very request survives.
    const selfReset = await request(app.baseUrl, 'PUT', `/api/users/${adminId}/password`, { headers, json: { password: 'root-neu-123' } });
    assert.equal(selfReset.status, 204);
    assert.equal((await request(app.baseUrl, 'GET', '/api/users', { headers })).status, 200);
    assert.equal((await request(app.baseUrl, 'GET', '/api/users', { headers: { Cookie: secondAdminCookie } })).status, 401);
  } finally {
    await app.close();
  }
});

test('PATCH /api/users/:id validates the role, 404s an unknown id, no-ops on the same role, and logs an actual change', async () => {
  const { app, adminCookie, adminId } = await setup();
  try {
    const headers = { Cookie: adminCookie };
    const julia = await app.createUser('julia', 'ein-sicheres-passwort', 'user');

    const badRole = await request(app.baseUrl, 'PATCH', `/api/users/${julia.id}`, { headers, json: { role: 'root' } });
    assert.equal(badRole.status, 400);
    assert.deepEqual(badRole.data, { error: 'invalid_role' });

    const unknown = await request(app.baseUrl, 'PATCH', '/api/users/999999', { headers, json: { role: 'admin' } });
    assert.equal(unknown.status, 404);

    const noop = await request(app.baseUrl, 'PATCH', `/api/users/${julia.id}`, { headers, json: { role: 'user' } });
    assert.equal(noop.status, 200);
    assert.deepEqual(noop.data, { ...asObject(noop.data), role: 'user' });
    assert.ok(!app.deps.logLines.some((l) => l.includes('"event":"role_changed"')));

    const changed = await request(app.baseUrl, 'PATCH', `/api/users/${julia.id}`, { headers, json: { role: 'admin' } });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.data, { ...asObject(changed.data), role: 'admin' });
    assert.ok(app.deps.logLines.some((l) => l.includes('"event":"role_changed"') && l.includes('"user":"julia"') && l.includes('"by":"root"')));

    const own = await request(app.baseUrl, 'PATCH', `/api/users/${adminId}`, { headers, json: { role: 'user' } });
    assert.equal(own.status, 409);
    assert.deepEqual(own.data, { error: 'cannot_change_own_role' });

    // root and julia (promoted above via `changed`) are now the only two
    // admins - a concurrent-demotion race between them must refuse exactly
    // one side with last_admin (see raceLastAdmin's doc comment).
    const { first, second } = await raceLastAdmin(app, 'PATCH', { id: adminId, username: 'root' }, julia);
    assert.equal(first.status(), 200);
    assert.equal(second.status(), 409);
    assert.deepEqual(second.data(), { error: 'last_admin' });
  } finally {
    await app.close();
  }
});

test('DELETE /api/users/:id: 404s unknown id, refuses self-delete, deletes otherwise (logging), and concurrent last_admin', async () => {
  const { app, adminCookie, adminId } = await setup();
  try {
    const headers = { Cookie: adminCookie };
    const unknown = await request(app.baseUrl, 'DELETE', '/api/users/999999', { headers });
    assert.equal(unknown.status, 404);

    const self = await request(app.baseUrl, 'DELETE', `/api/users/${adminId}`, { headers });
    assert.equal(self.status, 409);
    assert.deepEqual(self.data, { error: 'cannot_delete_self' });

    const mia = await app.createUser('mia', 'ein-sicheres-passwort', 'user');
    const ok = await request(app.baseUrl, 'DELETE', `/api/users/${mia.id}`, { headers });
    assert.equal(ok.status, 204);
    assert.ok(app.deps.logLines.some((l) => l.includes('"event":"user_deleted"') && l.includes('"user":"mia"') && l.includes('"by":"root"')));

    // root + a freshly promoted julia are now the only two admins - a
    // concurrent delete-each-other race must refuse exactly one as last_admin.
    const julia = await app.createUser('julia', 'ein-sicheres-passwort', 'admin');
    const { first, second } = await raceLastAdmin(app, 'DELETE', { id: adminId, username: 'root' }, julia);
    assert.equal(first.status(), 204);
    assert.equal(second.status(), 409);
    assert.deepEqual(second.data(), { error: 'last_admin' });
  } finally {
    await app.close();
  }
});
