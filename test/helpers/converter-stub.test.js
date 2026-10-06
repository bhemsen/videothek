// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sniffMp4Codecs } from '../../src/library/tags/mp4-codec.js';

const stubPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'converter-stub.js');

/** @typedef {{ code: number | null, stdout: string, stderr: string }} StubResult */

/**
 * Makes a fresh job dir with an `out/` subdir, removed after the test.
 * @param {import('node:test').TestContext} t
 * @returns {{ dir: string, out: string }}
 */
function jobDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-stub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  return { dir, out };
}

/**
 * @param {string} out
 * @param {string} [target]
 * @returns {string[]} the fixed contract arguments
 */
function contract(out, target = 'web') {
  return ['--to', target, '--json', '/media/Film.mkv', out];
}

/**
 * Spawns the stub and resolves on `'close'` with its exit code and output.
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, onSpawn?: (child: import('node:child_process').ChildProcess) => void }} [opts]
 * @returns {Promise<StubResult>}
 */
function runStub(args, opts = {}) {
  const child = spawn(process.execPath, [stubPath, ...args], { env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  opts.onSpawn?.(child);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * A `file` record in the converter v3.3 shape.
 * @param {string} outcome
 * @param {Record<string, unknown>} [extra]
 */
function fileRec(outcome, extra = {}) {
  return { type: 'file', schema: 1, source: '/media/Film.mkv', outcome, attempt: 1, notes: [], error: null, sidecars: [], ...extra };
}

/**
 * A `summary` record in the converter v3.3 shape.
 * @param {Record<string, unknown>} [extra]
 */
function summaryRec(extra = {}) {
  return { type: 'summary', schema: 1, converted: 0, skipped: 0, failed: 0, unsupported: 0, total: 1, planned: 0, exit_code: 0, dry_run: false, ...extra };
}

/** @param {string} stdout @returns {unknown[]} */
function lines(stdout) {
  return stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** @param {string} p @returns {Promise<void>} */
async function waitForFile(p) {
  while (!fs.existsSync(p)) await new Promise((r) => setTimeout(r, 20));
}

test('malformed invocations exit 2 with the usage text on stderr', async (t) => {
  const { out } = jobDir(t);
  const cases = [
    ['--bogus', 'x', ...contract(out)],
    ['--mode', 'nope', ...contract(out)],
    ['--delay-ms', '-1', ...contract(out)],
    ['--delay-ms', '', ...contract(out)],
    ['--mode'],
    [...contract(out, 'mkv')],
    ['--to', 'web', '--json', '/media/Film.mkv'],
    [...contract(out), 'extra'],
  ];
  for (const args of cases) {
    const res = await runStub(args);
    assert.equal(res.code, 2, args.join(' '));
    assert.match(res.stderr, /^usage: converter-stub/);
    assert.match(res.stderr, /unrecognized arguments/);
    assert.equal(res.stdout, '');
  }
  const usage = await runStub(['--mode', 'usage', ...contract(out)]);
  assert.deepEqual([usage.code, usage.stderr], [2, 'unrecognized arguments\n']);
});

test('ok writes synthetic output per target and prints the record plus a summary', async (t) => {
  const { out } = jobDir(t);
  const magic = { flac: 'fLaC', opus: 'OggS' };
  for (const target of ['web', 'flac', 'opus']) {
    const res = await runStub(contract(out, target));
    const ext = target === 'web' ? 'mp4' : target;
    const file = path.join(out, `Film.${ext}`);
    assert.equal(res.code, 0);
    assert.deepEqual(lines(res.stdout), [fileRec('converted', { output: file }), summaryRec({ converted: 1 })]);
    const bytes = fs.readFileSync(file);
    if (target === 'web') assert.deepEqual(await sniffMp4Codecs(file), { video: ['avc1'], audio: ['mp4a'] });
    else assert.equal(bytes.subarray(0, 4).toString('latin1'), magic[/** @type {'flac' | 'opus'} */ (target)]);
    if (target === 'opus') assert.ok(bytes.includes(Buffer.from('OpusHead')));
  }
});

test('ok with --sample-dir copies sample.<ext>; a relative OUTDIR is reported absolute', async (t) => {
  const { dir, out } = jobDir(t);
  fs.writeFileSync(path.join(dir, 'sample.flac'), 'SAMPLE');
  const rel = path.relative(process.cwd(), out);
  const res = await runStub(['--sample-dir', dir, ...contract(rel, 'flac')]);
  assert.equal(res.code, 0);
  assert.equal(fs.readFileSync(path.join(out, 'Film.flac'), 'utf8'), 'SAMPLE');
  assert.deepEqual(lines(res.stdout)[0], fileRec('converted', { output: path.join(out, 'Film.flac') }));
});

test('echo reports the argv, environment and cwd it received', async (t) => {
  const { out } = jobDir(t);
  const res = await runStub(['--mode', 'echo', ...contract(out)], { env: { VT_STUB_PROBE: 'probe' } });
  assert.deepEqual([res.code, res.stdout], [0, '']);
  const echo = JSON.parse(fs.readFileSync(path.join(out, 'echo.json'), 'utf8'));
  assert.deepEqual(echo.argv.slice(2), ['--mode', 'echo', ...contract(out)]);
  assert.equal(echo.env.VT_STUB_PROBE, 'probe');
  assert.equal(echo.cwd, process.cwd());
});

test('record, error and exit-code modes behave as the spec table says', async (t) => {
  const { dir, out } = jobDir(t);
  const mp4 = path.join(out, 'Film.mp4');
  /** @type {[string, number, unknown[]][]} */
  const table = [
    ['fail', 1, [fileRec('failed', { error: 'ffmpeg exited with 1' }), summaryRec({ failed: 1, exit_code: 1 })]],
    ['unsupported', 0, [fileRec('unsupported'), summaryRec({ unsupported: 1 })]],
    ['skipped', 0, [fileRec('skipped'), summaryRec({ skipped: 1 })]],
    ['missing-output', 0, [fileRec('converted', { output: mp4 }), summaryRec({ converted: 1 })]],
    ['escape', 0, [fileRec('converted', { output: path.join(dir, 'x.mp4') }), summaryRec({ converted: 1 })]],
    ['wrong-ext', 0, [fileRec('converted', { output: path.join(out, 'Film.mkv') }), summaryRec({ converted: 1 })]],
    ['no-record', 0, [summaryRec({ total: 0 })]],
    ['interrupted', 130, []],
  ];
  for (const [mode, code, records] of table) {
    const res = await runStub(['--mode', mode, ...contract(out)]);
    assert.equal(res.code, code, mode);
    assert.deepEqual(lines(res.stdout), records, mode);
    if (mode === 'missing-output') assert.equal(fs.existsSync(mp4), false);
    if (mode === 'escape') assert.ok(fs.existsSync(path.join(dir, 'x.mp4')));
    if (mode === 'wrong-ext') assert.ok(fs.existsSync(path.join(out, 'Film.mkv')));
    if (mode === 'no-record') assert.deepEqual(await sniffMp4Codecs(mp4), { video: ['avc1'], audio: ['mp4a'] });
  }
  const garbage = await runStub(['--mode', 'garbage', ...contract(out)]);
  assert.deepEqual([garbage.code, garbage.stdout], [0, 'not a json line\n']);
});

test('crash leaves a truncated file; not-browser-safe writes an hvc1 track', async (t) => {
  const { out } = jobDir(t);
  const crash = await runStub(['--mode', 'crash', ...contract(out)]);
  assert.deepEqual([crash.code, crash.stdout], [3, '']);
  assert.equal(fs.statSync(path.join(out, 'Film.mp4')).size, 4);
  const nbs = await runStub(['--mode', 'not-browser-safe', ...contract(out)]);
  assert.equal(nbs.code, 0);
  assert.deepEqual(lines(nbs.stdout), [fileRec('converted', { output: path.join(out, 'Film.mp4') }), summaryRec({ converted: 1 })]);
  assert.deepEqual(await sniffMp4Codecs(path.join(out, 'Film.mp4')), { video: ['hvc1'], audio: [] });
});

test('--hold waits for go after writing output; --delay-ms delays the record', async (t) => {
  const { dir, out } = jobDir(t);
  const hold = path.join(dir, 'hold');
  fs.mkdirSync(hold);
  let stdoutBeforeGo = '';
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  const done = runStub(['--hold', hold, '--delay-ms', '300', ...contract(out)], { onSpawn: (c) => { child = c; } });
  child?.stdout?.on('data', (d) => { stdoutBeforeGo += d; });
  await waitForFile(path.join(hold, 'started'));
  assert.ok(fs.existsSync(path.join(out, 'Film.mp4')), 'output is written before started');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(stdoutBeforeGo, '', 'no record while held');
  const released = Date.now();
  fs.writeFileSync(path.join(hold, 'go'), '');
  const res = await done;
  assert.ok(Date.now() - released >= 300, 'record printed only after the delay');
  assert.equal(lines(res.stdout).length, 2);
});

test('hang writes a .partial file and its pid, then runs until killed', async (t) => {
  const { dir, out } = jobDir(t);
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  const done = runStub(['--mode', 'hang', '--hold', dir, ...contract(out)], { onSpawn: (c) => { child = c; } });
  await waitForFile(path.join(dir, 'pid'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.readFileSync(path.join(dir, 'pid'), 'utf8'), String(child?.pid));
  assert.equal(fs.statSync(path.join(out, 'Film.mp4.partial')).size, 4);
  assert.equal(child?.exitCode, null, 'still running');
  child?.kill();
  const res = await done;
  assert.notEqual(res.code, 0);
});

test('hang: SIGTERM removes the .partial file and exits 143', { skip: process.platform === 'win32' }, async (t) => {
  const { dir, out } = jobDir(t);
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  const done = runStub(['--mode', 'hang', '--hold', dir, ...contract(out)], { onSpawn: (c) => { child = c; } });
  await waitForFile(path.join(dir, 'pid'));
  assert.ok(fs.existsSync(path.join(out, 'Film.mp4.partial')));
  child?.kill('SIGTERM');
  const res = await done;
  assert.equal(res.code, 143);
  assert.equal(fs.existsSync(path.join(out, 'Film.mp4.partial')), false);
});

test('flood writes more than 1 MiB to stdout', async (t) => {
  const { out } = jobDir(t);
  const res = await runStub(['--mode', 'flood', ...contract(out)]);
  assert.equal(res.code, 0);
  assert.ok(Buffer.byteLength(res.stdout) > 1024 * 1024);
});

test('orphan-pipe exits 0 while a grandchild keeps its stdout open', async (t) => {
  const { out } = jobDir(t);
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  let closed = false;
  const done = runStub(['--mode', 'orphan-pipe', ...contract(out)], { onSpawn: (c) => { child = c; } }).then((r) => { closed = true; return r; });
  const exitCode = await new Promise((r) => child?.on('exit', r));
  assert.equal(exitCode, 0);
  const pid = Number(fs.readFileSync(path.join(out, 'grandchild.pid'), 'utf8'));
  t.after(() => {
    try { process.kill(pid); } catch { /* already gone */ }
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(closed, false, 'pipe still held by the grandchild');
  process.kill(pid, 0);
  process.kill(pid);
  const res = await done;
  assert.equal(res.stdout, '');
});
