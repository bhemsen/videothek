import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRouter } from '../../src/http/router.js';
import { registerRoutes } from '../../src/http/routes.js';

test('registerRoutes wires registerHealthRoutes onto the router', () => {
  const router = createRouter();
  const db = new DatabaseSync(':memory:');
  registerRoutes(router, /** @type {any} */ ({ db }));
  const routes = router.routes();
  assert.ok(
    routes.some((route) => route.method === 'GET' && route.pattern === '/healthz'),
    `expected GET /healthz among ${JSON.stringify(routes)}`,
  );
  db.close();
});

test('GET /healthz is reachable through the routes registered by registerRoutes', () => {
  const router = createRouter();
  const db = new DatabaseSync(':memory:');
  registerRoutes(router, /** @type {any} */ ({ db }));
  const matched = router.match('GET', '/healthz');
  assert.ok(matched && 'handler' in matched);
  db.close();
});
