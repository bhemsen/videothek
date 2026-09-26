import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticHandler, sendNotFoundPage } from '../../src/http/static.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/public');

/**
 * Starts a throwaway server wrapping the static handler under test. A
 * request may set `X-Test-Role: admin|user` to simulate an authenticated
 * session — the static handler never resolves sessions itself, that is
 * app.js's job, so the test stands in for it. It also stands in for the
 * app's dispatch "other -> 404 page" branch: `false` (nothing served) from
 * the handler falls through to the same `sendNotFoundPage` app.js reuses,
 * since this suite has no router of its own to produce an `allow` list.
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
async function startServer() {
  const log = { error: () => {} };
  const handler = createStaticHandler({ publicDir: PUBLIC_DIR, log });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const role = req.headers['x-test-role'];
    /** @type {{ id: number, username: string, role: 'admin' | 'user' } | null} */
    const user =
      role === 'admin' || role === 'user' ? { id: 1, username: 'test', role } : null;
    const ctx = { user, params: {}, url, sessionId: user ? 's1' : null };
    const served = await handler(req, res, ctx);
    if (!served) await sendNotFoundPage(req, res, PUBLIC_DIR, log, url.pathname);
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
 * line's target — `fetch` would parse it as a URL first, which for a
 * `%2F`/`%5c`-style encoded segment matters (see the comment above the
 * traversal test cases below); using the same low-level path everywhere
 * keeps this suite's requests uniform. Redirects are never followed.
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

// The Server contract builds `ctx.url` via `new URL(req.url, base)` (as
// this suite's own startServer() does above), and the WHATWG URL spec
// defines a literal `..` *and* a bare `%2e`/`%2e%2e` segment as a
// "double-dot path segment" that path parsing removes unconditionally —
// so `/../package.json` and `/%2e%2e/package.json` never reach static.js
// as anything but `/package.json`; they still prove the traversal attempt
// never resolves to the real fixtures/package.json sentinel one level
// above the served root (they 404 on "no such file inside publicDir",
// not via `isUnsafePath`). `/%2F..` (an encoded slash hiding a `..` that
// only appears after this module's own single decodeURIComponent pass),
// the encoded-backslash chain and the NUL byte are not covered by that
// URL-level normalization and specifically exercise `isUnsafePath` /
// `decodePathname` in static.js itself. `/%E0%A4%A` is malformed
// percent-encoding (an incomplete escape), exercising `decodePathname`'s
// `decodeURIComponent` failure path; `/movies/x` is a multi-segment page
// path, which never matches `PAGE_NAME_PATTERN` or an asset extension.
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
  '/%E0%A4%A',
  '/movies/x',
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

test('the handler resolves false for a missing page, without writing a response', async () => {
  const log = { error: () => {} };
  const handler = createStaticHandler({ publicDir: PUBLIC_DIR, log });
  const req = /** @type {import('node:http').IncomingMessage} */ (/** @type {unknown} */ ({ method: 'GET' }));
  let wrote = false;
  const res = /** @type {import('node:http').ServerResponse} */ (/** @type {unknown} */ ({
    writeHead: () => {
      wrote = true;
    },
    end: () => {
      wrote = true;
    },
  }));
  const ctx = {
    user: /** @type {{ id: number, username: string, role: 'admin' }} */ ({
      id: 1,
      username: 'test',
      role: 'admin',
    }),
    params: {},
    url: new URL('http://localhost/does-not-exist'),
    sessionId: 's1',
  };
  const served = await handler(req, res, ctx);
  assert.equal(served, false);
  assert.equal(wrote, false);
});

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
