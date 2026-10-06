// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConverter } from '../../src/convert/run-converter.js';
import { runConversionJob } from '../../src/convert/job.js';
import { createConversionQueue } from '../../src/convert/queue.js';
import { fakeConfig, fakeLogger, fakeRun, convertedFlac, setup } from '../helpers/conversion-job-fixtures.js';
import { makeDb, makeTempDir, enqueueSource, waitUntil } from '../helpers/conversion-queue-fixtures.js';

const stubPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'helpers', 'converter-stub.js');
const POSIX_ONLY = { skip: process.platform === 'win32' };

/**
 * A per-job dir with `out/` and `hold/`, removed after the test.
 * @param {import('node:test').TestContext} t
 */
async function jobDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vt-run-group-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const out = path.join(dir, 'out');
  const hold = path.join(dir, 'hold');
  await fs.mkdir(out);
  await fs.mkdir(hold);
  return { dir, out, hold };
}

/**
 * Recording seams. `killProcess` records the raw arguments and forwards to the
 * real positive pid so a hung stub dies even on Windows; a gone process throws
 * ESRCH, which the runner must ignore.
 */
function seams() {
  const kills = /** @type {[number, string][]} */ ([]);
  const priorities = /** @type {[number, number][]} */ ([]);
  return {
    kills,
    priorities,
    killProcess: (/** @type {number} */ pid, /** @type {any} */ sig) => {
      kills.push([pid, sig]);
      return process.kill(Math.abs(pid), sig);
    },
    setPriority: (/** @type {number} */ pid, /** @type {number} */ prio) => {
      priorities.push([pid, prio]);
    },
  };
}

/** @param {string} p resolves once `p` exists */
async function waitForFile(p) {
  await waitUntil(() => existsSync(p), { timeoutMs: 5000, intervalMs: 20 });
}

/** @param {number} pid */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** @param {number} pid */
async function assertGone(pid) {
  await waitUntil(() => !isAlive(pid), { timeoutMs: 5000, intervalMs: 20 });
}

/**
 * @param {string[]} mode stub args
 * @param {{ dir: string, out: string }} d
 * @param {object} extra runConverter options
 */
function start(mode, d, extra) {
  return runConverter({ cmd: [process.execPath, stubPath, ...mode], env: {}, target: 'web', source: '/media/Film.mkv', outDir: d.out, cwd: d.dir, ...extra });
}

test('POSIX: stop SIGTERM and SIGKILL escalation go to the process group (-pid)', async (t) => {
  const d = await jobDir(t);
  const s = seams();
  const run = start(['--mode', 'hang', '--hold', d.hold], d, { platform: 'linux', ...s });
  await waitForFile(path.join(d.hold, 'pid'));
  const pid = Number(await fs.readFile(path.join(d.hold, 'pid'), 'utf8'));

  run.kill('SIGTERM');
  run.kill('SIGKILL');
  const result = await run.result;

  assert.deepEqual(s.kills.slice(0, 2), [[-pid, 'SIGTERM'], [-pid, 'SIGKILL']]);
  assert.equal(result.killedBy, 'stop');
  assert.deepEqual(s.priorities, [[pid, 19]]);
  assert.equal(result.priorityError, null);
});

test('POSIX: the output cap kill goes to the group and sweeps once more after exit', async (t) => {
  const d = await jobDir(t);
  const s = seams();
  const run = start(['--mode', 'flood'], d, { platform: 'linux', ...s });
  const result = await run.result;

  assert.equal(result.killedBy, 'cap');
  assert.ok(s.kills.length >= 1);
  assert.ok(s.kills.every(([pid, sig]) => pid < 0 && sig === 'SIGKILL'));
});

test('kill() after exit sends nothing and does not relabel the run', async (t) => {
  const d = await jobDir(t);
  const s = seams();
  const run = start(['--mode', 'ok'], d, { platform: 'linux', ...s });
  const result = await run.result;
  const before = s.kills.length;

  run.kill('SIGTERM');
  run.kill('SIGKILL');

  assert.equal(s.kills.length, before);
  assert.equal(result.killedBy, null);
  assert.equal(before, 0, 'a clean exit 0 is not swept');
});

test('POSIX: a non-zero exit triggers exactly one synchronous group SIGKILL; ESRCH is ignored', async (t) => {
  const d = await jobDir(t);
  const s = seams();
  const run = start(['--mode', 'fail'], d, { platform: 'linux', ...s });
  const result = await run.result;

  assert.equal(result.exitCode, 1);
  assert.equal(s.kills.length, 1);
  assert.equal(s.kills[0][0] < 0, true);
  assert.equal(s.kills[0][1], 'SIGKILL');
});

test('no pid (spawn failure): nothing is signalled or prioritised', async () => {
  const s = seams();
  const missing = path.join(os.tmpdir(), 'vt-missing-executable-does-not-exist');
  const run = runConverter({ cmd: [missing], env: {}, target: 'web', source: '/m/F.mkv', outDir: os.tmpdir(), cwd: os.tmpdir(), platform: 'linux', ...s });
  run.kill('SIGTERM');
  const result = await run.result;

  assert.equal(result.spawnError, 'ENOENT');
  assert.deepEqual(s.kills, []);
  assert.deepEqual(s.priorities, []);
  assert.equal(result.priorityError, null);
});

test('Windows path: child.kill() is used, never killProcess, and priority is still set', async (t) => {
  const d = await jobDir(t);
  const s = seams();
  const run = start(['--mode', 'hang', '--hold', d.hold], d, { platform: 'win32', ...s });
  await waitForFile(path.join(d.hold, 'pid'));
  const pid = Number(await fs.readFile(path.join(d.hold, 'pid'), 'utf8'));

  run.kill('SIGTERM');
  const result = await run.result;

  assert.equal(result.killedBy, 'stop');
  assert.deepEqual(s.kills, []);
  assert.deepEqual(s.priorities, [[pid, 19]]);
  await assertGone(pid);
});

test('a throwing setPriority is reported as priorityError and the run still completes', async (t) => {
  const d = await jobDir(t);
  const run = start(['--mode', 'ok'], d, {
    setPriority: () => {
      throw Object.assign(new Error('boom'), { code: 'EACCES' });
    },
  });
  const result = await run.result;

  assert.equal(result.priorityError, 'EACCES');
  assert.equal(result.exitCode, 0);
});

test('the job logs conversion_priority_failed { key, code } and still converts', async (t) => {
  const { db, convertDirReal, mediaRoot, row } = await setup(t);
  const { run } = fakeRun(async (args) => {
    return { ...(await convertedFlac(args)), priorityError: 'EACCES' };
  });
  const { log, calls } = fakeLogger();
  await runConversionJob({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, convertDirReal, row, isStopping: () => false });

  const warn = calls.find((c) => c.event === 'conversion_priority_failed');
  assert.deepEqual(warn?.fields, { key: row.storage_key, code: 'EACCES' });
  assert.equal(calls.at(-1)?.fields?.status, 'playable');
});

/** @param {string} dir @returns {string[]} every entry below `dir`, relative */
function listFiles(dir) {
  try {
    return /** @type {string[]} */ (/** @type {unknown} */ (readdirSync(dir, { recursive: true })));
  } catch {
    return [];
  }
}

test('POSIX integration: a long-lived grandchild is gone after the queue stop()', POSIX_ONLY, async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const convertDir = await makeTempDir(t, 'vt-group-convert-');
  const mediaRoot = await makeTempDir(t, 'vt-group-media-');
  await enqueueSource(db, mediaRoot, 'Hoerbuecher/a.mp3');
  const config = Object.freeze({
    ...fakeConfig(mediaRoot, convertDir),
    converterCmd: Object.freeze([process.execPath, stubPath, '--mode', 'grandchild']),
    converterEnv: Object.freeze({}),
  });
  const { log } = fakeLogger();
  const queue = createConversionQueue({ db, config, log, now: () => 1, killGraceMs: 2000 });
  assert.equal(await queue.start(), true);
  queue.kick();

  /** @type {string | null} */
  let pidFile = null;
  await waitUntil(() => {
    const hit = listFiles(convertDir).find((f) => f.endsWith('grandchild.pid'));
    pidFile = hit ? path.join(convertDir, hit) : null;
    return pidFile !== null;
  }, { timeoutMs: 5000, intervalMs: 20 });
  const pid = Number(await fs.readFile(String(pidFile), 'utf8'));
  assert.ok(isAlive(pid));

  await queue.stop();
  await assertGone(pid);
});

test('POSIX integration: a long-lived grandchild is gone after the cap kill', POSIX_ONLY, async (t) => {
  const d = await jobDir(t);
  const run = start(['--mode', 'grandchild-flood'], d, {});
  const result = await run.result;

  assert.equal(result.killedBy, 'cap');
  const pid = Number(await fs.readFile(path.join(d.out, 'grandchild.pid'), 'utf8'));
  await assertGone(pid);
});
