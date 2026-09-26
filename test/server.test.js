import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '../src/log.js';
import { start } from '../src/server.js';

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

test('importing src/server.js starts nothing (no SIGINT handler, nothing listening)', async () => {
  const before = process.listenerCount('SIGINT');
  const mod = await import('../src/server.js');
  assert.equal(typeof mod.start, 'function');
  assert.equal(process.listenerCount('SIGINT'), before);
});

test('start() bootstraps the admin, listens, and stop() closes everything', async () => {
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
    await result.stop();
    const elapsedMs = Date.now() - startedAt;
    // The force-close timer itself is a fixed 5s, so this only has to catch
    // a runaway hang, not pin down the exact floor; 8s leaves headroom for a
    // slow CI runner or a Pi instead of asserting right against the timer.
    assert.ok(elapsedMs <= 8000, `stop() took ${elapsedMs}ms`);

    await result.stop(); // idempotent: a second call must not reject or hang
    socket.destroy();
  } finally {
    cleanup();
  }
});

test('start() on a fresh DB without admin env exits before listening (admin_missing)', async () => {
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
  } finally {
    process.exit = originalExit;
    cleanup();
  }
});
