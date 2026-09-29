import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConverter } from '../../src/convert/run-converter.js';

const stubPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'helpers', 'converter-stub.js');

/**
 * A fresh per-job dir with an `out/` subdir, removed after the test.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{ dir: string, out: string }>}
 */
async function jobDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vt-run-kill-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const out = path.join(dir, 'out');
  await fsp.mkdir(out);
  return { dir, out };
}

/** @param {string} p resolves once `p` exists, polling every 20 ms */
function waitForFile(p) {
  return new Promise((resolve) => {
    const check = () => (existsSync(p) ? resolve(undefined) : setTimeout(check, 20));
    check();
  });
}

test("kill('SIGTERM') on a hung child settles with killedBy='stop' and actually stops it", async (t) => {
  const { dir, out } = await jobDir(t);
  const hold = path.join(dir, 'hold');
  await fsp.mkdir(hold);
  const run = runConverter({ cmd: [process.execPath, stubPath, '--mode', 'hang', '--hold', hold], env: {}, target: 'web', source: '/media/Film.mkv', outDir: out, cwd: dir });

  await waitForFile(path.join(hold, 'pid'));
  const pid = Number(fs.readFileSync(path.join(hold, 'pid'), 'utf8'));

  run.kill('SIGTERM');
  const result = await run.result;

  assert.equal(result.killedBy, 'stop');
  assert.equal(result.spawnError, null);

  // Give the OS a moment to finish reaping the process, then confirm it is
  // really gone (not merely reported as such).
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.throws(() => process.kill(pid, 0), 'the hung child must no longer be running');
});

test('a run ended by kill() is never confused with the output cap', async (t) => {
  const { dir, out } = await jobDir(t);
  const hold = path.join(dir, 'hold');
  await fsp.mkdir(hold);
  const run = runConverter({ cmd: [process.execPath, stubPath, '--mode', 'hang', '--hold', hold], env: {}, target: 'web', source: '/media/Film.mkv', outDir: out, cwd: dir });

  await waitForFile(path.join(hold, 'pid'));
  run.kill('SIGTERM');
  const result = await run.result;

  assert.equal(result.killedBy, 'stop');
  assert.equal(result.stdoutInvalid, false);
});
