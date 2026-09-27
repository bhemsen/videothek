import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs, { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '../src/log.js';

/**
 * A hand-built, already-valid `Config` (bypassing `loadConfig`/env) so each
 * test controls `host`/`port`/admin credentials directly.
 * @returns {{ config: import('../src/config.js').Config, cleanup: () => void }}
 */
function buildTestConfig() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'videothek-server-test-'));
  const mediaRoot = path.join(tempRoot, 'media');
  mkdirSync(mediaRoot, { recursive: true });
  const config = /** @type {import('../src/config.js').Config} */ (
    Object.freeze({
      mediaRoot,
      dataDir: path.join(tempRoot, 'data'),
      host: '127.0.0.1',
      port: 0,
      rescanIntervalMin: 15,
      adminUser: 'admin',
      adminPassword: 'ein-sicheres-passwort',
    })
  );
  return { config, cleanup: () => rmSync(tempRoot, { recursive: true, force: true }) };
}

/**
 * @returns {{ log: import('../src/log.js').Logger, logLines: string[] }}
 */
function silentLogger() {
  /** @type {string[]} */
  const logLines = [];
  const sink = { write: (/** @type {string} */ chunk) => void logLines.push(chunk) };
  return { log: createLogger({ out: sink, err: sink }), logLines };
}

/**
 * @returns {number} how many TCP servers this process currently has open
 */
function listeningServerCount() {
  return process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap').length;
}

/**
 * Loads `start` lazily so the first test below is the one that actually
 * imports (and thus evaluates) `src/server.js` in this test file.
 * @returns {Promise<typeof import('../src/server.js').start>}
 */
async function loadStart() {
  return (await import('../src/server.js')).start;
}

test('importing src/server.js starts nothing (no signal handlers, nothing listening)', async () => {
  // No static import of src/server.js in this file: these baselines are
  // taken before the module is evaluated for the first time.
  const sigintBefore = process.listenerCount('SIGINT');
  const sigtermBefore = process.listenerCount('SIGTERM');
  const serversBefore = listeningServerCount();
  // `getActiveResourcesInfo` hides unref'd servers, so additionally spy on
  // every `listen()` call (http.Server inherits net.Server's) while importing.
  const originalListen = net.Server.prototype.listen;
  let listenCalls = 0;
  net.Server.prototype.listen = /** @type {typeof originalListen} */ (
    /** @this {net.Server} @param {unknown[]} args */
    function spiedListen(...args) {
      listenCalls += 1;
      return Reflect.apply(originalListen, this, args);
    }
  );
  try {
    const mod = await import('../src/server.js');
    assert.equal(typeof mod.start, 'function');
    // Give a (wrongly) import-time listen() a turn of the event loop to bind.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    net.Server.prototype.listen = originalListen;
  }

  assert.equal(process.listenerCount('SIGINT'), sigintBefore);
  assert.equal(process.listenerCount('SIGTERM'), sigtermBefore);
  assert.equal(listeningServerCount(), serversBefore);
  assert.equal(listenCalls, 0);
});

test('start() bootstraps the admin, listens, and stop() closes everything', async () => {
  const start = await loadStart();
  const { config, cleanup } = buildTestConfig();
  const { log, logLines } = silentLogger();
  try {
    const result = await start({ config, log });
    assert.equal(result.config, config);
    assert.ok(result.app.server.listening);
    assert.ok(logLines.some((line) => line.includes('"startup"')));
    assert.ok(logLines.some((line) => line.includes('admin_bootstrapped')));
    assert.ok(logLines.some((line) => line.includes('"listening"')));

    await result.stop();
    assert.equal(result.app.server.listening, false);
  } finally {
    cleanup();
  }
});

test('a second start() against the same data dir skips bootstrap (admin_env_ignored)', async () => {
  const start = await loadStart();
  const { config, cleanup } = buildTestConfig();
  try {
    const first = silentLogger();
    const firstRun = await start({ config, log: first.log });
    await firstRun.stop();

    const second = silentLogger();
    const secondRun = await start({ config, log: second.log });
    try {
      assert.ok(second.logLines.some((line) => line.includes('admin_env_ignored')));
    } finally {
      await secondRun.stop();
    }
  } finally {
    cleanup();
  }
});

test('stop() resolves promptly after its 5s force-close timer with a request in flight, and is idempotent', async () => {
  const start = await loadStart();
  const { config, cleanup } = buildTestConfig();
  const { log } = silentLogger();
  try {
    const result = await start({ config, log });
    const address = result.app.server.address();
    const port = address && typeof address === 'object' ? address.port : 0;

    const socket = net.createConnection({ port, host: '127.0.0.1' });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    // Sent but never fully consumed — an in-flight, still-open connection
    // for stop() to deal with, exercising closeIdleConnections/
    // closeAllConnections rather than a clean, already-finished exchange.
    socket.write('GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');

    const startedAt = Date.now();
    const stopping = result.stop();
    // A concurrent second call must share the in-flight shutdown, not
    // resolve early while connections and the DB are still open.
    assert.equal(result.stop(), stopping);
    await stopping;
    const elapsedMs = Date.now() - startedAt;
    // Acceptance for #17 requires stop() to resolve within 6s while a
    // request is still open; the force-close timer itself is a fixed 5s, so
    // 6s leaves 1s of headroom without loosening past the spec's bound.
    assert.ok(elapsedMs <= 6000, `stop() took ${elapsedMs}ms`);

    await result.stop(); // idempotent: a second call must not reject or hang
    socket.destroy();
  } finally {
    cleanup();
  }
});

test('start() on a fresh DB without admin env exits before listening (admin_missing)', async () => {
  const start = await loadStart();
  const { config, cleanup } = buildTestConfig();
  // A fresh DB with no ADMIN_USER/ADMIN_PASSWORD: ensureAdmin throws
  // BootstrapError, already logged internally as `admin_missing` — real
  // invalid-*environment* rejection (ConfigError) is config.test.js's job.
  const badConfig = /** @type {import('../src/config.js').Config} */ ({
    ...config,
    adminUser: null,
    adminPassword: null,
  });
  const { log, logLines } = silentLogger();
  const serversBefore = listeningServerCount();
  const originalExit = process.exit;
  /** @type {number | undefined} */
  let exitCode;
  process.exit = /** @type {typeof process.exit} */ ((code) => {
    exitCode = /** @type {number} */ (code);
    throw new Error('process.exit called');
  });
  try {
    await assert.rejects(() => start({ config: badConfig, log }));
    assert.equal(exitCode, 1);
    assert.ok(logLines.some((line) => line.includes('admin_missing')));
    assert.equal(listeningServerCount(), serversBefore);
  } finally {
    process.exit = originalExit;
    cleanup();
  }
});
test('start() hands the library service to the app, and stop() stops it before closing the DB', async (t) => {
  const start = await loadStart();
  const { config, cleanup } = buildTestConfig();
  const { log } = silentLogger();
  try {
    const result = await start({ config, log });
    const library = result.app.deps.library;
    assert.ok(library, 'createApp must receive the running library service as deps.library');
    assert.equal(typeof library.status, 'function');

    /** @type {string[]} */
    const order = [];
    const originalStop = library.stop.bind(library);
    const originalClose = result.db.close.bind(result.db);
    t.mock.method(library, 'stop', async () => {
      order.push('library.stop');
      await originalStop();
      order.push('library.stopped');
    });
    t.mock.method(result.db, 'close', () => {
      order.push('db.close');
      originalClose();
    });

    await result.stop();
    assert.deepEqual(order, ['library.stop', 'library.stopped', 'db.close']);
  } finally {
    cleanup();
  }
});

test('a listen failure after the library started stops it before closing the DB (no watch or scan leaks)', async (t) => {
  const start = await loadStart();
  const { config, cleanup } = buildTestConfig();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (blocker.address());
  const busyConfig = /** @type {import('../src/config.js').Config} */ ({ ...config, port: address.port });
  const { log, logLines } = silentLogger();
  const watch = t.mock.method(fs, 'watch');
  const originalExit = process.exit;
  process.exit = /** @type {typeof process.exit} */ (() => {
    throw new Error('process.exit called');
  });
  try {
    await assert.rejects(() => start({ config: busyConfig, log }));
    // Give the library's deferred boot every chance to run had it not been stopped.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(watch.mock.callCount(), 0, 'no watch may be opened by a library whose server never started');
    assert.ok(logLines.some((line) => line.includes('startup_failed')));
    assert.ok(!logLines.some((line) => line.includes('library_scan')), 'no scan may run against the closed DB');
  } finally {
    process.exit = originalExit;
    await new Promise((resolve) => blocker.close(() => resolve(undefined)));
    cleanup();
  }
});
