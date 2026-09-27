import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { registerHealthRoutes } from '../../src/api/health.js';
import { createRouter } from '../../src/http/router.js';

/**
 * A minimal `ServerResponse` double capturing what `writeHead`/`end` were
 * called with, enough to assert on health.js's own behaviour without a real
 * socket.
 * @returns {{
 *   res: import('node:http').ServerResponse,
 *   status: () => number | undefined,
 *   header: (name: string) => string | undefined,
 *   body: () => string,
 * }}
 */
function createMockRes() {
  /** @type {number | undefined} */
  let status;
  /** @type {Record<string, string>} */
  let headers = {};
  let body = '';
  const res = /** @type {import('node:http').ServerResponse} */ (/** @type {unknown} */ ({
    writeHead: (/** @type {number} */ s, /** @type {Record<string, string>} */ h) => {
      status = s;
      headers = h;
    },
    end: (/** @type {string | undefined} */ chunk) => {
      body = chunk ?? '';
    },
  }));
  return { res, status: () => status, header: (name) => headers[name], body: () => body };
}

test('GET /healthz answers 200 {"status":"ok"} when ping(db) is true', () => {
  const router = createRouter();
  const db = new DatabaseSync(':memory:');
  registerHealthRoutes(router, { db });
  const matched = router.match('GET', '/healthz');
  assert.ok(matched && 'handler' in matched);

  const mock = createMockRes();
  matched.handler(/** @type {any} */ ({}), mock.res, /** @type {any} */ ({}));
  assert.equal(mock.status(), 200);
  assert.deepEqual(JSON.parse(mock.body()), { status: 'ok' });
  assert.equal(mock.header('Cache-Control'), 'no-store');
  db.close();
});

test('GET /healthz answers 503 {"error":"db_unavailable"} when ping(db) is false', () => {
  const router = createRouter();
  const brokenDb = /** @type {import('node:sqlite').DatabaseSync} */ (
    /** @type {unknown} */ ({
      prepare: () => {
        throw new Error('connection down');
      },
    })
  );
  registerHealthRoutes(router, { db: brokenDb });
  const matched = router.match('GET', '/healthz');
  assert.ok(matched && 'handler' in matched);

  const mock = createMockRes();
  matched.handler(/** @type {any} */ ({}), mock.res, /** @type {any} */ ({}));
  assert.equal(mock.status(), 503);
  assert.deepEqual(JSON.parse(mock.body()), { error: 'db_unavailable' });
});

test('HEAD /healthz resolves to the GET handler via the router fallback', () => {
  const router = createRouter();
  const db = new DatabaseSync(':memory:');
  registerHealthRoutes(router, { db });
  const matched = router.match('HEAD', '/healthz');
  assert.ok(matched && 'handler' in matched);
  db.close();
});
