/**
 * Process entry: assembles the app via `createApp` and drives its
 * lifecycle. Importing this module starts nothing — `start()` (and the
 * bottom-of-file entry block, gated by realpath entry detection) are the
 * only things that do.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { BootstrapError, ensureAdmin } from './auth/bootstrap.js';
import { ConfigError, loadConfig } from './config.js';
import { migrate, openDatabase } from './db/index.js';
import { startLibrary } from './library/index.js';
import { createLogger } from './log.js';

const PURGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * @param {string} argv1Path
 * @returns {boolean}
 */
function isEntryPoint(argv1Path) {
  try {
    return realpathSync(argv1Path) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/**
 * Opens the listening socket, removing the temporary startup error listener
 * once `listen` succeeds so a later runtime error on the server is not
 * silently swallowed (no global crash handlers — the supervisor restarts).
 * @param {import('node:http').Server} server
 * @param {string} host
 * @param {number} port
 * @returns {Promise<void>}
 */
function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (/** @type {Error} */ err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(undefined);
    });
  });
}

/**
 * Builds the idempotent, memoised `stop()`: clears the purge timer, stops accepting
 * new connections and drops idle ones immediately, force-closes any
 * still-open connections after 5 s (long-lived media streams), then closes
 * the database.
 * @param {{
 *   app: ReturnType<typeof createApp>,
 *   db: import('node:sqlite').DatabaseSync,
 *   log: import('./log.js').Logger,
 *   purgeTimer: NodeJS.Timeout,
 *   library: import('./library/index.js').LibraryService,
 * }} options
 * @returns {() => Promise<void>}
 */
function createStop({ app, db, log, purgeTimer, library }) {
  /** @type {Promise<void> | null} */
  let stopping = null;
  const run = async () => {
    clearInterval(purgeTimer);
    app.server.closeIdleConnections();
    const forceTimer = setTimeout(() => app.server.closeAllConnections(), 5000);
    try {
      await app.close();
    } finally {
      // Even when closing the server fails, the DB must not stay open (and
      // locked on Windows) and the shutdown must be on record.
      clearTimeout(forceTimer);
      try {
        await library.stop();
      } finally {
        db.close();
        log.info('shutdown');
      }
    }
  };
  // Memoised: a second call while the first is in flight (or after it
  // finished) returns the same promise instead of resolving early.
  return function stop() {
    stopping ??= run();
    return stopping;
  };
}

/**
 * Installs SIGINT/SIGTERM handlers for graceful shutdown: the first signal
 * runs `stop()` then exits (0, or 1 if `stop()` itself fails); a second
 * signal received before that finishes exits 1 immediately.
 * @param {() => Promise<void>} stop
 * @param {import('./log.js').Logger} log
 * @returns {void}
 */
function installSignalHandlers(stop, log) {
  let signalCount = 0;
  const onSignal = () => {
    signalCount += 1;
    if (signalCount > 1) {
      process.exit(1);
      return;
    }
    stop()
      .then(() => process.exit(0))
      .catch((err) => {
        log.error('shutdown_failed', { error: err });
        process.exit(1);
      });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

/**
 * The real startup sequence, letting every failure (`ConfigError`,
 * `MigrationError`, `BootstrapError`, a listen error) propagate to the
 * single handler in {@link start}. Logs `startup` first, before config is
 * even loaded, so an attempt is on record even when it fails immediately.
 * @param {import('./config.js').Config | undefined} providedConfig
 * @param {import('./log.js').Logger} log
 * @returns {Promise<{
 *   app: ReturnType<typeof createApp>,
 *   db: import('node:sqlite').DatabaseSync,
 *   config: import('./config.js').Config,
 *   stop: () => Promise<void>,
 * }>}
 */
async function runStart(providedConfig, log) {
  log.info('startup');
  const config = providedConfig ?? loadConfig();
  const db = openDatabase(config.dataDir);
  try {
    migrate(db, { log });
    await ensureAdmin({ db, adminUser: config.adminUser, adminPassword: config.adminPassword, log });

    const library = startLibrary({ db, config, log });
    const app = createApp({ config, db, log, library });
    await listen(app.server, config.host, config.port);
    log.info('listening', { host: config.host, port: config.port });

    app.deps.sessions.purgeExpired();
    const purgeTimer = setInterval(() => app.deps.sessions.purgeExpired(), PURGE_INTERVAL_MS);
    purgeTimer.unref();

    return { app, db, config, stop: createStop({ app, db, log, purgeTimer, library }) };
  } catch (err) {
    // Nothing past `openDatabase` succeeded (or `listen` itself failed): the
    // process is about to exit, but the DB connection must not leak — on
    // Windows in particular, an open `DatabaseSync` keeps `videothek.db*`
    // locked, which would otherwise fail a caller's own cleanup.
    db.close();
    throw err;
  }
}

/**
 * Logs a startup failure appropriately for its kind. `ConfigError` gets the
 * constitution's `config_invalid {problems}` line (names and rules, never
 * values); `BootstrapError` needs no extra line — `ensureAdmin` already
 * logged `admin_missing` with guidance; anything else (a broken migration,
 * a listen failure such as `EADDRINUSE`, …) gets a generic line so the
 * cause is never silently lost.
 * @param {unknown} err
 * @param {import('./log.js').Logger} log
 * @returns {void}
 */
function logStartupFailure(err, log) {
  if (err instanceof ConfigError) {
    log.error('config_invalid', { problems: err.problems });
  } else if (!(err instanceof BootstrapError)) {
    log.error('startup_failed', { error: err });
  }
}

/**
 * Entry orchestration: config -> DB -> migrate -> bootstrap -> createApp ->
 * listen -> startup purge + hourly timer. Any failure along the way logs
 * and exits the process with code 1 before it ever listens. SIGINT/SIGTERM
 * handlers are installed only when this module is the actual process entry
 * (realpath comparison against `process.argv[1]`), so importing it in tests
 * never hijacks the test runner's signals.
 * @param {{ config?: import('./config.js').Config, log?: import('./log.js').Logger }} [options]
 * @returns {Promise<{
 *   app: ReturnType<typeof createApp>,
 *   db: import('node:sqlite').DatabaseSync,
 *   config: import('./config.js').Config,
 *   stop: () => Promise<void>,
 * }>}
 */
export async function start({ config: providedConfig, log: providedLog } = {}) {
  const log = providedLog ?? createLogger();
  try {
    const result = await runStart(providedConfig, log);
    if (isEntryPoint(process.argv[1] ?? '')) installSignalHandlers(result.stop, log);
    return result;
  } catch (err) {
    logStartupFailure(err, log);
    process.exit(1);
  }
}

if (isEntryPoint(process.argv[1] ?? '')) {
  start();
}
