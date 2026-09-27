/**
 * Login page (`/login`, no shell): wordmark, "Anmelden" card with
 * Benutzername/Passwort fields, an inline `role="alert"` error line, and
 * the "Konten werden von der Verwaltung angelegt." footer. On success
 * navigates to the validated `next` query parameter (or `/`).
 */
import { el } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { request, ApiError, safeNext } from './lib/api.js';
import { loginErrorMessage } from './login-messages.js';

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
    'main',
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
    const apiError = error instanceof ApiError ? error : null;
    if (apiError?.code === 'invalid_credentials') {
      passwordInput.value = '';
      passwordInput.setAttribute('aria-invalid', 'true');
      passwordInput.focus();
    }
    setError(loginErrorMessage(apiError?.code ?? null, apiError?.retryAfterSec ?? null));
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

