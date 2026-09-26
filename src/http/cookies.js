/**
 * Parses a `Cookie` request header into a name -> value record. Pairs
 * without `=` are ignored; values are percent-decoded, falling back to the
 * raw value when decoding fails.
 * @param {string | undefined} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const cookies = {};
  if (!header) return cookies;

  for (const part of header.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;
    const name = part.slice(0, separatorIndex).trim();
    if (!name) continue;
    const rawValue = part.slice(separatorIndex + 1).trim();
    cookies[name] = decodeCookieValue(rawValue);
  }
  return cookies;
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeCookieValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Serializes a `Set-Cookie` header value.
 * @param {string} name
 * @param {string} value
 * @param {{
 *   maxAge?: number,
 *   secure?: boolean,
 *   path?: string,
 *   httpOnly?: boolean,
 *   sameSite?: 'Lax' | 'Strict' | 'None',
 * }} options
 * @returns {string}
 */
export function serializeCookie(
  name,
  value,
  { maxAge, secure, path = '/', httpOnly = true, sameSite = 'Lax' },
) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`];
  if (typeof maxAge === 'number') parts.push(`Max-Age=${Math.floor(maxAge)}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  parts.push(`SameSite=${sameSite}`);
  return parts.join('; ');
}
