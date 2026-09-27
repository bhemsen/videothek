/**
 * In-process app harness shared by every phase's tests: boots the full
 * `createApp` stack on `127.0.0.1:0` against temp `DATA_DIR`/`MEDIA_ROOT`
 * directories, with migrations applied but no admin bootstrap (tests seed
 * their own users) and a silent logger that captures lines instead of
 * writing them.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyPassword, hashPassword } from '../../src/auth/password.js';
import { validateUsername } from '../../src/auth/validation.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { migrate, openDatabase } from '../../src/db/index.js';
import { getUserByUsername, insertUser } from '../../src/db/users.js';
import { createLogger } from '../../src/log.js';

/** @typedef {'admin' | 'user'} UserRole */

/**
 * @param {() => number} now
 * @returns {{ log: import('../../src/log.js').Logger, logLines: string[] }}
 */
function createSilentLogger(now) {
  /** @type {string[]} */
  const logLines = [];
  const sink = { write: (/** @type {string} */ chunk) => void logLines.push(chunk) };
  return { log: createLogger({ out: sink, err: sink, now }), logLines };
}

/**
 * Resolves the temp directories: `DATA_DIR` is always our own (removed on
 * `close`); `MEDIA_ROOT` is the caller's own path when given (never
 * created or removed here), otherwise an empty temp directory of our own.
 * @param {string | undefined} mediaRoot
 * @returns {{ tempRoot: string, dataDir: string, mediaRoot: string }}
 */
function resolveDirs(mediaRoot) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'videothek-test-'));
  const dataDir = path.join(tempRoot, 'data');
  if (mediaRoot !== undefined) return { tempRoot, dataDir, mediaRoot };
  const ownMediaRoot = path.join(tempRoot, 'media');
  mkdirSync(ownMediaRoot, { recursive: true });
  return { tempRoot, dataDir, mediaRoot: ownMediaRoot };
}

/**
 * Opens + migrates the DB, assembles the app and listens on an ephemeral
 * port. If any step throws, the opened DB, a half-started server and the
 * temp directory are released before rethrowing, so a failed setup leaks
 * nothing (an open `DatabaseSync` would keep the files locked on Windows).
 * @param {{
 *   config: import('../../src/config.js').Config,
 *   log: import('../../src/log.js').Logger,
 *   now: () => number,
 *   extra: Record<string, unknown>,
 *   tempRoot: string,
 * }} options
 * @returns {Promise<{ db: import('node:sqlite').DatabaseSync, app: ReturnType<typeof createApp> }>}
 */
async function bootApp({ config, log, now, extra, tempRoot }) {
  /** @type {import('node:sqlite').DatabaseSync | null} */
  let db = null;
  /** @type {ReturnType<typeof createApp> | null} */
  let app = null;
  try {
    db = openDatabase(config.dataDir);
    migrate(db);
    app = createApp({ config, db, log, now, ...extra });
    const { server } = app;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve(undefined);
      });
    });
    return { db, app };
  } catch (err) {
    if (app?.server.listening) await app.close().catch(() => {});
    db?.close();
    rmSync(tempRoot, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Starts the app in-process for tests.
 * @param {{ mediaRoot?: string, now?: () => number, [key: string]: unknown }} [options]
 * @returns {Promise<{
 *   baseUrl: string,
 *   db: import('node:sqlite').DatabaseSync,
 *   config: import('../../src/config.js').Config,
 *   deps: import('../../src/app.js').AppDeps & { logLines: string[] },
 *   router: ReturnType<typeof import('../../src/http/router.js').createRouter>,
 *   server: import('node:http').Server,
 *   createUser: (username: string, password: string, role?: UserRole) => Promise<{ id: number, username: string, role: UserRole }>,
 *   login: (username: string, password: string) => Promise<string>,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startTestApp({ mediaRoot, now = Date.now, ...extra } = {}) {
  const { tempRoot, dataDir, mediaRoot: resolvedMediaRoot } = resolveDirs(mediaRoot);
  const config = loadConfig({ MEDIA_ROOT: resolvedMediaRoot, DATA_DIR: dataDir });
  const { log, logLines } = createSilentLogger(now);
  const { db, app } = await bootApp({ config, log, now, extra, tempRoot });
  const { server, deps, router, close: closeApp } = app;
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;

  // Attaches `logLines` to the app's own `deps` object (rather than handing
  // back a shallow copy) so `app.deps` stays identical to the object the
  // running server actually dispatches with.
  const appDeps = /** @type {import('../../src/app.js').AppDeps & { logLines: string[] }} */ (deps);
  appDeps.logLines = logLines;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    db,
    config,
    deps: appDeps,
    router,
    server,
    async createUser(username, password, role = 'user') {
      const normalized = validateUsername(username);
      if (normalized === null) throw new Error(`startTestApp.createUser: invalid username ${username}`);
      const passwordHash = await hashPassword(password);
      const row = insertUser(db, { username: normalized, passwordHash, role, createdAt: now() });
      return { id: row.id, username: row.username, role: row.role };
    },
    async login(username, password) {
      const normalized = validateUsername(username) ?? username;
      const user = getUserByUsername(db, normalized);
      if (!user || !(await verifyPassword(password, user.password_hash))) {
        throw new Error(`startTestApp.login: no matching test user ${username}`);
      }
      const { token } = deps.sessions.create(user.id);
      return `vt_session=${token}`;
    },
    async close() {
      try {
        await closeApp();
      } finally {
        db.close();
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  };
}
