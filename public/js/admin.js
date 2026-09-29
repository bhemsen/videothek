/**
 * Admin page (`/admin`): lists users with role/reset/delete controls, a
 * "Neuer Benutzer" create form, and the delete/reset-password dialogs. The
 * page route itself requires the admin role (`src/http/static.js`); this
 * script assumes that guard already ran.
 */
import { el } from './lib/dom.js';
import { mountShell } from './lib/shell.js';
import { ApiError, request } from './lib/api.js';
import { createUserList, renderUsers } from './admin-list.js';
import { accountCountLabel } from './admin-format.js';
import { createUserForm } from './admin-form.js';
import { createDeleteDialog, createResetDialog } from './admin-dialogs.js';
import { errorMessage } from './admin-errors.js';
import { mountConversionPanel } from './admin-conversions.js';

/** @typedef {{ id: number, username: string, role: 'admin' | 'user', createdAt: string }} AdminUser */

const { main, me } = mountShell({ active: null });

/** @type {number | null} */
let meId = null;
/** @type {AdminUser[]} */
let users = [];

// Present (empty) from the start: a live region inserted or un-hidden together
// with its first message is not reliably announced.
const status = el('p', { class: 'admin-status', role: 'status' });
// Focus target when a dialog's trigger button no longer exists (row deleted).
const heading = el('h1', { class: 'admin-title', tabindex: '-1' }, 'Benutzerverwaltung');
const userList = createUserList();
const createForm = createUserForm({ onCreate: createUser, onCreated: handleCreated });
const deleteDialog = createDeleteDialog({ onConfirm: deleteUser, onDeleted: removeUser, fallbackFocus: heading });
const resetDialog = createResetDialog({ onSubmit: resetPassword, fallbackFocus: heading });

main.append(
  heading,
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
mountConversionPanel(main);

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

/**
 * Fetches the user list and re-renders; a failure is shown in the status line
 * (never an unhandled rejection) and keeps the previously rendered list.
 * @returns {Promise<void>}
 */
async function loadUsers() {
  try {
    const { data } = await request('GET', '/api/users');
    users = /** @type {AdminUser[]} */ (data);
    render();
  } catch (err) {
    setStatus(apiMessage(err));
  }
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
  // Locked while in flight so a later change cannot race an earlier failure.
  select.disabled = true;
  try {
    await request('PATCH', `/api/users/${user.id}`, { json: { role } });
    user.role = /** @type {'admin' | 'user'} */ (role);
    setStatus(`Rolle von „${user.username}“ geändert.`);
  } catch (err) {
    select.value = user.role;
    setStatus(apiMessage(err));
  } finally {
    select.disabled = false;
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
    setStatus(`Benutzer „${user.username}“ gelöscht.`);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: apiCode(err), message: apiMessage(err) };
  }
}

/**
 * Drops a deleted user from the rendered list locally (called after the dialog
 * closed) — no refetch, so a failing follow-up GET cannot mask the success.
 * @param {AdminUser} user
 * @returns {void}
 */
function removeUser(user) {
  users = users.filter((candidate) => candidate.id !== user.id);
  render();
}

/**
 * @param {string} message
 * @returns {void}
 */
function setStatus(message) {
  status.textContent = message;
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
