/**
 * Maps an admin API error code (with optional `Retry-After` seconds) to the
 * German copy shown to the admin. A code with no dedicated case — including
 * `'unknown'`/`'network'` from `ApiError` — falls back to the generic line.
 */

/**
 * @param {string} code
 * @param {number | null} [retryAfterSec]
 * @returns {string}
 */
export function errorMessage(code, retryAfterSec = null) {
  switch (code) {
    case 'invalid_credentials':
      return 'Benutzername oder Passwort falsch.';
    case 'too_many_attempts':
      return tooManyAttemptsMessage(retryAfterSec);
    case 'username_taken':
      return 'Dieser Benutzername ist bereits vergeben.';
    case 'invalid_username':
      return 'Benutzername: 1–32 Zeichen, nur Buchstaben, Ziffern, Punkt, Binde- und Unterstrich.';
    case 'invalid_password':
      return 'Das Passwort muss 8–256 Zeichen lang sein.';
    case 'cannot_delete_self':
      return 'Du kannst dein eigenes Konto nicht löschen.';
    case 'cannot_change_own_role':
      return 'Du kannst deine eigene Rolle nicht ändern.';
    case 'last_admin':
      return 'Es muss mindestens ein Admin bestehen bleiben.';
    case 'not_found':
      return 'Dieses Konto gibt es nicht mehr.';
    default:
      return 'Etwas ist schiefgelaufen. Bitte erneut versuchen.';
  }
}

/**
 * @param {number | null} retryAfterSec
 * @returns {string}
 */
function tooManyAttemptsMessage(retryAfterSec) {
  if (retryAfterSec === null) return 'Zu viele Fehlversuche. Bitte später erneut versuchen.';
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  const unit = minutes === 1 ? 'Minute' : 'Minuten';
  return `Zu viele Fehlversuche. Bitte in ${minutes} ${unit} erneut versuchen.`;
}
