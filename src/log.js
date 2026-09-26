/**
 * JSON-line structured logger. Every module logs only through the injected
 * logger returned here (constitution: no `console.*` in `src/`).
 */

/** @typedef {{ write(chunk: string): void }} LogStream */
/** @typedef {(event: string, fields?: Record<string, unknown>) => void} LogFn */
/** @typedef {{ info: LogFn, warn: LogFn, error: LogFn }} Logger */

const REDACT_KEY_PATTERN = /pass|token|cookie|secret|hash|authorization/i;

/**
 * Recursively redacts values whose key matches `REDACT_KEY_PATTERN` and
 * serializes `Error` instances to `{ message, stack }` so they survive
 * `JSON.stringify` (which otherwise turns an `Error` into `{}`).
 * @param {unknown} value
 * @returns {unknown}
 */
function redactValue(value) {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = REDACT_KEY_PATTERN.test(key) ? '[redacted]' : redactValue(entry);
    }
    return result;
  }
  return value;
}

/**
 * Redacts a top-level fields object, typed so callers can spread the result.
 * @param {Record<string, unknown>} fields
 * @returns {Record<string, unknown>}
 */
function redactFields(fields) {
  return /** @type {Record<string, unknown>} */ (redactValue(fields));
}

/**
 * Creates a JSON-line logger writing to the injected streams.
 * @param {{ out?: LogStream, err?: LogStream, now?: () => number }} [options]
 * @returns {Logger}
 */
export function createLogger({ out = process.stdout, err = process.stderr, now = Date.now } = {}) {
  /**
   * @param {LogStream} stream
   * @param {string} level
   * @param {string} event
   * @param {Record<string, unknown>} [fields]
   */
  const write = (stream, level, event, fields) => {
    const redacted = fields === undefined ? undefined : redactFields(fields);
    const line = { t: new Date(now()).toISOString(), level, event, ...redacted };
    stream.write(`${JSON.stringify(line)}\n`);
  };
  return {
    info: (event, fields) => write(out, 'info', event, fields),
    warn: (event, fields) => write(out, 'warn', event, fields),
    error: (event, fields) => write(err, 'error', event, fields),
  };
}
