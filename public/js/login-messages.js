/**
 * Pure mapping from a failed login to its German inline error message.
 * Kept DOM-free so it is unit-tested in `test/public/login-messages.test.js`.
 */

/**
 * Maps a login error code to its German message; any other code (or `null`
 * for a non-`ApiError` failure) falls back to the generic text.
 * @param {string | null} code
 * @param {number | null} retryAfterSec
 * @returns {string}
 */
export function loginErrorMessage(code, retryAfterSec) {
  if (code === 'invalid_credentials') return 'Benutzername oder Passwort falsch.';
  if (code === 'too_many_attempts') return throttleMessage(retryAfterSec);
  return 'Etwas ist schiefgelaufen. Bitte erneut versuchen.';
}

/**
 * Formats the `too_many_attempts` message with the retry minute count
 * (`max(1, ceil(retryAfterSec / 60))`, singular "1 Minute"); `null` (header
 * absent) falls back to a time-less variant.
 * @param {number | null} retryAfterSec
 * @returns {string}
 */
export function throttleMessage(retryAfterSec) {
  if (retryAfterSec === null) return 'Zu viele Fehlversuche. Bitte später erneut versuchen.';
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  const unit = minutes === 1 ? 'Minute' : 'Minuten';
  return `Zu viele Fehlversuche. Bitte in ${minutes} ${unit} erneut versuchen.`;
}
