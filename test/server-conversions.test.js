import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '../src/log.js';
import { migrate, openDatabase } from '../src/db/index.js';
import { upsertItem } from '../src/db/library-repo.js';
import { enqueueConversion, getConversion } from '../src/db/conversions.js';
import { storageKey } from '../src/convert/targets.js';
import { SCAN_VERSION } from '../src/library/parsers/compat.js';

const STUB_PATH = path.resolve('test/helpers/converter-stub.js');

/**
 * A hand-built, already-valid `Config` (bypassing `loadConfig`/env, like
 * `test/server.test.js`'s own `buildTestConfig`), extended with the
 * conversion fields this test controls directly.
 * @param {{ converterCmd?: readonly string[] | null }} [overrides]
 * @returns {{ config: import('../src/config.js').Config, mediaRoot: string, cleanup: () => void }}
 */
function buildTestConfig({ converterCmd = null } = {}) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'videothek-server-conversions-test-'));
  const mediaRoot = path.join(tempRoot, 'media');
  mkdirSync(mediaRoot, { recursive: true });
  const dataDir = path.join(tempRoot, 'data');
  const config = /** @type {import('../src/config.js').Config} */ (
    Object.freeze({
      mediaRoot,
      dataDir,
      host: '127.0.0.1',
      port: 0,
      rescanIntervalMin: 15,
      adminUser: 'admin',
      adminPassword: 'ein-sicheres-passwort',
      converterCmd,
      convertDir: path.join(dataDir, 'converted'),
      converterEnv: {},
    })
  );
  return { config, mediaRoot, cleanup: () => rmSync(tempRoot, { recursive: true, force: true }) };
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
 * Loads `start` lazily, matching `test/server.test.js`'s own convention (no
 * static import of `src/server.js` in this file).
 * @returns {Promise<typeof import('../src/server.js').start>}
 */
async function loadStart() {
  return (await import('../src/server.js')).start;
}

/**
 * Polls for `p` to exist, so the stub's `--hold` handshake can be awaited
 * without a fixed sleep.
 * @param {string} p
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function waitForFile(p, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(p)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${p}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('startup recovery: a converting row becomes failed/interrupted, a queued row stays, and CONVERTER_CMD unset disables the feature', async () => {
  const start = await loadStart();
  const { config, cleanup } = buildTestConfig();
  const { log, logLines } = silentLogger();
  const db = openDatabase(config.dataDir);
  migrate(db);
  enqueueConversion(db, { relPath: 'Filme/a.mkv', storageKey: 'a'.repeat(64), target: 'web', sourceSize: 10, sourceMtimeMs: 1, now: 1 });
  enqueueConversion(db, { relPath: 'Filme/b.mkv', storageKey: 'b'.repeat(64), target: 'web', sourceSize: 10, sourceMtimeMs: 1, now: 2 });
  db.prepare("UPDATE conversions SET status = 'converting', started_at = ? WHERE rel_path = ?").run(5, 'Filme/a.mkv');
  db.close();

  try {
    const result = await start({ config, log });
    try {
      assert.ok(logLines.some((line) => line.includes('"conversions_recovered"') && line.includes('"count":1')));
      assert.ok(logLines.some((line) => line.includes('"conversion_disabled"')));
      assert.ok(!logLines.some((line) => line.includes('"conversion_enabled"')));

      const recovered = getConversion(result.db, 'Filme/a.mkv');
      assert.equal(recovered?.status, 'failed');
      assert.equal(recovered?.error, 'interrupted');
      const stillQueued = getConversion(result.db, 'Filme/b.mkv');
      assert.equal(stillQueued?.status, 'queued');

      assert.equal(result.app.deps.conversions, undefined);
    } finally {
      await result.stop();
    }
  } finally {
    cleanup();
  }
});

test('wiring with the feature on: kick() runs the queued job, and stop() ends it failed/interrupted with the process gone', async () => {
  const holdDir = mkdtempSync(path.join(tmpdir(), 'videothek-hold-'));
  const { config, mediaRoot, cleanup } = buildTestConfig({
    converterCmd: Object.freeze([process.execPath, STUB_PATH, '--mode', 'hang', '--hold', holdDir]),
  });
  const start = await loadStart();
  const { log, logLines } = silentLogger();

  const relPath = 'Filme/x.mkv';
  const categoryDir = path.join(mediaRoot, 'Filme');
  mkdirSync(categoryDir, { recursive: true });
  const filePath = path.join(categoryDir, 'x.mkv');
  writeFileSync(filePath, 'not a real video, just needs bytes');
  const stat = statSync(filePath);

  const db = openDatabase(config.dataDir);
  migrate(db);
  // Matching size/mtime_ms/scan_version so the deferred startup scan
  // (src/library/index.js, setImmediate) treats the row as unchanged.
  upsertItem(
    db,
    {
      rel_path: relPath,
      dir: 'Filme',
      category: 'movies',
      kind: 'video',
      ext: 'mkv',
      title: 'x',
      sort_title: 'x',
      playable: false,
      size: stat.size,
      mtime_ms: Math.trunc(stat.mtimeMs),
      scan_version: SCAN_VERSION,
    },
    1
  );
  enqueueConversion(db, {
    relPath,
    storageKey: storageKey(relPath),
    target: 'web',
    sourceSize: stat.size,
    sourceMtimeMs: Math.trunc(stat.mtimeMs),
    now: 1,
  });
  db.close();

  try {
    const result = await start({ config, log });
    try {
      assert.ok(result.app.deps.conversions, 'deps.conversions must be set when the feature is on');
      assert.ok(logLines.some((line) => line.includes('"conversion_enabled"')));

      await waitForFile(path.join(holdDir, 'pid'));
      const pid = Number(readFileSync(path.join(holdDir, 'pid'), 'utf8').trim());

      await result.stop();

      assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the stub process must no longer be running');

      const reopened = openDatabase(config.dataDir);
      try {
        const row = getConversion(reopened, relPath);
        assert.equal(row?.status, 'failed');
        assert.equal(row?.error, 'interrupted');
      } finally {
        reopened.close();
      }
    } finally {
      await result.stop(); // idempotent safety net if an assertion above threw first
    }
  } finally {
    cleanup();
    rmSync(holdDir, { recursive: true, force: true });
  }
});
