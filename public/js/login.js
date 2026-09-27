/**
 * Login page (`/login`, no shell): wordmark, "Anmelden" card with
 * Benutzername/Passwort fields, an inline `role="alert"` error line, and
 * the "Konten werden von der Verwaltung angelegt." footer. On success
 * navigates to the validated `next` query parameter (or `/`).
 */
import { el } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { request, ApiError, safeNext } from './lib/api.js';

const usernameInput = /** @type {HTMLInputElement} */ (el('input', {
  id: 'username',
  name: 'username',
  type: 'text',
  autocomplete: 'username',
  required: true,
}));

const passwordInput = /** @type {HTMLInputElement} */ (el('input', {
  id: 'password',
  name: 'password',
  type: 'password',
  autocomplete: 'current-password',
  required: true,
}));

const errorText = el('span', {});
const errorLine = el(
  'p',
  { class: 'login-error', role: 'alert', hidden: true },
  icon('alert'),
  errorText,
);

const submitButton = /** @type {HTMLButtonElement} */ (
  el('button', { type: 'submit', class: 'btn btn-primary login-submit' }, 'Anmelden')
);

const form = el(
  'form',
  { id: 'login-form', onsubmit: handleSubmit },
  el('div', { class: 'login-field' }, el('label', { for: 'username' }, 'Benutzername'), usernameInput),
  el('div', { class: 'login-field' }, el('label', { for: 'password' }, 'Passwort'), passwordInput),
  errorLine,
  submitButton,
);

document.body.append(
  el(
    'div',
    { class: 'login-page' },
    el('p', { class: 'login-wordmark' }, icon('logo'), 'Videothek'),
    el('div', { class: 'login-card' }, el('h1', {}, 'Anmelden'), form),
    el('p', { class: 'login-footer' }, 'Konten werden von der Verwaltung angelegt.'),
  ),
);

/**
 * Submits the credentials and either navigates on success or shows the
 * matching German error message.
 * @param {SubmitEvent} event
 * @returns {Promise<void>}
 */
async function handleSubmit(event) {
  event.preventDefault();
  setError(null);
  submitButton.disabled = true;
  try {
    await request('POST', '/login', {
      json: { username: usernameInput.value, password: passwordInput.value },
      redirectOn401: false,
    });
    const next = new URLSearchParams(location.search).get('next');
    location.assign(safeNext(next));
  } catch (error) {
    passwordInput.value = '';
    passwordInput.setAttribute('aria-invalid', 'true');
    passwordInput.focus();
    setError(error instanceof ApiError ? errorMessage(error) : errorMessage(null));
    submitButton.disabled = false;
  }
}

/**
 * Shows or clears the inline error line.
 * @param {string | null} message
 * @returns {void}
 */
function setError(message) {
  if (message === null) {
    errorLine.hidden = true;
    errorText.textContent = '';
    passwordInput.removeAttribute('aria-invalid');
    return;
  }
  errorText.textContent = message;
  errorLine.hidden = false;
}

/**
 * Maps a login `ApiError` to its German message; `null` (a non-`ApiError`
 * failure) falls back to the same generic text as an unknown error code.
 * @param {ApiError | null} error
 * @returns {string}
 */
function errorMessage(error) {
  if (error?.code === 'invalid_credentials') return 'Benutzername oder Passwort falsch.';
  if (error?.code === 'too_many_attempts') return throttleMessage(error.retryAfterSec);
  return 'Etwas ist schiefgelaufen. Bitte erneut versuchen.';
}

/**
 * Formats the `too_many_attempts` message with the retry minute count
 * (`max(1, ceil(retryAfterSec / 60))`, singular "1 Minute"); `null` (header
 * absent) falls back to a time-less variant.
 * @param {number | null} retryAfterSec
 * @returns {string}
 */
function throttleMessage(retryAfterSec) {
  if (retryAfterSec === null) return 'Zu viele Fehlversuche. Bitte später erneut versuchen.';
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  const unit = minutes === 1 ? 'Minute' : 'Minuten';
  return `Zu viele Fehlversuche. Bitte in ${minutes} ${unit} erneut versuchen.`;
}
