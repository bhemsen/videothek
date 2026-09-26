/**
 * Security headers, the TLS/origin checks the mutation guard and the static
 * handler build on, and the shared `safeNext` redirect-target validator.
 */

const CSP =
  "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
  "style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; " +
  "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const SAFE_NEXT_MAX_LENGTH = 2048;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * Sets the security headers required on every response: a strict CSP (no
 * inline script/style, no third-party origins), MIME-sniffing protection, a
 * same-origin referrer policy and a legacy frame-ancestors denial. No HSTS —
 * that is the reverse proxy's job. Uses `setHeader` (not `writeHead`) so it
 * can run once, early in dispatch, before the eventual handler sets its own
 * status and headers; Node merges the two.
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
export function applySecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
}

/**
 * Returns the first value of a possibly comma-separated or array-valued
 * header, trimmed; `undefined` when the header is absent.
 * @param {string | string[] | undefined} value
 * @returns {string | undefined}
 */
function firstHeaderValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === undefined ? undefined : raw.split(',')[0].trim();
}

/**
 * True when the connection is TLS-terminated at this process, or the first
 * `X-Forwarded-Proto` value is `https` (a TLS-terminating reverse proxy) —
 * used to decide whether the session cookie gets the `Secure` attribute.
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isHttps(req) {
  const socket = /** @type {{ encrypted?: boolean }} */ (req.socket);
  if (socket.encrypted) return true;
  const forwardedProto = firstHeaderValue(req.headers['x-forwarded-proto']);
  return forwardedProto?.toLowerCase() === 'https';
}

/**
 * Host-only same-origin check for the mutation guard. An absent `Origin` is
 * allowed (curl, CLI — `true`); `Origin: null`, an unparseable value, or a
 * host mismatch against the first `X-Forwarded-Host` (else `Host`) header is
 * rejected (`false`). The scheme is ignored, so a TLS-terminating proxy that
 * does not forward it still passes.
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (origin === 'null') return false;

  let originHost;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const expectedHost =
    firstHeaderValue(req.headers['x-forwarded-host']) ?? firstHeaderValue(req.headers.host);
  return expectedHost !== undefined && originHost === expectedHost.toLowerCase();
}

/**
 * Validates a `next` redirect target: accepted only if it starts with `/`
 * but not `//` or `/\` (protocol-relative / backslash open-redirect
 * tricks), contains no control character or backslash, and is at most 2048
 * characters long; otherwise falls back to `/`. Mirrors the client-side
 * `safeNext` in `public/js/lib/api.js` exactly.
 * @param {string | null | undefined} value
 * @returns {string}
 */
export function safeNext(value) {
  if (
    typeof value === 'string' &&
    value.length <= SAFE_NEXT_MAX_LENGTH &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.startsWith('/\\') &&
    !value.includes('\\') &&
    !CONTROL_CHAR_PATTERN.test(value)
  ) {
    return value;
  }
  return '/';
}
