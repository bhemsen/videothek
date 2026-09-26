/**
 * An error carrying an HTTP status and a machine-readable `{ "error": code }`
 * body, thrown by handlers and caught by the app's dispatch layer.
 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {Record<string, string>} [headers]
   */
  constructor(status, code, headers) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers ?? {};
  }
}

/**
 * Sends a JSON response with the standard `no-store` cache header.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @returns {void}
 */
export function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/**
 * Sends a `{ "error": "<code>" }` JSON error response, merging in any extra
 * headers (e.g. `Allow`, `Retry-After`).
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} code
 * @param {Record<string, string>} [headers]
 * @returns {void}
 */
export function sendError(res, status, code, headers) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify({ error: code }));
}

/**
 * Sends an empty `204 No Content` response.
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
export function sendNoContent(res) {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

/**
 * Sends a redirect response.
 * @param {import('node:http').ServerResponse} res
 * @param {string} location
 * @param {number} [status]
 * @returns {void}
 */
export function redirect(res, location, status = 302) {
  res.writeHead(status, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

/**
 * Checks whether a request carries a body, per `Content-Length` /
 * `Transfer-Encoding`.
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function hasRequestBody(req) {
  if (req.headers['transfer-encoding']) return true;
  const contentLength = Number(req.headers['content-length']);
  return Number.isFinite(contentLength) && contentLength > 0;
}

/**
 * Checks whether a `Content-Type` header value is `application/json`,
 * ignoring parameters such as `charset`.
 * @param {string} contentType
 * @returns {boolean}
 */
function isJsonContentType(contentType) {
  return contentType.split(';')[0].trim().toLowerCase() === 'application/json';
}

/**
 * Reads and parses a JSON request body. Resolves `undefined` when the
 * request has no body. Throws `HttpError` for a non-JSON content type
 * (415), an oversized body (413) or invalid JSON (400).
 * @param {import('node:http').IncomingMessage} req
 * @param {{ limit?: number }} [options]
 * @returns {Promise<unknown | undefined>}
 */
export async function readJson(req, { limit = 16384 } = {}) {
  if (!hasRequestBody(req)) return undefined;

  const contentType = /** @type {string} */ (req.headers['content-type'] ?? '');
  if (!isJsonContentType(contentType)) {
    throw new HttpError(415, 'unsupported_media_type');
  }

  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new HttpError(413, 'payload_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid_json'));
      }
    });
  });
}
