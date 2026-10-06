// @ts-check

/**
 * Shared error-to-code mapping for the conversion modules: the one place that
 * turns an unknown thrown value into a short, log-safe string.
 */

/**
 * @param {unknown} err
 * @param {string} [fallback] - returned when `err` carries neither a string
 *   `code` nor a string `name`; default `'ERR_UNKNOWN'`.
 * @returns {string} the errno `code`, else the error's `name`, else `fallback`.
 */
export function errorCode(err, fallback = 'ERR_UNKNOWN') {
  const code = /** @type {{ code?: unknown }} */ (err)?.code;
  if (typeof code === 'string') return code;
  const name = /** @type {{ name?: unknown }} */ (err)?.name;
  return typeof name === 'string' ? name : fallback;
}
