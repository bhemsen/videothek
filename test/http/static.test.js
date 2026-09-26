import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticHandler } from '../../src/http/static.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/public');

/**
 * Starts a throwaway server wrapping the static handler under test. A
 * request may set `X-Test-Role: admin|user` to simulate an authenticated
 * session — the static handler never resolves sessions itself, that is
 * app.js's job, so the test stands in for it.
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
async function startServer() {
  const log = { error: () => {} };
  const handler = createStaticHandler({ publicDir: PUBLIC_DIR, log });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const role = req.headers['x-test-role'];
    /** @type {{ id: number, username: string, role: 'admin' | 'user' } | null} */
    const user =
      role === 'admin' || role === 'user' ? { id: 1, username: 'test', role } : null;
    const ctx = { user, params: {}, url, sessionId: user ? 's1' : null };
    handler(req, res, ctx);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  return {
    port,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

/**
 * Issues a raw HTTP request with `targetPath` sent verbatim as the request
 * line's target — unlike `fetch`, which would parse it as a URL first and
 * silently collapse a `..` segment before the request ever leaves this
 * process, defeating the traversal tests below. Redirects are never
 * followed.
 * @param {number} port
 * @param {string} targetPath
 * @param {{ method?: string, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
function rawRequest(port, targetPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      // `agent: false` disables keep-alive: without it, the pooled socket
      // stays open after the response and `server.close()` in the test's
      // `finally` never resolves (it waits for every connection to end).
      { hostname: '127.0.0.1', port, path: targetPath, method, headers, agent: false },
      (res) => {
        const chunks = /** @type {Buffer[]} */ ([]);
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: /** @type {number} */ (res.statusCode),
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('/ without a session redirects to /login?next=%2F', async () => {
  const server = await startServer();
  try {
    const res = await rawRequest(server.port, '/');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/login?next=%2F');
    assert.equal(res.headers['cache-control'], 'no-store');
  } finally {
    await server.close();
  }
});

test('/ with a session serves index.html', async () => {
  const server = await startServer();
  try {
    const res = await rawRequest(server.port, '/', { headers: { 'X-Test-Role': 'user' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.body, /Start/);
  } finally {
    await server.close();
  }
});

test('a protected page without a session redirects with the encoded path and query as next', async () => {
  const server = await startServer();
  try {
    const res = await rawRequest(server.port, '/movies?tab=new');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/login?next=%2Fmovies%3Ftab%3Dnew');
  } finally {
    await server.close();
  }
});

test('/login without a session serves the login page', async () => {
  const server = await startServer();
  try {
    const res = await rawRequest(server.port, '/login');
    assert.equal(res.status, 200);
    assert.match(res.body, /Anmelden/);
  } finally {
    await server.close();
  }
});

test('/login with a session redirects to safeNext(next)', async () => {
  const server = await startServer();
  try {
    const res = await rawRequest(server.port, '/login?next=%2Fmovies', {
      headers: { 'X-Test-Role': 'user' },
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/movies');
  } finally {
    await server.close();
  }
});

test('/login with a session and an unsafe next falls back to /', async () => {
  const server = await startServer();
  try {
    const res = await rawRequest(server.port, '/login?next=%2F%2Fevil.example', {
      headers: { 'X-Test-Role': 'user' },
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/');
  } finally {
    await server.close();
  }
});

test('/admin without a session redirects to the login page', async () => {
  const server = await startServer();
  try {
    const res = await rawRequest(server.port, '/admin');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/login?next=%2Fadmin');
  } finally {
    await server.close();
  }
});

test('/admin for a non-admin session redirects to /', async () => {
  const server = await startServer();
  try {
    const res = await rawRequest(server.port, '/admin', { headers: { 'X-Test-Role': 'user' } });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/');
  } finally {
    await server.close();
  }
});

test('/admin for an admin session serves the admin page', async () => {
  const server = await startServer();
  try {
    const res = await rawRequest(server.port, '/admin', { headers: { 'X-Test-Role': 'admin' } });
    assert.equal(res.status, 200);
    assert.match(res.body, /Benutzerverwaltung/);
  } finally {
    await server.close();
  }
});

test('an asset is served with no-cache, Last-Modified and no session required', async () => {
  const server = await startServer();
  try {
    const res = await rawRequest(server.port, '/css/tokens.css');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.ok(res.headers['last-modified']);
    assert.match(res.body, /--color-background/);
  } finally {
    await server.close();
  }
});

test('a repeated request with If-Modified-Since answers 304', async () => {
  const server = await startServer();
  try {
    const first = await rawRequest(server.port, '/css/tokens.css');
    const lastModified = first.headers['last-modified'];
    assert.ok(lastModified);

    const second = await rawRequest(server.port, '/css/tokens.css', {
      headers: { 'If-Modified-Since': /** @type {string} */ (lastModified) },
    });
    assert.equal(second.status, 304);
    assert.equal(second.headers['cache-control'], 'no-cache');
    assert.equal(second.body, '');
  } finally {
    await server.close();
  }
});

for (const target of [
  '/../package.json',
  '/%2e%2e/package.json',
  '/%2F..',
  '/css%5c..%5c..%5cpackage.json',
  '/foo%00.css',
  '/.env',
  '/admin.html',
  '/index',
  '/404',
  '/data.bin',
]) {
  test(`${target} -> 404`, async () => {
    const server = await startServer();
    try {
      const res = await rawRequest(server.port, target, { headers: { 'X-Test-Role': 'admin' } });
      assert.equal(res.status, 404);
      assert.match(res.body, /Seite nicht gefunden/);
    } finally {
      await server.close();
    }
  });
}

test('HEAD / with a session sends headers only, no body', async () => {
  const server = await startServer();
  try {
    const res = await rawRequest(server.port, '/', { method: 'HEAD', headers: { 'X-Test-Role': 'user' } });
    assert.equal(res.status, 200);
    assert.equal(res.body, '');
  } finally {
    await server.close();
  }
});
