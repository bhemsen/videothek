/**
 * All SQL for the `sessions` table, behind prepared statements. Sessions are
 * looked up by id (the SHA-256 hex of the opaque cookie token, computed by
 * the caller — this module never hashes anything). HTTP-agnostic: expiry
 * comparisons and refresh decisions are the caller's (`src/auth/sessions.js`)
 * job.
 */

/**
 * @typedef {'admin' | 'user'} UserRole
 * @typedef {{ id: string, expiresAt: number, user: { id: number, username: string, role: UserRole } }} SessionWithUser
 */

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id: string, userId: number, createdAt: number, expiresAt: number }} session
 * @returns {void}
 */
export function insertSession(db, { id, userId, createdAt, expiresAt }) {
  db.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(id, userId, createdAt, expiresAt);
}

/**
 * Looks up a session together with its owning user.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 * @returns {SessionWithUser | undefined}
 */
export function getSessionWithUser(db, id) {
  const row = db
    .prepare(
      `SELECT sessions.expires_at AS expires_at,
              users.id AS user_id, users.username AS username, users.role AS role
       FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.id = ?`
    )
    .get(id);
  if (!row) return undefined;
  return {
    id,
    expiresAt: /** @type {number} */ (row.expires_at),
    user: {
      id: /** @type {number} */ (row.user_id),
      username: /** @type {string} */ (row.username),
      role: /** @type {UserRole} */ (row.role),
    },
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 * @param {number} expiresAt
 * @returns {void}
 */
export function setSessionExpiry(db, id, expiresAt) {
  db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(expiresAt, id);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 * @returns {void}
 */
export function deleteSession(db, id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

/**
 * Deletes every session for `userId`, optionally keeping one (e.g. the
 * caller's own current session on a self-service password reset).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} userId
 * @param {string | null} [exceptId]
 * @returns {number} number of sessions deleted
 */
export function deleteUserSessions(db, userId, exceptId = null) {
  const result =
    exceptId === null
      ? db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
      : db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, exceptId);
  return Number(result.changes);
}

/**
 * Deletes every session whose `expiresAt` has been reached (`<= now`).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} now
 * @returns {number} number of sessions deleted
 */
export function deleteExpiredSessions(db, now) {
  const result = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  return Number(result.changes);
}
