import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConverter } from '../../src/convert/run-converter.js';

const stubPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'helpers', 'converter-stub.js');

/**
 * A fresh per-job dir with an `out/` subdir, removed after the test - the
 * same shape `runConverter` expects (`cwd` is the job dir, `outDir` its
 * `out/` child).
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{ dir: string, out: string }>}
 */
async function jobDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vt-run-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const out = path.join(dir, 'out');
  await fs.mkdir(out);
  return { dir, out };
}

test('a successful conversion settles with the parsed record and no failure flags', async (t) => {
  const { dir, out } = await jobDir(t);
  const run = runConverter({ cmd: [process.execPath, stubPath], env: {}, target: 'web', source: '/media/Film.mkv', outDir: out, cwd: dir });

  const result = await run.result;

  assert.equal(result.spawnError, null);
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.killedBy, null);
  assert.equal(result.stdoutInvalid, false);
  assert.equal(result.stdioTimedOut, false);
  assert.deepEqual(result.records, [
    { type: 'file', outcome: 'converted', output: path.join(out, 'Film.mp4'), error: null, notes: [], sidecars: [] },
    { type: 'summary', total: 1, exitCode: 0 },
  ]);
});

test('argv reaches the stub exactly as cmd + --to/--json/source/outDir; a source with punctuation and spaces is one argument', async (t) => {
  const { dir, out } = await jobDir(t);
  const source = '/media/movies/A;B$(rm -rf) D E.mkv';
  const run = runConverter({ cmd: [process.execPath, stubPath, '--mode', 'echo'], env: {}, target: 'web', source, outDir: out, cwd: dir });

  await run.result;

  const echo = JSON.parse(await fs.readFile(path.join(out, 'echo.json'), 'utf8'));
  assert.deepEqual(echo.argv.slice(2), ['--mode', 'echo', '--to', 'web', '--json', source, out]);
});

test('env equals the given object on posix, and a case-insensitive bounded superset on win32; ADMIN_PASSWORD never present', async (t) => {
  const { dir, out } = await jobDir(t);
  const givenEnv = { MY_TEST_VAR: 'value123' };
  const run = runConverter({ cmd: [process.execPath, stubPath, '--mode', 'echo'], env: givenEnv, target: 'web', source: '/media/Film.mkv', outDir: out, cwd: dir });

  await run.result;

  const echo = JSON.parse(await fs.readFile(path.join(out, 'echo.json'), 'utf8'));
  if (process.platform !== 'win32') {
    assert.deepEqual(echo.env, givenEnv);
  } else {
    assert.equal(echo.env.MY_TEST_VAR, 'value123');
    const libuvKeys = new Set(['homedrive', 'homepath', 'logonserver', 'path', 'systemdrive', 'systemroot', 'temp', 'userdomain', 'username', 'userprofile', 'windir']);
    for (const key of Object.keys(echo.env)) {
      const lower = key.toLowerCase();
      assert.ok(lower === 'my_test_var' || libuvKeys.has(lower), `unexpected extra env var reached the child: ${key}`);
    }
  }
  assert.equal(echo.env.ADMIN_PASSWORD, undefined);
});

test("the child's cwd is the given per-job dir", async (t) => {
  const { dir, out } = await jobDir(t);
  const run = runConverter({ cmd: [process.execPath, stubPath, '--mode', 'echo'], env: {}, target: 'web', source: '/media/Film.mkv', outDir: out, cwd: dir });

  await run.result;

  const echo = JSON.parse(await fs.readFile(path.join(out, 'echo.json'), 'utf8'));
  assert.equal(await fs.realpath(echo.cwd), await fs.realpath(dir));
});

test('the 1 MiB total cap kills flood: killedBy=cap, stdoutInvalid, and stdout accumulation stops before the whole flood is parsed', async (t) => {
  const { dir, out } = await jobDir(t);
  const run = runConverter({ cmd: [process.execPath, stubPath, '--mode', 'flood'], env: {}, target: 'web', source: '/media/Film.mkv', outDir: out, cwd: dir });

  const result = await run.result;

  assert.equal(result.killedBy, 'cap');
  assert.equal(result.stdoutInvalid, true);

  // Mirrors the stub's own flood loop to compute the full, uncapped line
  // count: the cap must always stop strictly before that (at least the
  // final, over-cap chunk's lines are dropped unparsed).
  const lineLength = Buffer.byteLength(`${JSON.stringify({ type: 'file', schema: 1, outcome: 'skipped' })}\n`);
  let written = 0;
  let fullLineCount = 0;
  while (written < 1024 * 1024 + 4096) {
    written += lineLength;
    fullLineCount++;
  }
  assert.ok(result.records.length < fullLineCount, `expected fewer than ${fullLineCount} records, got ${result.records.length}`);
});

test("orphan-pipe settles about closeGraceMs after 'exit' with stdioTimedOut=true", async (t) => {
  const { dir, out } = await jobDir(t);
  const closeGraceMs = 200;
  const started = Date.now();
  const run = runConverter({ cmd: [process.execPath, stubPath, '--mode', 'orphan-pipe'], env: {}, target: 'web', source: '/media/Film.mkv', outDir: out, cwd: dir, closeGraceMs });

  const result = await run.result;
  const elapsed = Date.now() - started;

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdioTimedOut, true);
  assert.ok(elapsed >= closeGraceMs, `expected to wait at least closeGraceMs (${closeGraceMs} ms), took ${elapsed} ms`);

  const pid = Number(await fs.readFile(path.join(out, 'grandchild.pid'), 'utf8'));
  try {
    process.kill(pid);
  } catch {
    /* already gone */
  }
  // Windows can briefly keep the job dir locked while the grandchild's
  // inherited handles close; give it a moment before jobDir's own cleanup
  // (registered before this kill) removes the directory.
  await new Promise((resolve) => setTimeout(resolve, 300));
});

test('a missing executable settles spawnError, never rejects', async () => {
  const missing = path.join(os.tmpdir(), 'vt-missing-executable-does-not-exist');
  const run = runConverter({ cmd: [missing], env: {}, target: 'web', source: '/media/Film.mkv', outDir: os.tmpdir(), cwd: os.tmpdir() });

  const result = await run.result;

  assert.ok(result.spawnError, `expected a spawnError, got ${JSON.stringify(result)}`);
});

test('a synchronous spawn throw (a null byte in the command) settles spawnError, never rejects', async () => {
  const run = runConverter({ cmd: ['bad\u0000cmd'], env: {}, target: 'web', source: '/media/Film.mkv', outDir: os.tmpdir(), cwd: os.tmpdir() });

  const result = await run.result;

  assert.ok(result.spawnError, `expected a spawnError, got ${JSON.stringify(result)}`);
});

test('stderrTail drops a leading split UTF-8 continuation byte and the wrapped partial first line', async (t) => {
  const { dir, out } = await jobDir(t);
  // Engineered so the 4 KiB trim boundary falls exactly inside a 2-byte
  // UTF-8 character: the lead byte lands just before the window, its
  // continuation byte becomes the window's very first (stray) byte.
  const filler = Buffer.alloc(100, 0x78); // 'x'
  const splitChar = Buffer.from([0xc3, 0xa9]); // 'é', split by the trim
  const meaningful = Buffer.from('garbage-before-newline\nMARKER');
  const pad = Buffer.alloc(4095 - meaningful.length, 0x7a); // 'z'
  const stderrBytes = Buffer.concat([filler, splitChar, meaningful, pad]);
  // A script *file* (not `-e`): with `-e`, Node keeps parsing its own CLI
  // flags in the remaining argv and chokes on the appended `--to`/`--json`.
  const scriptPath = path.join(dir, 'write-stderr.js');
  await fs.writeFile(scriptPath, `process.stderr.write(Buffer.from(${JSON.stringify(stderrBytes.toString('base64'))}, 'base64'));\n`);

  const run = runConverter({ cmd: [process.execPath, scriptPath], env: {}, target: 'web', source: '/media/Film.mkv', outDir: out, cwd: dir });
  const result = await run.result;

  assert.equal(result.exitCode, 0);
  assert.ok(result.stderrTail.startsWith('MARKER'), `expected the tail to start with MARKER, got: ${JSON.stringify(result.stderrTail.slice(0, 40))}`);
});
