// @ts-check
import { writeFile, copyFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { moovBox } from './mp4-boxes.js';

/**
 * Test double for the converter contract
 * (docs/specs/archive/spec-conversion-core.md, "Converter contract and stub"). Run as
 * `[process.execPath, stubPath, ...options]`: leading `--mode`/`--sample-dir`/
 * `--delay-ms`/`--hold` flags this file validates, followed by the fixed
 * contract arguments `--to <target> --json <SRC> <OUTDIR>` that
 * `src/convert/run-converter.js` appends. Also usable for human QA
 * (`--sample-dir`, `--delay-ms`; see README). Reads `process.env` only in
 * `echo` mode, the sole exception in constitution.md's `process.env` rule -
 * this file stands in for the external converter process and only reports
 * the environment it received.
 *
 * Every JSON-printing mode emits the converter v3.3 shape (`file` record, then
 * `summary` record, `schema` 1); on SIGTERM the stub removes its `.partial`
 * (`hang` mode) and exits 143, like the real converter.
 *
 * `--hold <dir>` (after the output is written: create `<dir>/started`, wait
 * for `<dir>/go`) and `--delay-ms <n>` (sleep before the first stdout line)
 * apply only to the modes that print JSON Lines: `ok`, `not-browser-safe`,
 * `fail`, `unsupported`, `skipped`, `no-record`, `missing-output`, `escape`,
 * `wrong-ext`. `grandchild` and `grandchild-flood` spawn a long-lived
 * grandchild (pid in `<outDir>/grandchild.pid`) in the same process group,
 * then stay alive / flood stdout. `hang` uses `--hold` only to report its pid in `<dir>/pid`;
 * every other mode ignores both flags.
 */

/** @typedef {{ mode: string, sampleDir: string | null, delayMs: number, hold: string | null, target: string, source: string, outDir: string }} StubArgs */
/** @typedef {StubArgs & { ext: string, stem: string, outPath: string }} ModeContext */

const TARGET_EXT = /** @type {Record<string, string>} */ ({ web: 'mp4', flac: 'flac', opus: 'opus' });
const LEADING_FLAGS = new Set(['--mode', '--sample-dir', '--delay-ms', '--hold']);
const USAGE = 'usage: converter-stub [--mode <m>] [--sample-dir <dir>] [--delay-ms <n>] [--hold <dir>] --to <target> --json <src> <outDir>\nunrecognized arguments';

/** Thrown for a malformed invocation; caught once at the top level. */
class UsageError extends Error {}

/**
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {StubArgs}
 */
function parseArgs(argv) {
  const opts = { mode: 'ok', sampleDir: /** @type {string | null} */ (null), delayMs: 0, hold: /** @type {string | null} */ (null) };
  let i = 0;
  while (i < argv.length && LEADING_FLAGS.has(argv[i])) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new UsageError();
    if (flag === '--mode') opts.mode = value;
    else if (flag === '--sample-dir') opts.sampleDir = value;
    else if (flag === '--delay-ms') {
      opts.delayMs = Number(value);
      if (value.trim() === '' || !Number.isFinite(opts.delayMs) || opts.delayMs < 0) throw new UsageError();
    } else opts.hold = value;
    i += 2;
  }
  if (!Object.hasOwn(MODES, opts.mode)) throw new UsageError();
  const [to, target, json, source, outDir, extra] = argv.slice(i);
  if (to !== '--to' || json !== '--json' || !target || !source || !outDir || extra !== undefined) throw new UsageError();
  if (!Object.hasOwn(TARGET_EXT, target)) throw new UsageError();
  return { ...opts, target, source: path.resolve(source), outDir: path.resolve(outDir) };
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {string} p resolves once `p` exists, polling every 20 ms */
function waitFor(p) {
  return new Promise((resolve) => {
    const check = () => (existsSync(p) ? resolve(undefined) : setTimeout(check, 20));
    check();
  });
}

/**
 * Runs the `--hold` handshake, then the `--delay-ms` sleep, then prints
 * `records` as JSON Lines.
 * @param {ModeContext} ctx
 * @param {Record<string, unknown>[]} records
 */
async function finish(ctx, records) {
  if (ctx.hold) {
    await writeFile(path.join(ctx.hold, 'started'), '');
    await waitFor(path.join(ctx.hold, 'go'));
  }
  await sleep(ctx.delayMs);
  for (const record of records) process.stdout.write(`${JSON.stringify(record)}\n`);
}

/**
 * @param {ModeContext} ctx
 * @param {string} output
 * @returns {Record<string, unknown>}
 */
function converted(ctx, output) {
  return fileRecord(ctx, 'converted', { output });
}

/**
 * One `file` record in the converter v3.3 shape (`schema` 1), mirroring
 * converter/report.py `file_record`: `source` is the absolute argv source,
 * `output` is always present (absolute), and `attempt` and `sidecars` are
 * `null` unless the outcome is `converted`.
 * @param {ModeContext} ctx
 * @param {string} outcome
 * @param {Record<string, unknown>} [extra] fields overriding the defaults
 * @returns {Record<string, unknown>}
 */
function fileRecord(ctx, outcome, extra = {}) {
  const isConverted = outcome === 'converted';
  return {
    type: 'file', schema: 1, source: ctx.source, output: ctx.outPath, outcome,
    attempt: isConverted ? 1 : null, notes: [], error: null, sidecars: isConverted ? [] : null, ...extra,
  };
}

/**
 * The closing `summary` record of a completed run, v3.3 shape.
 * @param {Partial<Record<'converted' | 'skipped' | 'failed' | 'unsupported' | 'total' | 'exit_code', number>>} [counts]
 * @returns {Record<string, unknown>}
 */
function summary(counts = {}) {
  return { type: 'summary', schema: 1, converted: 0, skipped: 0, failed: 0, unsupported: 0, total: 1, planned: 0, exit_code: 0, dry_run: false, ...counts };
}

/**
 * Synthetic output bytes for a target when no `--sample-dir` sample is used.
 * `flac`/`opus` need only the magic bytes `verifyOutput` checks; `web` builds
 * a minimal MP4 `moov` via the shared box builder.
 * @param {string} target
 * @param {string} [videoFourcc] sample-entry fourcc for the video track
 * @returns {Buffer}
 */
function syntheticBytes(target, videoFourcc = 'avc1') {
  if (target === 'flac') return Buffer.concat([Buffer.from('fLaC', 'ascii'), Buffer.alloc(64)]);
  if (target === 'opus') {
    const header = Buffer.alloc(27);
    header.write('OggS', 0, 'ascii');
    header[26] = 1; // page_segments = 1
    return Buffer.concat([header, Buffer.from([8]), Buffer.from('OpusHead', 'ascii')]);
  }
  const tracks = [{ handlerType: 'vide', fourcc: videoFourcc }];
  if (videoFourcc === 'avc1') tracks.push({ handlerType: 'soun', fourcc: 'mp4a' });
  return moovBox(tracks);
}

/**
 * Writes `bytes` to `outPath`, then prints a `converted` record naming it
 * (which may not be `ctx.outPath`, e.g. the `escape`/`wrong-ext` modes).
 * @param {ModeContext} ctx
 * @param {string} outPath
 * @param {Buffer} bytes
 */
async function reportConverted(ctx, outPath, bytes) {
  await writeFile(outPath, bytes);
  await finish(ctx, [converted(ctx, outPath), summary({ converted: 1 })]);
}

/** @param {ModeContext} ctx the default mode: sample copy or synthetic bytes, record + summary */
async function modeOk(ctx) {
  if (ctx.sampleDir) await copyFile(path.join(ctx.sampleDir, `sample.${ctx.ext}`), ctx.outPath);
  else await writeFile(ctx.outPath, syntheticBytes(ctx.target));
  await finish(ctx, [converted(ctx, ctx.outPath), summary({ converted: 1 })]);
}

/** @param {ModeContext} ctx `.partial` file, pid to `<hold>/pid`, then stays alive until killed */
async function modeHang(ctx) {
  partialPath = `${ctx.outPath}.partial`;
  await writeFile(partialPath, syntheticBytes(ctx.target).subarray(0, 4));
  if (ctx.hold) await writeFile(path.join(ctx.hold, 'pid'), String(process.pid));
  setInterval(() => {}, 60_000);
}

/** Writes more than 1 MiB of small JSON Lines to stdout (the `flood` mode). */
function modeFlood() {
  const line = `${JSON.stringify({ type: 'file', schema: 1, outcome: 'skipped' })}\n`;
  let written = 0;
  while (written < 1024 * 1024 + 4096) {
    process.stdout.write(line);
    written += line.length;
  }
}

/**
 * Spawns a grandchild that inherits this process's stdio and outlives it by
 * sleeping 30 s (the `orphan-pipe` mode), so the pipe stays open after this
 * process exits. `detached` keeps win32 from killing it together with this
 * process; the bounded sleep ends it even if a test never kills it.
 * @param {ModeContext} ctx
 */
async function modeOrphanPipe(ctx) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit', detached: true });
  child.unref();
  await writeFile(path.join(ctx.outDir, 'grandchild.pid'), String(child.pid));
}

/**
 * Spawns a long-lived grandchild in this process's own process group (not
 * detached, stdio ignored) and writes its pid to `<outDir>/grandchild.pid`:
 * the stand-in for the converter's ffmpeg, to prove a group kill reaches it.
 * @param {ModeContext} ctx
 */
async function spawnGrandchild(ctx) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e3)'], { stdio: 'ignore' });
  await writeFile(path.join(ctx.outDir, 'grandchild.pid'), String(child.pid));
}

/** @param {ModeContext} ctx the `grandchild` mode: grandchild, then stays alive until killed */
async function modeGrandchild(ctx) {
  await spawnGrandchild(ctx);
  setInterval(() => {}, 60_000);
}

/** @param {ModeContext} ctx the `grandchild-flood` mode: grandchild, then trips the runner's output cap */
async function modeGrandchildFlood(ctx) {
  await spawnGrandchild(ctx);
  modeFlood();
  setInterval(() => {}, 60_000);
}

/** Path of the in-flight `.partial` file (`hang` mode), removed on SIGTERM. */
let partialPath = '';

/**
 * POSIX: like the real converter, a SIGTERM removes the in-flight
 * `.partial` and exits 143. Windows has no catchable SIGTERM.
 */
function exitOnSigterm() {
  process.on('SIGTERM', () => {
    if (partialPath) rmSync(partialPath, { force: true });
    process.exit(143);
  });
}

/** @type {Record<string, (ctx: ModeContext) => void | Promise<void>>} */
const MODES = {
  ok: modeOk,
  echo: (ctx) => writeFile(path.join(ctx.outDir, 'echo.json'), JSON.stringify({ argv: process.argv, env: process.env, cwd: process.cwd() })),
  'not-browser-safe': (ctx) => reportConverted(ctx, ctx.outPath, syntheticBytes(ctx.target, 'hvc1')),
  fail: (ctx) => {
    process.exitCode = 1;
    return finish(ctx, [fileRecord(ctx, 'failed', { error: 'ffmpeg exited with 1' }), summary({ failed: 1, exit_code: 1 })]);
  },
  unsupported: (ctx) => finish(ctx, [fileRecord(ctx, 'unsupported'), summary({ unsupported: 1 })]),
  skipped: (ctx) => finish(ctx, [fileRecord(ctx, 'skipped'), summary({ skipped: 1 })]),
  garbage: () => {
    process.stdout.write('not a json line\n');
  },
  'no-record': async (ctx) => {
    await writeFile(ctx.outPath, syntheticBytes(ctx.target));
    await finish(ctx, [summary({ total: 0 })]);
  },
  'missing-output': (ctx) => finish(ctx, [converted(ctx, ctx.outPath), summary({ converted: 1 })]),
  escape: (ctx) => reportConverted(ctx, path.join(ctx.outDir, '..', `x.${ctx.ext}`), syntheticBytes(ctx.target)),
  'wrong-ext': (ctx) => reportConverted(ctx, path.join(ctx.outDir, `${ctx.stem}.mkv`), syntheticBytes(ctx.target)),
  crash: async (ctx) => {
    await writeFile(ctx.outPath, syntheticBytes(ctx.target).subarray(0, 4));
    process.exitCode = 3;
  },
  interrupted: () => {
    process.exitCode = 130;
  },
  usage: () => {
    process.stderr.write('unrecognized arguments\n');
    process.exitCode = 2;
  },
  hang: modeHang,
  flood: modeFlood,
  'orphan-pipe': modeOrphanPipe,
  grandchild: modeGrandchild,
  'grandchild-flood': modeGrandchildFlood,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  exitOnSigterm();
  const ext = TARGET_EXT[args.target];
  const stem = path.parse(args.source).name;
  await MODES[args.mode]({ ...args, ext, stem, outPath: path.join(args.outDir, `${stem}.${ext}`) });
}

main().catch((err) => {
  if (err instanceof UsageError) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  throw err;
});
