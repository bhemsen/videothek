/**
 * "Neuer Benutzer" create form: username/password/role fields with
 * below-field errors, a password hint, and a full reset on success.
 */
import { el } from './lib/dom.js';
import { icon } from './lib/icons.js';

/**
 * @typedef {{ id: number, username: string, role: 'admin' | 'user', createdAt: string }} AdminUser
 * @typedef {{ ok: true, user: AdminUser } | { ok: false, code: string, message: string }} CreateResult
 * @typedef {{ field: HTMLElement, input: HTMLInputElement, error: HTMLElement }} TextFieldParts
 * @typedef {{ username: TextFieldParts, password: TextFieldParts, formError: HTMLElement }} ErrorSurfaces
 */

/**
 * @param {{
 *   onCreate: (username: string, password: string, role: string) => Promise<CreateResult>,
 *   onCreated: (user: AdminUser) => void,
 * }} params
 * @returns {HTMLElement}
 */
export function createUserForm({ onCreate, onCreated }) {
  const username = buildTextField({ id: 'admin-new-username', label: 'Benutzername', type: 'text', placeholder: 'z. B. julia', autocomplete: 'off' });
  const password = buildTextField({ id: 'admin-new-password', label: 'Passwort', type: 'password', autocomplete: 'new-password', hint: 'Mindestens 8 Zeichen' });
  const role = buildRoleField();
  const formError = el('p', { class: 'form-error', role: 'alert', hidden: true });
  /** @type {ErrorSurfaces} */
  const surfaces = { username, password, formError };
  const submitButton = /** @type {HTMLButtonElement} */ (
    el('button', { type: 'submit', class: 'btn btn-primary' }, 'Benutzer anlegen')
  );
  const form = /** @type {HTMLFormElement} */ (el(
    'form',
    { class: 'admin-create-form', novalidate: true, onSubmit: handleSubmit },
    username.field,
    password.field,
    role.field,
    formError,
    submitButton,
  ));

  /**
   * @param {Event} event
   * @returns {Promise<void>}
   */
  async function handleSubmit(event) {
    event.preventDefault();
    clearErrors(surfaces);
    submitButton.disabled = true;
    const result = await onCreate(username.input.value, password.input.value, role.select.value);
    submitButton.disabled = false;
    if (result.ok) {
      form.reset();
      onCreated(result.user);
      return;
    }
    applyError(surfaces, result.code, result.message);
  }

  return form;
}

/**
 * @param {ErrorSurfaces} surfaces
 * @returns {void}
 */
function clearErrors({ username, password, formError }) {
  formError.hidden = true;
  formError.textContent = '';
  for (const field of [username, password]) {
    field.input.setAttribute('aria-invalid', 'false');
    field.error.textContent = '';
  }
}

/**
 * Field-specific codes go below their field; anything else to the form line.
 * @param {ErrorSurfaces} surfaces
 * @param {string} code
 * @param {string} message
 * @returns {void}
 */
function applyError({ username, password, formError }, code, message) {
  if (code === 'invalid_username' || code === 'username_taken') {
    setFieldError(username, message);
  } else if (code === 'invalid_password') {
    setFieldError(password, message);
  } else {
    formError.textContent = message;
    formError.hidden = false;
  }
}

/**
 * @param {TextFieldParts} field
 * @param {string} message
 * @returns {void}
 */
function setFieldError(field, message) {
  field.input.setAttribute('aria-invalid', 'true');
  field.error.textContent = message;
}

/**
 * @param {{ id: string, label: string, type: string, placeholder?: string, autocomplete: string, hint?: string }} params
 * @returns {TextFieldParts}
 */
function buildTextField({ id, label, type, placeholder, autocomplete, hint }) {
  const input = /** @type {HTMLInputElement} */ (
    el('input', { id, type, placeholder: placeholder ?? null, autocomplete, required: true })
  );
  const error = el('span', { class: 'field-error' });
  const field = el(
    'div',
    { class: 'field' },
    el('label', { for: id }, label),
    input,
    hint ? el('p', { class: 'field-hint' }, hint) : null,
    error,
  );
  return { field, input, error };
}

/** @returns {{ field: HTMLElement, select: HTMLSelectElement }} */
function buildRoleField() {
  const select = /** @type {HTMLSelectElement} */ (el(
    'select',
    { id: 'admin-new-role' },
    el('option', { value: 'user', selected: true }, 'Benutzer'),
    el('option', { value: 'admin' }, 'Admin'),
  ));
  const field = el(
    'div',
    { class: 'field' },
    el('label', { for: 'admin-new-role' }, 'Rolle'),
    el('div', { class: 'select' }, select, icon('chevron-down')),
  );
  return { field, select };
}
