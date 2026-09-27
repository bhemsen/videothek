/**
 * Admin page (`/admin`): lists users with role/reset/delete controls, a
 * "Neuer Benutzer" create form, and the delete/reset-password dialogs. The
 * page route itself requires the admin role (`src/http/static.js`); this
 * script assumes that guard already ran.
 */
import { el } from './lib/dom.js';
import { mountShell } from './lib/shell.js';
import { ApiError, request } from './lib/api.js';
import { accountCountLabel, createUserList, renderUsers } from './admin-list.js';
import { createUserForm } from './admin-form.js';
import { createDeleteDialog, createResetDialog } from './admin-dialogs.js';
import { errorMessage } from './admin-errors.js';

/** @typedef {{ id: number, username: string, role: 'admin' | 'user', createdAt: string }} AdminUser */

const { main, me } = mountShell({ active: null });

/** @type {number | null} */
let meId = null;
/** @type {AdminUser[]} */
let users = [];

const status = el('p', { class: 'admin-status', role: 'status', hidden: true });
const userList = createUserList();
const createForm = createUserForm({ onCreate: createUser, onCreated: handleCreated });
const deleteDialog = createDeleteDialog(deleteUser);
const resetDialog = createResetDialog(resetPassword);

main.append(
  el('h1', {}, 'Benutzerverwaltung'),
  userList.subline,
  status,
  el(
    'div',
    { class: 'admin-layout' },
    userList.element,
    el('section', { class: 'admin-create' }, el('h2', {}, 'Neuer Benutzer'), createForm),
  ),
  deleteDialog.element,
  resetDialog.element,
);

init();

/** @returns {Promise<void>} */
async function init() {
  try {
    meId = (await me).id;
  } catch {
    // /api/me failed after the page already loaded (e.g. the session expired
    // mid-load) — the next request() call below redirects to /login.
  }
  await loadUsers();
}

/** @returns {Promise<void>} */
async function loadUsers() {
  const { data } = await request('GET', '/api/users');
  users = /** @type {AdminUser[]} */ (data);
  render();
}

/** @returns {void} */
function render() {
  userList.subline.textContent = accountCountLabel(users.length);
  renderUsers(userList.list, users, meId, {
    onRoleChange: changeRole,
    onResetClick: (user, trigger) => resetDialog.open(user, trigger),
    onDeleteClick: (user, trigger) => deleteDialog.open(user, trigger),
  });
}

/**
 * @param {string} username
 * @param {string} password
 * @param {string} role
 * @returns {Promise<import('./admin-form.js').CreateResult>}
 */
async function createUser(username, password, role) {
  try {
    const { data } = await request('POST', '/api/users', { json: { username, password, role } });
    return { ok: true, user: /** @type {AdminUser} */ (data) };
  } catch (err) {
    return { ok: false, code: apiCode(err), message: apiMessage(err) };
  }
}

/**
 * @param {AdminUser} user
 * @returns {void}
 */
function handleCreated(user) {
  setStatus(`Benutzer „${user.username}“ angelegt.`);
  loadUsers();
}

/**
 * @param {AdminUser} user
 * @param {string} role
 * @param {HTMLSelectElement} select
 * @returns {Promise<void>}
 */
async function changeRole(user, role, select) {
  try {
    await request('PATCH', `/api/users/${user.id}`, { json: { role } });
    user.role = /** @type {'admin' | 'user'} */ (role);
    setStatus(`Rolle von „${user.username}“ geändert.`);
  } catch (err) {
    select.value = user.role;
    setStatus(apiMessage(err));
  }
}

/**
 * @param {AdminUser} user
 * @param {string} password
 * @returns {Promise<import('./admin-dialogs.js').ActionResult>}
 */
async function resetPassword(user, password) {
  try {
    await request('PUT', `/api/users/${user.id}/password`, { json: { password } });
    setStatus(`Passwort von „${user.username}“ geändert.`);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: apiCode(err), message: apiMessage(err) };
  }
}

/**
 * @param {AdminUser} user
 * @returns {Promise<import('./admin-dialogs.js').ActionResult>}
 */
async function deleteUser(user) {
  try {
    await request('DELETE', `/api/users/${user.id}`);
    await loadUsers();
    setStatus(`Benutzer „${user.username}“ gelöscht.`);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: apiCode(err), message: apiMessage(err) };
  }
}

/**
 * @param {string} message
 * @returns {void}
 */
function setStatus(message) {
  status.textContent = message;
  status.hidden = false;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function apiCode(err) {
  return err instanceof ApiError ? err.code : 'unknown';
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function apiMessage(err) {
  return err instanceof ApiError ? errorMessage(err.code, err.retryAfterSec) : errorMessage('unknown');
}
