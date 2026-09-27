/**
 * HTTP-agnostic session store: opaque bearer tokens in, hashed-at-rest
 * session rows in `src/db/sessions.js` out. Callers (the HTTP layer) own the
 * cookie; this module never sees a `Request`/`Response`.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  deleteExpiredSessions,
  deleteSession,
  deleteUserSessions,
  getSessionWithUser,
  insertSession,
  setSessionExpiry,
} from '../db/sessions.js';

/** @typedef {'admin' | 'user'} UserRole */
/** @typedef {{ id: number, username: string, role: UserRole }} SessionUser */

const TOKEN_BYTES = 32;
const DAY_MS = 24 * 60 * 60 * 1000;
const IDLE_LIFETIME_MS = 30 * DAY_MS;
const REFRESH_THRESHOLD_MS = 29 * DAY_MS;

/**
 * @param {string} token
 * @returns {string} SHA-256 hex digest
 */
function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Creates a session store bound to one database connection and clock.
 * @param {{ db: import('node:sqlite').DatabaseSync, now?: () => number }} options
 * @returns {{
 *   create: (userId: number) => { token: string, sessionId: string, expiresAt: number },
 *   resolve: (token: string) => { user: SessionUser, sessionId: string, refreshedExpiresAt: number | null } | null,
 *   revoke: (sessionId: string) => void,
 *   revokeUser: (userId: number, options?: { exceptSessionId?: string | null }) => number,
 *   purgeExpired: () => number,
 * }}
 */
export function createSessionStore({ db, now = Date.now }) {
  return {
    create(userId) {
      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      const sessionId = hashToken(token);
      const createdAt = now();
      const expiresAt = createdAt + IDLE_LIFETIME_MS;
      insertSession(db, { id: sessionId, userId, createdAt, expiresAt });
      return { token, sessionId, expiresAt };
    },

    resolve(token) {
      const sessionId = hashToken(token);
      const session = getSessionWithUser(db, sessionId);
      const current = now();
      if (!session || session.expiresAt <= current) return null;

      const remaining = session.expiresAt - current;
      let refreshedExpiresAt = null;
      if (remaining < REFRESH_THRESHOLD_MS) {
        refreshedExpiresAt = current + IDLE_LIFETIME_MS;
        setSessionExpiry(db, sessionId, refreshedExpiresAt);
      }
      return { user: session.user, sessionId, refreshedExpiresAt };
    },

    revoke(sessionId) {
      deleteSession(db, sessionId);
    },

    revokeUser(userId, { exceptSessionId = null } = {}) {
      return deleteUserSessions(db, userId, exceptSessionId);
    },

    purgeExpired() {
      return deleteExpiredSessions(db, now());
    },
  };
}
