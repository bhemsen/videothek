/**
 * App shell: skip link, header (wordmark, category nav, account menu) and
 * the `<main>` content slot. Mounted once per page by every authenticated
 * page script.
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { renderNav } from './nav.js';
import { request } from './api.js';

/**
 * @typedef {import('./nav.js').NavEntry} NavEntry
 * @typedef {{ id: number, username: string, role: 'admin' | 'user' }} AuthUser
 */

/**
 * Mounts the shell into `document.body` and returns its content slot.
 * @param {{ active?: string | null }} [params]
 * @returns {{ main: HTMLElement, setActive: (id: string | null) => void, me: Promise<AuthUser> }}
 */
export function mountShell({ active = null } = {}) {
  const nav = renderNav(active);
  const account = buildAccountMenu();
  const skipLink = el('a', { href: '#main', class: 'visually-hidden skip-link' }, 'Zum Inhalt springen');
  const header = el(
    'header',
    { class: 'app-header' },
    el('a', { href: '/', class: 'wordmark' }, icon('logo'), el('span', {}, 'Videothek')),
    nav,
    account.element,
  );
  const main = el('main', { id: 'main' });
  document.body.append(skipLink, header, main);

  setupDisclosure(account);
  account.logoutButton.addEventListener('click', handleLogout);
  const me = loadMe(account);

  return { main, setActive: (id) => updateActive(nav, id), me };
}

/**
 * @typedef {{
 *   element: HTMLElement, button: HTMLButtonElement, menu: HTMLElement,
 *   avatar: HTMLElement, username: HTMLElement, meta: HTMLElement,
 *   adminLink: HTMLElement, logoutButton: HTMLButtonElement,
 * }} AccountMenu
 */

/** @returns {AccountMenu} */
function buildAccountMenu() {
  const avatar = el('span', { class: 'avatar', 'aria-hidden': 'true' });
  const username = el('span', { class: 'account-username', 'aria-hidden': 'true' });
  const button = /** @type {HTMLButtonElement} */ (el(
    'button',
    { type: 'button', class: 'account-button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'account-menu', disabled: true },
    avatar,
    username,
    icon('chevron-down'),
  ));
  const meta = el('p', { class: 'account-menu-meta' });
  const adminLink = el('a', { href: '/admin', class: 'account-menu-item', hidden: true }, icon('users'), 'Benutzerverwaltung');
  const logoutButton = /** @type {HTMLButtonElement} */ (
    el('button', { type: 'button', class: 'account-menu-item' }, icon('logout'), 'Abmelden')
  );
  const menu = el('div', { class: 'account-menu-list', id: 'account-menu', hidden: true }, meta, adminLink, logoutButton);
  const element = el('div', { class: 'account-menu' }, button, menu);
  return { element, button, menu, avatar, username, meta, adminLink, logoutButton };
}

/**
 * Wires Escape / outside-click to close the disclosure and return focus to
 * its button; the button's own click toggles it.
 * @param {AccountMenu} account
 * @returns {void}
 */
function setupDisclosure({ button, menu }) {
  let open = false;
  const setOpen = (/** @type {boolean} */ value) => {
    open = value;
    button.setAttribute('aria-expanded', String(value));
    menu.hidden = !value;
    document[value ? 'addEventListener' : 'removeEventListener']('keydown', onKeydown);
    document[value ? 'addEventListener' : 'removeEventListener']('click', onOutsideClick, true);
  };
  const onKeydown = (/** @type {Event} */ event) => {
    if (/** @type {KeyboardEvent} */ (event).key !== 'Escape') return;
    setOpen(false);
    button.focus();
  };
  const onOutsideClick = (/** @type {Event} */ event) => {
    const target = /** @type {Node} */ (event.target);
    if (menu.contains(target) || button.contains(target)) return;
    setOpen(false);
    button.focus();
  };
  button.addEventListener('click', () => setOpen(!open));
}

/**
 * Loads `/api/me` and fills in the avatar/username/meta once it resolves.
 * @param {AccountMenu} account
 * @returns {Promise<AuthUser>}
 */
function loadMe(account) {
  const me = /** @type {Promise<AuthUser>} */ (request('GET', '/api/me').then((r) => r.data));
  me.then((user) => applyMe(account, user)).catch(() => {});
  return me;
}

/**
 * @param {AccountMenu} account
 * @param {AuthUser} user
 * @returns {void}
 */
function applyMe(account, user) {
  const roleLabel = user.role === 'admin' ? 'Admin' : 'Benutzer';
  account.avatar.textContent = user.username.charAt(0).toUpperCase();
  account.username.textContent = user.username;
  account.meta.textContent = `Angemeldet als ${user.username} (${roleLabel})`;
  account.button.setAttribute('aria-label', `Konto von ${user.username} (${roleLabel})`);
  account.adminLink.hidden = user.role !== 'admin';
  account.button.disabled = false;
}

/** @returns {Promise<void>} */
async function handleLogout() {
  try {
    await request('POST', '/logout', { redirectOn401: false });
  } catch {
    // Network error or an already-expired session — navigate away regardless.
  }
  location.assign('/login');
}

/**
 * @param {HTMLElement} nav
 * @param {string | null} id
 * @returns {void}
 */
function updateActive(nav, id) {
  for (const link of nav.querySelectorAll('[data-nav]')) {
    if (link.getAttribute('data-nav') === id) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}
