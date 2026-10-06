// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '../src/log.js';

const ORPHAN = 'e'.repeat(64);

/**
 * @param {{ converterCmd: readonly string[] | null }} options
 */
function buildConfig({ converterCmd }) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'videothek-server-cleanup-test-'));
  const mediaRoot = path.join(tempRoot, 'media');
  mkdirSync(mediaRoot, { recursive: true });
  const dataDir = path.join(tempRoot, 'data');
  const convertDir = path.join(dataDir, 'converted');
  mkdirSync(path.join(convertDir, ORPHAN), { recursive: true });
  const config = /** @type {import('../src/config.js').Config} */ (
    Object.freeze({
      mediaRoot, dataDir, host: '127.0.0.1', port: 0, rescanIntervalMin: 15,
      adminUser: 'admin', adminPassword: 'ein-sicheres-passwort', converterCmd, convertDir, converterEnv: {},
    })
  );
  return { config, orphan: path.join(convertDir, ORPHAN), cleanup: () => rmSync(tempRoot, { recursive: true, force: true }) };
}

/** @returns {import('../src/log.js').Logger} */
function silentLogger() {
  const sink = { write: () => {} };
  return createLogger({ out: sink, err: sink });
}

/**
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 */
async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('feature on: the first completed scan triggers the cleanup pass, which removes an orphan copy directory', async () => {
  const { start } = await import('../src/server.js');
  const { config, orphan, cleanup } = buildConfig({ converterCmd: Object.freeze([process.execPath, 'unused']) });
  try {
    const result = await start({ config, log: silentLogger() });
    try {
      await waitUntil(() => !existsSync(orphan));
    } finally {
      await result.stop();
    }
  } finally {
    cleanup();
  }
});

test('feature off (no CONVERTER_CMD): a completed scan deletes nothing under CONVERT_DIR', async () => {
  const { start } = await import('../src/server.js');
  const { config, orphan, cleanup } = buildConfig({ converterCmd: null });
  try {
    const result = await start({ config, log: silentLogger() });
    try {
      const library = /** @type {import('../src/library/index.js').LibraryService} */ (result.app.deps.library);
      let scanned = false;
      library.onScanComplete(() => { scanned = true; });
      library.requestFull();
      await waitUntil(() => scanned);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(existsSync(orphan), true);
    } finally {
      await result.stop();
    }
  } finally {
    cleanup();
  }
});
