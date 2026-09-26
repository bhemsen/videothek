/**
 * Machine-checked constitution rule: every route registered via
 * `registerRoutes` — except the public exceptions below — answers `401
 * {"error":"unauthorized"}` when called without a session. Reads the route
 * list from a throwaway router registration (not the running app's own
 * internal one, which `createApp` does not expose), so a later phase's new
 * `register<X>Routes` call is picked up automatically the moment it is
 * wired into `src/http/routes.js` — no edit needed here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRouter } from '../src/http/router.js';
import { registerRoutes } from '../src/http/routes.js';
import { startTestApp } from './helpers/app.js';

const PUBLIC_EXCEPTIONS = new Set(['GET /healthz', 'HEAD /healthz', 'POST /login']);

/**
 * Substitutes `1` for every `:param` segment of a route pattern, per the
 * constitution's machine-checked rule.
 * @param {string} pattern
 * @returns {string}
 */
function concretePath(pattern) {
  return pattern
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '1' : segment))
    .join('/');
}

/**
 * @param {string} baseUrl
 * @param {string} method
 * @param {string} pathname
 * @returns {Promise<{ status: number, body: string }>}
 */
function request(baseUrl, method, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${pathname}`, { method, agent: false }, (res) => {
      const chunks = /** @type {Buffer[]} */ ([]);
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: /** @type {number} */ (res.statusCode), body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

test('every registered route except the public exceptions requires a session', async () => {
  const app = await startTestApp();
  try {
    const probeRouter = createRouter();
    registerRoutes(probeRouter, app.deps);
    const routes = probeRouter.routes();
    assert.ok(routes.length > 0, 'expected at least one registered route to check');

    for (const { method, pattern } of routes) {
      const key = `${method} ${pattern}`;
      if (PUBLIC_EXCEPTIONS.has(key)) continue;
      const res = await request(app.baseUrl, method, concretePath(pattern));
      assert.equal(res.status, 401, `${key} -> expected 401, got ${res.status}`);
      assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' }, `${key} body`);
    }
  } finally {
    await app.close();
  }
});
