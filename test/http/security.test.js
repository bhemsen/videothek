import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySecurityHeaders, isHttps, isSameOrigin, safeNext } from '../../src/http/security.js';

/**
 * A minimal `ServerResponse` test double capturing headers set via
 * `setHeader`.
 * @returns {any}
 */
function makeRes() {
  /** @type {any} */
  const res = { headers: /** @type {Record<string, string>} */ ({}) };
  res.setHeader = (/** @type {string} */ name, /** @type {string} */ value) => {
    res.headers[name] = value;
  };
  return res;
}

/**
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {{ encrypted?: boolean }} [socket]
 * @returns {import('node:http').IncomingMessage}
 */
function makeReq(headers, socket = {}) {
  return /** @type {any} */ ({ headers, socket });
}

test('applySecurityHeaders sets the exact CSP, nosniff, referrer policy and frame options', () => {
  const res = makeRes();
  applySecurityHeaders(res);

  assert.equal(
    res.headers['Content-Security-Policy'],
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
      "style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; " +
      "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(res.headers['Referrer-Policy'], 'same-origin');
  assert.equal(res.headers['X-Frame-Options'], 'DENY');
  assert.equal(res.headers['Strict-Transport-Security'], undefined);
});

test('isHttps is true for a TLS socket', () => {
  assert.equal(isHttps(makeReq({}, { encrypted: true })), true);
});

test('isHttps is true for the first X-Forwarded-Proto value https (case-insensitive)', () => {
  assert.equal(isHttps(makeReq({ 'x-forwarded-proto': 'HTTPS, http' })), true);
});

test('isHttps is false without TLS or a matching forwarded proto', () => {
  assert.equal(isHttps(makeReq({})), false);
  assert.equal(isHttps(makeReq({ 'x-forwarded-proto': 'http' })), false);
});

test('isSameOrigin allows a missing Origin header', () => {
  assert.equal(isSameOrigin(makeReq({ host: 'videothek.local' })), true);
});

test('isSameOrigin rejects Origin: null', () => {
  assert.equal(isSameOrigin(makeReq({ origin: 'null', host: 'videothek.local' })), false);
});

test('isSameOrigin rejects an unparseable Origin', () => {
  assert.equal(isSameOrigin(makeReq({ origin: 'not-a-url', host: 'videothek.local' })), false);
});

test('isSameOrigin rejects a foreign Origin', () => {
  assert.equal(
    isSameOrigin(makeReq({ origin: 'http://evil.example', host: 'videothek.local' })),
    false,
  );
});

test('isSameOrigin accepts a matching Origin against Host', () => {
  assert.equal(
    isSameOrigin(makeReq({ origin: 'https://videothek.local', host: 'videothek.local' })),
    true,
  );
});

test('isSameOrigin honours X-Forwarded-Host over Host', () => {
  assert.equal(
    isSameOrigin(
      makeReq({
        origin: 'https://videothek.example',
        host: 'internal:8080',
        'x-forwarded-host': 'videothek.example',
      }),
    ),
    true,
  );
});

test('isSameOrigin ignores scheme, comparing host only', () => {
  assert.equal(
    isSameOrigin(makeReq({ origin: 'http://videothek.local:8080', host: 'videothek.local:8080' })),
    true,
  );
});

test('isSameOrigin matches when a proxy forwards the https default port explicitly', () => {
  assert.equal(
    isSameOrigin(
      makeReq({ origin: 'https://videothek.example', 'x-forwarded-host': 'videothek.example:443' }),
    ),
    true,
  );
});

test('isSameOrigin matches when a proxy forwards the http default port explicitly', () => {
  assert.equal(
    isSameOrigin(makeReq({ origin: 'http://videothek.example', host: 'videothek.example:80' })),
    true,
  );
});

test('isSameOrigin matches when the Origin itself carries an explicit default port', () => {
  assert.equal(
    isSameOrigin(makeReq({ origin: 'https://videothek.example:443', host: 'videothek.example' })),
    true,
  );
});

test('safeNext accepts a plain absolute path', () => {
  assert.equal(safeNext('/movies'), '/movies');
});

test('safeNext falls back to / for a protocol-relative path', () => {
  assert.equal(safeNext('//evil.example'), '/');
});

test('safeNext falls back to / for a backslash-prefixed path', () => {
  assert.equal(safeNext('/\\evil.example'), '/');
});

test('safeNext falls back to / for a path containing a backslash', () => {
  assert.equal(safeNext('/a\\b'), '/');
});

test('safeNext falls back to / for a path containing a control character', () => {
  assert.equal(safeNext('/a\nb'), '/');
});

test('safeNext falls back to / for a value not starting with /', () => {
  assert.equal(safeNext('evil.example'), '/');
});

test('safeNext falls back to / for an oversized value', () => {
  assert.equal(safeNext(`/${'a'.repeat(2049)}`), '/');
});

test('safeNext falls back to / for null or undefined', () => {
  assert.equal(safeNext(null), '/');
  assert.equal(safeNext(undefined), '/');
});
