/**
 * Creates the first admin account from `ADMIN_USER`/`ADMIN_PASSWORD` on an
 * empty database. Runs once, after migrations, before the app starts
 * accepting connections (no unauthenticated first-run setup page).
 */

import { countUsers, insertUser } from '../db/users.js';
import { hashPassword } from './password.js';
import { validatePassword, validateUsername } from './validation.js';

const ADMIN_GUIDANCE = 'set ADMIN_USER and ADMIN_PASSWORD';

/**
 * Thrown when the database is empty and `adminUser`/`adminPassword` are
 * missing or invalid, so no admin could be created.
 */
export class BootstrapError extends Error {
  constructor() {
    super(ADMIN_GUIDANCE);
    this.name = 'BootstrapError';
  }
}

/**
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   adminUser: string | null,
 *   adminPassword: string | null,
 *   log: import('../log.js').Logger,
 *   now?: () => number,
 * }} options
 * @returns {Promise<'created' | 'skipped'>}
 * @throws {BootstrapError} when the database is empty and the admin
 *   variables are missing or invalid.
 */
export async function ensureAdmin({ db, adminUser, adminPassword, log, now = Date.now }) {
  if (countUsers(db) > 0) {
    if (adminUser !== null || adminPassword !== null) {
      log.warn('admin_env_ignored');
    }
    return 'skipped';
  }

  const username = typeof adminUser === 'string' ? validateUsername(adminUser) : null;
  const passwordValid = typeof adminPassword === 'string' && validatePassword(adminPassword);
  if (username === null || !passwordValid) {
    log.error('admin_missing', { guidance: ADMIN_GUIDANCE });
    throw new BootstrapError();
  }

  const passwordHash = await hashPassword(/** @type {string} */ (adminPassword));
  insertUser(db, { username, passwordHash, role: 'admin', createdAt: now() });
  log.info('admin_bootstrapped', { user: username });
  return 'created';
}
