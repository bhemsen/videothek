/**
 * All SQL for the `users` table, behind prepared statements. Role changes and
 * deletion run the last-admin guard (check + write) in one `BEGIN IMMEDIATE`
 * transaction so two overlapping requests can never both demote/delete the
 * last remaining admin.
 */

/**
 * @typedef {'admin' | 'user'} UserRole
 * @typedef {{ id: number, username: string, password_hash: string, role: UserRole, created_at: number }} UserRow
 * @typedef {'ok' | 'not_found' | 'last_admin'} GuardResult
 */

/**
 * @param {Record<string, import('node:sqlite').SQLOutputValue>} row
 * @returns {UserRow}
 */
function toUserRow(row) {
  return {
    id: /** @type {number} */ (row.id),
    username: /** @type {string} */ (row.username),
    password_hash: /** @type {string} */ (row.password_hash),
    role: /** @type {UserRole} */ (row.role),
    created_at: /** @type {number} */ (row.created_at),
  };
}

/**
 * Inserts a new user.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ username: string, passwordHash: string, role: UserRole, createdAt: number }} user
 * @returns {UserRow}
 */
export function insertUser(db, { username, passwordHash, role, createdAt }) {
  const result = db
    .prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(username, passwordHash, role, createdAt);
  const inserted = getUserById(db, Number(result.lastInsertRowid));
  if (!inserted) {
    throw new Error('insertUser: inserted row not found');
  }
  return inserted;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @returns {UserRow | undefined}
 */
export function getUserById(db, id) {
  const row = db
    .prepare('SELECT id, username, password_hash, role, created_at FROM users WHERE id = ?')
    .get(id);
  return row ? toUserRow(row) : undefined;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} username already normalized by the caller
 * @returns {UserRow | undefined}
 */
export function getUserByUsername(db, username) {
  const row = db
    .prepare('SELECT id, username, password_hash, role, created_at FROM users WHERE username = ?')
    .get(username);
  return row ? toUserRow(row) : undefined;
}

/**
 * All users, ordered by username.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {UserRow[]}
 */
export function listUsers(db) {
  const rows = db
    .prepare('SELECT id, username, password_hash, role, created_at FROM users ORDER BY username')
    .all();
  return rows.map(toUserRow);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number}
 */
export function countUsers(db) {
  const row = /** @type {{ n: number }} */ (db.prepare('SELECT COUNT(*) AS n FROM users').get());
  return row.n;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {string} hash
 * @returns {boolean} whether a row was updated (`false` when `id` is unknown)
 */
export function setPasswordHash(db, id, hash) {
  const result = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  return Number(result.changes) > 0;
}

/**
 * Counts admins other than `id`. Used by both guards to decide whether the
 * pending write would leave the table without an admin.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @returns {number}
 */
function countOtherAdmins(db, id) {
  const row = /** @type {{ n: number }} */ (
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id != ?").get(id)
  );
  return row.n;
}

/**
 * Changes a user's role, refusing a change that would leave zero admins.
 * Check + write run in one `BEGIN IMMEDIATE` transaction so two overlapping
 * calls can never both demote the last two admins.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {UserRole} role
 * @returns {GuardResult}
 */
export function setRoleGuarded(db, id, role) {
  try {
    db.exec('BEGIN IMMEDIATE');
    const user = /** @type {{ role: UserRole } | undefined} */ (
      db.prepare('SELECT role FROM users WHERE id = ?').get(id)
    );
    if (!user) {
      db.exec('ROLLBACK');
      return 'not_found';
    }
    if (user.role === 'admin' && role !== 'admin' && countOtherAdmins(db, id) === 0) {
      db.exec('ROLLBACK');
      return 'last_admin';
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    db.exec('COMMIT');
    return 'ok';
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // No transaction to roll back, e.g. BEGIN itself failed; the original
      // error below is what matters.
    }
    throw err;
  }
}

/**
 * Deletes a user, refusing a delete that would leave zero admins. Sessions
 * cascade via the `ON DELETE CASCADE` foreign key. Check + write run in one
 * `BEGIN IMMEDIATE` transaction, same guarantee as {@link setRoleGuarded}.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @returns {GuardResult}
 */
export function deleteUserGuarded(db, id) {
  try {
    db.exec('BEGIN IMMEDIATE');
    const user = /** @type {{ role: UserRole } | undefined} */ (
      db.prepare('SELECT role FROM users WHERE id = ?').get(id)
    );
    if (!user) {
      db.exec('ROLLBACK');
      return 'not_found';
    }
    if (user.role === 'admin' && countOtherAdmins(db, id) === 0) {
      db.exec('ROLLBACK');
      return 'last_admin';
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    db.exec('COMMIT');
    return 'ok';
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // No transaction to roll back, e.g. BEGIN itself failed; the original
      // error below is what matters.
    }
    throw err;
  }
}
