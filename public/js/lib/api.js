/**
 * JSON API client. Every page script talks to the server exclusively through
 * `request()` — no other module calls `fetch` directly.
 */

/**
 * @typedef {{ status: number, data: unknown }} ApiResponse
 */

/**
 * Thrown by `request()` for any non-2xx response or a network failure.
 */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {number | null} retryAfterSec
   */
  constructor(status, code, retryAfterSec) {
    super(code);
    this.name = 'ApiError';
    /** @type {number} */
    this.status = status;
    /** @type {string} */
    this.code = code;
    /** @type {number | null} */
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * Sends a JSON API request and resolves with its parsed response.
 * @param {string} method
 * @param {string} path
 * @param {{ json?: unknown, keepalive?: boolean, redirectOn401?: boolean }} [opts]
 * @returns {Promise<ApiResponse>}
 */
export async function request(method, path, opts = {}) {
  const { json, keepalive, redirectOn401 = true } = opts;
  /** @type {Response} */
  let response;
  try {
    response = await fetch(path, buildRequestInit(method, json, keepalive));
  } catch {
    throw new ApiError(0, 'network', null);
  }
  if (response.status >= 200 && response.status < 300) {
    return { status: response.status, data: await parseBody(response) };
  }
  const error = await buildApiError(response);
  if (response.status === 401 && redirectOn401) {
    toLogin();
  }
  throw error;
}

/**
 * @param {string} method
 * @param {unknown} json
 * @param {boolean | undefined} keepalive
 * @returns {RequestInit}
 */
function buildRequestInit(method, json, keepalive) {
  /** @type {RequestInit} */
  const init = { method, credentials: 'same-origin' };
  if (keepalive !== undefined) init.keepalive = keepalive;
  if (json !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(json);
  }
  return init;
}

/**
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function parseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {Response} response
 * @returns {Promise<ApiError>}
 */
async function buildApiError(response) {
  const code = await extractErrorCode(response);
  const retryAfterSec = parseRetryAfter(response.headers.get('Retry-After'));
  return new ApiError(response.status, code, retryAfterSec);
}

/**
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function extractErrorCode(response) {
  try {
    const text = await response.text();
    if (!text) return 'unknown';
    const body = /** @type {{ error?: unknown }} */ (JSON.parse(text));
    if (body && typeof body.error === 'string') return body.error;
  } catch {
    // fall through to 'unknown'
  }
  return 'unknown';
}

/**
 * Parses a `Retry-After` header as a non-negative integer number of seconds
 * (this server never sends the HTTP-date form).
 * @param {string | null} value
 * @returns {number | null}
 */
function parseRetryAfter(value) {
  if (value === null || !/^\d+$/.test(value)) return null;
  return Number(value);
}

/**
 * Navigates to the login page, preserving the current location as `next`.
 * @returns {void}
 */
export function toLogin() {
  location.assign('/login?next=' + encodeURIComponent(location.pathname + location.search));
}

/**
 * Validates a client-supplied redirect target with the same rule the server
 * applies in `src/http/security.js`: accepted only if it starts with `/`, is
 * not `//` or `/\`, contains no control character or backslash, and is at
 * most 2048 characters long; otherwise `/`.
 * @param {string | null | undefined} value
 * @returns {string}
 */
export function safeNext(value) {
  if (typeof value !== 'string' || value.length > 2048) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (/[\x00-\x1f\x7f\\]/.test(value)) return '/';
  return value;
}
