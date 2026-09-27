/**
 * Renders the admin user list: a desktop table header (hidden on mobile via
 * admin.css) plus one row per user, laid out as stacked cards on mobile or
 * table rows on desktop. Rebuilt whenever the user list changes — simplest
 * correct sync, no per-row diffing.
 */
import { el } from './lib/dom.js';
import { icon } from './lib/icons.js';

/**
 * @typedef {{ id: number, username: string, role: 'admin' | 'user', createdAt: string }} AdminUser
 * @typedef {{
 *   onRoleChange: (user: AdminUser, role: string, select: HTMLSelectElement) => void,
 *   onResetClick: (user: AdminUser, trigger: HTMLButtonElement) => void,
 *   onDeleteClick: (user: AdminUser, trigger: HTMLButtonElement) => void,
 * }} RowHandlers
 */

/**
 * Builds the (initially empty) list section; call `renderUsers` to fill it.
 * @returns {{ element: HTMLElement, subline: HTMLElement, list: HTMLElement }}
 */
export function createUserList() {
  const subline = el('p', { class: 'admin-subline' });
  const head = el(
    'div',
    { class: 'user-table-head', 'aria-hidden': 'true' },
    el('span', {}, 'Benutzername'),
    el('span', {}, 'Rolle'),
    el('span', {}, 'Angelegt am'),
    el('span', {}, 'Aktionen'),
  );
  const list = el('ul', { class: 'user-list' });
  const element = el('div', { class: 'user-list-wrap' }, head, list);
  return { element, subline, list };
}

/**
 * (Re)builds the list's rows from `users`.
 * @param {HTMLElement} list
 * @param {AdminUser[]} users
 * @param {number | null} meId
 * @param {RowHandlers} handlers
 * @returns {void}
 */
export function renderUsers(list, users, meId, handlers) {
  list.replaceChildren(...users.map((user) => buildRow(user, user.id === meId, handlers)));
}

/**
 * @param {number} count
 * @returns {string}
 */
export function accountCountLabel(count) {
  return count === 1 ? '1 Konto' : `${count} Konten`;
}

/**
 * @param {AdminUser} user
 * @param {boolean} isOwn
 * @param {RowHandlers} handlers
 * @returns {HTMLElement}
 */
function buildRow(user, isOwn, handlers) {
  const roleSelect = buildRoleSelect(user, isOwn, handlers);
  const resetButton = /** @type {HTMLButtonElement} */ (
    el('button', { type: 'button', class: 'btn btn-secondary' }, 'Passwort zurücksetzen')
  );
  resetButton.addEventListener('click', () => handlers.onResetClick(user, resetButton));
  const deleteButton = /** @type {HTMLButtonElement} */ (
    el('button', { type: 'button', class: 'btn btn-danger', disabled: isOwn }, 'Löschen')
  );
  deleteButton.addEventListener('click', () => handlers.onDeleteClick(user, deleteButton));

  return el(
    'li',
    { class: 'user-row' },
    el(
      'div',
      { class: 'user-row-name' },
      el('strong', {}, user.username),
      isOwn ? el('span', { class: 'muted' }, ' (du)') : null,
    ),
    el('div', { class: 'user-row-created muted' }, `Angelegt am ${formatDate(user.createdAt)}`),
    el('div', { class: 'user-row-role' }, roleSelect),
    el('div', { class: 'user-row-actions' }, resetButton, deleteButton),
  );
}

/**
 * @param {AdminUser} user
 * @param {boolean} isOwn
 * @param {RowHandlers} handlers
 * @returns {HTMLElement}
 */
function buildRoleSelect(user, isOwn, handlers) {
  const select = /** @type {HTMLSelectElement} */ (el(
    'select',
    { 'aria-label': `Rolle von ${user.username}`, disabled: isOwn },
    el('option', { value: 'user' }, 'Benutzer'),
    el('option', { value: 'admin' }, 'Admin'),
  ));
  select.value = user.role;
  if (!isOwn) {
    select.addEventListener('change', () => handlers.onRoleChange(user, select.value, select));
  }
  return el('div', { class: 'select' }, select, icon('chevron-down'));
}

/**
 * @param {string} isoDate
 * @returns {string}
 */
function formatDate(isoDate) {
  return new Date(isoDate).toLocaleDateString('de-DE');
}
