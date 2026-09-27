/**
 * The two admin `<dialog>`s (delete confirm, password reset): native
 * `showModal`, Escape closes via the browser's built-in `cancel`/`close`
 * events, and `close` always returns focus to whichever row button opened it
 * (not every browser restores focus on its own) — or to `fallbackFocus` when
 * that button is gone (its row was deleted).
 */
import { el } from './lib/dom.js';

/**
 * @typedef {{ id: number, username: string, role: 'admin' | 'user', createdAt: string }} AdminUser
 * @typedef {{ ok: true } | { ok: false, code: string, message: string }} ActionResult
 * @typedef {{ element: HTMLDialogElement, open: (user: AdminUser, trigger: HTMLButtonElement) => void }} AdminDialog
 */

/**
 * @param {{
 *   onConfirm: (user: AdminUser) => Promise<ActionResult>,
 *   onDeleted: (user: AdminUser) => void,
 *   fallbackFocus: HTMLElement,
 * }} params
 * @returns {AdminDialog}
 */
export function createDeleteDialog({ onConfirm, onDeleted, fallbackFocus }) {
  /** @type {AdminUser | null} */
  let current = null;
  /** @type {HTMLButtonElement | null} */
  let trigger = null;
  const text = el('p', {});
  const error = el('p', { class: 'dialog-error', role: 'alert', hidden: true });
  const confirmButton = /** @type {HTMLButtonElement} */ (
    el('button', { type: 'button', class: 'btn btn-danger' }, 'Löschen')
  );
  const cancelButton = buildCancelButton();
  const dialog = /** @type {HTMLDialogElement} */ (el(
    'dialog',
    { class: 'admin-dialog', 'aria-label': 'Benutzer löschen' },
    text,
    error,
    el('div', { class: 'dialog-actions' }, cancelButton, confirmButton),
  ));

  cancelButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => restoreFocus(trigger, fallbackFocus));
  confirmButton.addEventListener('click', async () => {
    if (!current) return;
    const user = current;
    confirmButton.disabled = true;
    const result = await onConfirm(user);
    confirmButton.disabled = false;
    if (result.ok) {
      // The trigger's row is about to disappear — send focus to the fallback.
      trigger = null;
      dialog.close();
      onDeleted(user);
      return;
    }
    showError(error, result.message);
  });

  return {
    element: dialog,
    open(user, triggerButton) {
      current = user;
      trigger = triggerButton;
      hideError(error);
      text.textContent = `„${user.username}“ wirklich löschen? Der Wiedergabefortschritt dieses Kontos geht verloren.`;
      dialog.showModal();
    },
  };
}

/**
 * @param {{
 *   onSubmit: (user: AdminUser, password: string) => Promise<ActionResult>,
 *   fallbackFocus: HTMLElement,
 * }} params
 * @returns {AdminDialog}
 */
export function createResetDialog({ onSubmit, fallbackFocus }) {
  /** @type {AdminUser | null} */
  let current = null;
  /** @type {HTMLButtonElement | null} */
  let trigger = null;
  const parts = buildResetParts(handleSubmit);
  const { dialog, input, saveButton } = parts;

  parts.cancelButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => restoreFocus(trigger, fallbackFocus));

  /**
   * @param {Event} event
   * @returns {Promise<void>}
   */
  async function handleSubmit(event) {
    event.preventDefault();
    if (!current) return;
    clearResetErrors(parts);
    saveButton.disabled = true;
    const result = await onSubmit(current, input.value);
    saveButton.disabled = false;
    if (result.ok) {
      dialog.close();
    } else if (result.code === 'invalid_password') {
      input.setAttribute('aria-invalid', 'true');
      parts.fieldError.textContent = result.message;
    } else {
      showError(parts.formError, result.message);
    }
  }

  return {
    element: dialog,
    open(user, triggerButton) {
      current = user;
      trigger = triggerButton;
      clearResetErrors(parts);
      input.value = '';
      parts.title.textContent = `Neues Passwort für „${user.username}“`;
      parts.note.textContent = `Alle Geräte von ${user.username} werden abgemeldet.`;
      dialog.showModal();
      input.focus();
    },
  };
}

/**
 * @typedef {{
 *   dialog: HTMLDialogElement, title: HTMLElement, input: HTMLInputElement,
 *   fieldError: HTMLElement, note: HTMLElement, formError: HTMLElement,
 *   cancelButton: HTMLButtonElement, saveButton: HTMLButtonElement,
 * }} ResetParts
 */

/**
 * Builds the reset dialog's DOM. The form is `novalidate` so an empty submit
 * reaches the API and shows the German field error, not the browser bubble.
 * @param {(event: Event) => Promise<void>} onSubmit
 * @returns {ResetParts}
 */
function buildResetParts(onSubmit) {
  const titleId = 'admin-reset-dialog-title';
  const title = el('h2', { id: titleId });
  const input = /** @type {HTMLInputElement} */ (
    el('input', { id: 'admin-reset-password', type: 'password', autocomplete: 'new-password', required: true })
  );
  const fieldError = el('span', { class: 'field-error' });
  const note = el('p', { class: 'dialog-note' });
  const formError = el('p', { class: 'dialog-error', role: 'alert', hidden: true });
  const cancelButton = buildCancelButton();
  const saveButton = /** @type {HTMLButtonElement} */ (
    el('button', { type: 'submit', class: 'btn btn-primary' }, 'Speichern')
  );
  const form = el(
    'form',
    { novalidate: true, onSubmit },
    el(
      'div',
      { class: 'field' },
      el('label', { for: 'admin-reset-password' }, 'Neues Passwort'),
      input,
      el('p', { class: 'field-hint' }, 'Mindestens 8 Zeichen'),
      fieldError,
    ),
    note,
    formError,
    el('div', { class: 'dialog-actions' }, cancelButton, saveButton),
  );
  const dialog = /** @type {HTMLDialogElement} */ (
    el('dialog', { class: 'admin-dialog', 'aria-labelledby': titleId }, title, form)
  );
  return { dialog, title, input, fieldError, note, formError, cancelButton, saveButton };
}

/**
 * @param {ResetParts} parts
 * @returns {void}
 */
function clearResetErrors(parts) {
  parts.input.setAttribute('aria-invalid', 'false');
  parts.fieldError.textContent = '';
  hideError(parts.formError);
}

/** @returns {HTMLButtonElement} */
function buildCancelButton() {
  return /** @type {HTMLButtonElement} */ (
    el('button', { type: 'button', class: 'btn btn-secondary' }, 'Abbrechen')
  );
}

/**
 * @param {HTMLButtonElement | null} trigger
 * @param {HTMLElement} fallbackFocus
 * @returns {void}
 */
function restoreFocus(trigger, fallbackFocus) {
  if (trigger?.isConnected) trigger.focus();
  else fallbackFocus.focus();
}

/**
 * @param {HTMLElement} error
 * @param {string} message
 * @returns {void}
 */
function showError(error, message) {
  error.textContent = message;
  error.hidden = false;
}

/**
 * @param {HTMLElement} error
 * @returns {void}
 */
function hideError(error) {
  error.hidden = true;
  error.textContent = '';
}
