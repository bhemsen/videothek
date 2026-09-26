const USERNAME_PATTERN = /^[\p{L}\p{N}._-]{1,32}$/u;
const VALID_ROLES = new Set(['admin', 'user']);

/**
 * Normalizes a username: trims whitespace, applies Unicode NFC
 * normalization, then lower-cases it.
 * @param {string} username
 * @returns {string}
 */
export function normalizeUsername(username) {
  return username.trim().normalize('NFC').toLowerCase();
}

/**
 * Normalizes and validates a username against
 * `^[\p{L}\p{N}._-]{1,32}$` (Unicode letters/digits plus `. _ -`).
 * @param {string} username
 * @returns {string | null} the normalized username, or `null` if invalid
 */
export function validateUsername(username) {
  if (typeof username !== 'string') return null;
  const normalized = normalizeUsername(username);
  return USERNAME_PATTERN.test(normalized) ? normalized : null;
}

/**
 * Validates a password's length: 8-256 Unicode code points.
 * @param {string} password
 * @returns {boolean}
 */
export function validatePassword(password) {
  if (typeof password !== 'string') return false;
  const length = [...password].length;
  return length >= 8 && length <= 256;
}

/**
 * Validates a user role.
 * @param {string} role
 * @returns {boolean}
 */
export function validateRole(role) {
  return typeof role === 'string' && VALID_ROLES.has(role);
}
