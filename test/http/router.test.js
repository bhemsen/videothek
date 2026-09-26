import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../../src/http/router.js';

/**
 * @typedef {import('../../src/http/router.js').Handler} Handler
 */

/** @type {Handler} */
const noop = () => {};

test('matches a literal route with no params', () => {
  const router = createRouter();
  router.add('GET', '/api/me', noop);

  const result = router.match('GET', '/api/me');
  assert.deepEqual(result, { handler: noop, params: {} });
});

test('matches a param route and decodes the segment', () => {
  const router = createRouter();
  router.add('GET', '/api/users/:id', noop);

  const result = router.match('GET', '/api/users/julia%20m');
  assert.deepEqual(result, { handler: noop, params: { id: 'julia m' } });
});

test('matching is whole-segment: an extra segment does not match', () => {
  const router = createRouter();
  router.add('GET', '/media/:id', noop);

  assert.equal(router.match('GET', '/media/1/thumb'), null);
});

test('root pattern "/" matches only the empty path', () => {
  const router = createRouter();
  router.add('GET', '/', noop);

  assert.deepEqual(router.match('GET', '/'), { handler: noop, params: {} });
  assert.equal(router.match('GET', '/foo'), null);
});

test('trailing slash is a distinct, significant pattern', () => {
  const router = createRouter();
  router.add('GET', '/foo', noop);

  assert.equal(router.match('GET', '/foo/'), null);
});

test('query string is not part of pathname matching (caller strips it)', () => {
  const router = createRouter();
  router.add('GET', '/foo', noop);

  // The router only ever sees a pathname; a literal "?x=1" would be an
  // extra, non-matching segment content, proving no implicit stripping here.
  assert.equal(router.match('GET', '/foo?x=1'), null);
});

test('malformed percent-encoding in a param segment yields no match', () => {
  const router = createRouter();
  router.add('GET', '/api/users/:id', noop);

  assert.equal(router.match('GET', '/api/users/%zz'), null);
});

test('an empty param segment (e.g. a trailing slash) yields no match', () => {
  const router = createRouter();
  router.add('GET', '/api/users/:id', noop);

  assert.equal(router.match('GET', '/api/users/'), null);
});

test('a literal segment beats a param at the same position', () => {
  const router = createRouter();
  /** @type {Handler} */
  const paramHandler = () => {};
  /** @type {Handler} */
  const literalHandler = () => {};
  router.add('GET', '/media/:id', paramHandler);
  router.add('GET', '/media/download', literalHandler);

  const result = router.match('GET', '/media/download');
  assert.equal(result && 'handler' in result && result.handler, literalHandler);

  const paramResult = router.match('GET', '/media/42');
  assert.equal(paramResult && 'handler' in paramResult && paramResult.handler, paramHandler);
});

test('duplicate (method, pattern) registration throws', () => {
  const router = createRouter();
  router.add('GET', '/api/me', noop);
  assert.throws(() => router.add('GET', '/api/me', noop));
});

test('the same pattern may be registered under different methods', () => {
  const router = createRouter();
  router.add('GET', '/api/users', noop);
  assert.doesNotThrow(() => router.add('POST', '/api/users', noop));
});

test('unregistered path yields null, not an allow list', () => {
  const router = createRouter();
  router.add('GET', '/api/me', noop);
  assert.equal(router.match('GET', '/nope'), null);
});

test('a path matching other methods yields { allow }, GET implies HEAD', () => {
  const router = createRouter();
  router.add('GET', '/api/users', noop);
  router.add('POST', '/api/users', noop);

  const result = router.match('DELETE', '/api/users');
  assert.deepEqual(result, { allow: ['GET', 'HEAD', 'POST'] });
});

test('{ allow } omits HEAD when GET is not registered', () => {
  const router = createRouter();
  router.add('POST', '/api/users', noop);

  const result = router.match('DELETE', '/api/users');
  assert.deepEqual(result, { allow: ['POST'] });
});

test('HEAD falls back to the GET handler when no explicit HEAD route exists', () => {
  const router = createRouter();
  /** @type {Handler} */
  const getHandler = () => {};
  router.add('GET', '/api/me', getHandler);

  const result = router.match('HEAD', '/api/me');
  assert.equal(result && 'handler' in result && result.handler, getHandler);
});

test('an explicit HEAD route wins over the GET fallback', () => {
  const router = createRouter();
  /** @type {Handler} */
  const getHandler = () => {};
  /** @type {Handler} */
  const headHandler = () => {};
  router.add('GET', '/api/me', getHandler);
  router.add('HEAD', '/api/me', headHandler);

  const result = router.match('HEAD', '/api/me');
  assert.equal(result && 'handler' in result && result.handler, headHandler);
});

test('method matching is case-insensitive', () => {
  const router = createRouter();
  router.add('get', '/api/me', noop);

  assert.deepEqual(router.match('GET', '/api/me'), { handler: noop, params: {} });
});

test('routes() lists every registered route with its original pattern', () => {
  const router = createRouter();
  router.add('GET', '/api/me', noop);
  router.add('POST', '/login', noop);

  assert.deepEqual(router.routes(), [
    { method: 'GET', pattern: '/api/me' },
    { method: 'POST', pattern: '/login' },
  ]);
});
