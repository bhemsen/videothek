/**
 * The two admin `<dialog>`s (delete confirm, password reset): native
 * `showModal`, Escape closes via the browser's built-in `cancel`/`close`
 * events, and `close` always returns focus to whichever row button opened it
 * (not every browser restores focus on its own).
 */
import { el } from './lib/dom.js';

/**
 * @typedef {{ id: number, username: string, role: 'admin' | 'user', createdAt: string }} AdminUser
 * @typedef {{ ok: true } | { ok: false, code: string, message: string }} ActionResult
 */

/**
 * @param {(user: AdminUser) => Promise<ActionResult>} onConfirm
 * @returns {{ element: HTMLDialogElement, open: (user: AdminUser, trigger: HTMLButtonElement) => void }}
 */
export function createDeleteDialog(onConfirm) {
  /** @type {AdminUser | null} */
  let current = null;
  /** @type {HTMLButtonElement | null} */
  let trigger = null;
  const text = el('p', {});
  const error = el('p', { class: 'dialog-error', role: 'alert', hidden: true });
  const confirmButton = /** @type {HTMLButtonElement} */ (
    el('button', { type: 'button', class: 'btn btn-danger' }, 'Löschen')
  );
  const cancelButton = /** @type {HTMLButtonElement} */ (
    el('button', { type: 'button', class: 'btn btn-secondary' }, 'Abbrechen')
  );
  const dialog = /** @type {HTMLDialogElement} */ (el(
    'dialog',
    { class: 'admin-dialog', 'aria-label': 'Benutzer löschen' },
    text,
    error,
    el('div', { class: 'dialog-actions' }, cancelButton, confirmButton),
  ));

  cancelButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => trigger?.focus());
  confirmButton.addEventListener('click', async () => {
    if (!current) return;
    confirmButton.disabled = true;
    const result = await onConfirm(current);
    confirmButton.disabled = false;
    if (result.ok) {
      dialog.close();
      return;
    }
    error.textContent = result.message;
    error.hidden = false;
  });

  return {
    element: dialog,
    open(user, triggerButton) {
      current = user;
      trigger = triggerButton;
      error.hidden = true;
      error.textContent = '';
      text.textContent = `„${user.username}“ wirklich löschen? Der Wiedergabefortschritt dieses Kontos geht verloren.`;
      dialog.showModal();
    },
  };
}

/**
 * @param {(user: AdminUser, password: string) => Promise<ActionResult>} onSubmit
 * @returns {{ element: HTMLDialogElement, open: (user: AdminUser, trigger: HTMLButtonElement) => void }}
 */
export function createResetDialog(onSubmit) {
  /** @type {AdminUser | null} */
  let current = null;
  /** @type {HTMLButtonElement | null} */
  let trigger = null;
  const titleId = 'admin-reset-dialog-title';
  const title = el('h2', { id: titleId });
  const input = /** @type {HTMLInputElement} */ (
    el('input', { id: 'admin-reset-password', type: 'password', autocomplete: 'new-password', required: true })
  );
  const fieldError = el('span', { class: 'field-error' });
  const note = el('p', { class: 'dialog-note' });
  const formError = el('p', { class: 'dialog-error', role: 'alert', hidden: true });
  const cancelButton = /** @type {HTMLButtonElement} */ (
    el('button', { type: 'button', class: 'btn btn-secondary' }, 'Abbrechen')
  );
  const saveButton = /** @type {HTMLButtonElement} */ (
    el('button', { type: 'submit', class: 'btn btn-primary' }, 'Speichern')
  );
  const form = el(
    'form',
    { onSubmit: handleSubmit },
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

  cancelButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => trigger?.focus());

  /**
   * @param {Event} event
   * @returns {Promise<void>}
   */
  async function handleSubmit(event) {
    event.preventDefault();
    if (!current) return;
    clearErrors();
    saveButton.disabled = true;
    const result = await onSubmit(current, input.value);
    saveButton.disabled = false;
    if (result.ok) {
      dialog.close();
      return;
    }
    if (result.code === 'invalid_password') {
      input.setAttribute('aria-invalid', 'true');
      fieldError.textContent = result.message;
    } else {
      formError.textContent = result.message;
      formError.hidden = false;
    }
  }

  /** @returns {void} */
  function clearErrors() {
    input.setAttribute('aria-invalid', 'false');
    fieldError.textContent = '';
    formError.hidden = true;
    formError.textContent = '';
  }

  return {
    element: dialog,
    open(user, triggerButton) {
      current = user;
      trigger = triggerButton;
      clearErrors();
      input.value = '';
      title.textContent = `Neues Passwort für „${user.username}“`;
      note.textContent = `Alle Geräte von ${user.username} werden abgemeldet.`;
      dialog.showModal();
      input.focus();
    },
  };
}
