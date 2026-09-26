import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { request, ApiError, toLogin, safeNext } from '../../public/js/lib/api.js';

/** @type {typeof fetch | undefined} */
let originalFetch;
/** @type {unknown} */
let originalLocation;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalLocation = /** @type {{ location?: unknown }} */ (globalThis).location;
});

afterEach(() => {
  globalThis.fetch = /** @type {typeof fetch} */ (originalFetch);
  /** @type {{ location?: unknown }} */ (globalThis).location = originalLocation;
});

/**
 * Installs a stub `fetch` that resolves once with the given response shape.
 * @param {{ status: number, body?: unknown, headers?: Record<string, string> }} response
 * @returns {{ calls: unknown[][] }}
 */
function stubFetch(response) {
  const calls = /** @type {unknown[][]} */ ([]);
  const headers = new Map(Object.entries(response.headers ?? {}));
  globalThis.fetch = /** @type {typeof fetch} */ (
    /** @param {unknown} input @param {unknown} init */
    async (input, init) => {
      calls.push([input, init]);
      const text = response.body === undefined ? '' : JSON.stringify(response.body);
      return /** @type {Response} */ ({
        status: response.status,
        headers: { get: (/** @type {string} */ name) => headers.get(name) ?? null },
        text: async () => text,
      });
    }
  );
  return { calls };
}

/**
 * Installs a stub `location` and returns the recorded `assign()` calls.
 * @param {{ pathname?: string, search?: string }} [initial]
 * @returns {{ assigned: string[] }}
 */
function stubLocation(initial = {}) {
  const assigned = /** @type {string[]} */ ([]);
  /** @type {{ location?: unknown }} */ (globalThis).location = {
    pathname: initial.pathname ?? '/',
    search: initial.search ?? '',
    assign: (/** @type {string} */ url) => assigned.push(url),
  };
  return { assigned };
}

test('request resolves 2xx JSON responses with status and parsed data', async () => {
  stubFetch({ status: 200, body: { id: 1, username: 'ada' } });
  const result = await request('GET', '/api/me');
  assert.deepEqual(result, { status: 200, data: { id: 1, username: 'ada' } });
});

test('request resolves 204 with null data', async () => {
  stubFetch({ status: 204 });
  const result = await request('POST', '/logout');
  assert.deepEqual(result, { status: 204, data: null });
});

test('request resolves a 2xx response with a non-JSON body as null data', async () => {
  globalThis.fetch = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      async () => ({
        status: 200,
        headers: { get: () => null },
        text: async () => '<html>',
      })
    )
  );
  const result = await request('GET', '/api/me');
  assert.deepEqual(result, { status: 200, data: null });
});

test('request sends credentials, JSON content-type/body and keepalive', async () => {
  const { calls } = stubFetch({ status: 200, body: { ok: true } });
  await request('POST', '/api/progress', { json: { position: 12 }, keepalive: true });
  const [input, init] = calls[0];
  assert.equal(input, '/api/progress');
  assert.equal(/** @type {RequestInit} */ (init).method, 'POST');
  assert.equal(/** @type {RequestInit} */ (init).credentials, 'same-origin');
  assert.equal(/** @type {RequestInit} */ (init).keepalive, true);
  assert.deepEqual(/** @type {RequestInit} */ (init).headers, { 'Content-Type': 'application/json' });
  assert.equal(/** @type {RequestInit} */ (init).body, JSON.stringify({ position: 12 }));
});

test('request throws ApiError with the body error code on a non-2xx response', async () => {
  stubFetch({ status: 409, body: { error: 'username_taken' } });
  await assert.rejects(
    () => request('POST', '/api/users', { json: { username: 'ada' } }),
    (/** @type {unknown} */ err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 409);
      assert.equal(err.code, 'username_taken');
      assert.equal(err.retryAfterSec, null);
      return true;
    },
  );
});

test('request falls back to code "unknown" when the body has no error field', async () => {
  stubFetch({ status: 500, body: {} });
  await assert.rejects(
    () => request('GET', '/api/users'),
    (/** @type {unknown} */ err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, 'unknown');
      return true;
    },
  );
});

test('request falls back to code "unknown" when the body is not JSON', async () => {
  globalThis.fetch = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      async () => ({
        status: 500,
        headers: { get: () => null },
        text: async () => 'not json',
      })
    )
  );
  await assert.rejects(
    () => request('GET', '/api/users'),
    (/** @type {unknown} */ err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, 'unknown');
      return true;
    },
  );
});

test('request parses an integer Retry-After header into retryAfterSec', async () => {
  stubFetch({ status: 429, body: { error: 'too_many_attempts' }, headers: { 'Retry-After': '840' } });
  await assert.rejects(
    () => request('POST', '/login', { json: {}, redirectOn401: false }),
    (/** @type {unknown} */ err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.retryAfterSec, 840);
      return true;
    },
  );
});

test('request yields retryAfterSec null when Retry-After is absent', async () => {
  stubFetch({ status: 429, body: { error: 'too_many_attempts' } });
  await assert.rejects(
    () => request('POST', '/login', { json: {}, redirectOn401: false }),
    (/** @type {unknown} */ err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.retryAfterSec, null);
      return true;
    },
  );
});

test('request yields retryAfterSec null when Retry-After is not an integer', async () => {
  stubFetch({
    status: 429,
    body: { error: 'too_many_attempts' },
    headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' },
  });
  await assert.rejects(
    () => request('POST', '/login', { json: {}, redirectOn401: false }),
    (/** @type {unknown} */ err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.retryAfterSec, null);
      return true;
    },
  );
});

test('request maps a network failure to ApiError({ status: 0, code: "network" })', async () => {
  globalThis.fetch = /** @type {typeof fetch} */ (async () => {
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(
    () => request('GET', '/api/me'),
    (/** @type {unknown} */ err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 0);
      assert.equal(err.code, 'network');
      assert.equal(err.retryAfterSec, null);
      return true;
    },
  );
});

test('request redirects to login on 401 by default', async () => {
  stubFetch({ status: 401, body: { error: 'unauthorized' } });
  const { assigned } = stubLocation({ pathname: '/admin', search: '?tab=users' });
  await assert.rejects(() => request('GET', '/api/users'));
  assert.deepEqual(assigned, ['/login?next=%2Fadmin%3Ftab%3Dusers']);
});

test('request does not redirect on 401 when redirectOn401 is false', async () => {
  stubFetch({ status: 401, body: { error: 'invalid_credentials' } });
  const { assigned } = stubLocation();
  await assert.rejects(
    () => request('POST', '/login', { json: {}, redirectOn401: false }),
    (/** @type {unknown} */ err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, 'invalid_credentials');
      return true;
    },
  );
  assert.deepEqual(assigned, []);
});

test('toLogin navigates to /login with the current path and query as next', () => {
  const { assigned } = stubLocation({ pathname: '/movies', search: '?page=2' });
  toLogin();
  assert.deepEqual(assigned, ['/login?next=%2Fmovies%3Fpage%3D2']);
});

test('safeNext accepts an absolute in-app path', () => {
  assert.equal(safeNext('/admin'), '/admin');
  assert.equal(safeNext('/'), '/');
  assert.equal(safeNext('/movies?page=2'), '/movies?page=2');
});

test('safeNext rejects a protocol-relative target', () => {
  assert.equal(safeNext('//evil.example'), '/');
});

test('safeNext rejects a backslash-based target', () => {
  assert.equal(safeNext('/\\evil.example'), '/');
  assert.equal(safeNext('/a\\b'), '/');
});

test('safeNext rejects a target with a control character', () => {
  assert.equal(safeNext('/a\nb'), '/');
  assert.equal(safeNext('/a\x7fb'), '/');
});

test('safeNext rejects a non-absolute or non-string value', () => {
  assert.equal(safeNext('relative'), '/');
  assert.equal(safeNext(null), '/');
  assert.equal(safeNext(undefined), '/');
  assert.equal(safeNext(''), '/');
});

test('safeNext rejects a target longer than 2048 characters', () => {
  const tooLong = '/' + 'a'.repeat(2048);
  assert.equal(safeNext(tooLong), '/');
  const atLimit = '/' + 'a'.repeat(2047);
  assert.equal(safeNext(atLimit), atLimit);
});
