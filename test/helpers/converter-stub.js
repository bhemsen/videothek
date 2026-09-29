// @ts-check
import { writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { moovBox } from './mp4-boxes.js';

/**
 * Test double for the converter contract
 * (docs/specs/spec-conversion-core.md, "Converter contract and stub"). Run as
 * `[process.execPath, stubPath, ...options]`: leading `--mode`/`--sample-dir`/
 * `--delay-ms`/`--hold` flags this file validates, followed by the fixed
 * contract arguments `--to <target> --json <SRC> <OUTDIR>` that
 * `src/convert/run-converter.js` appends. Also usable for human QA
 * (`--sample-dir`, `--delay-ms`; see README). Reads `process.env` only in
 * `echo` mode, the sole exception in constitution.md's `process.env` rule -
 * this file stands in for the external converter process and only reports
 * the environment it received.
 */

/** @typedef {{ mode: string, sampleDir: string | null, delayMs: number, hold: string | null, target: string, source: string, outDir: string }} StubArgs */

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
      if (!Number.isFinite(opts.delayMs) || opts.delayMs < 0) throw new UsageError();
    } else opts.hold = value;
    i += 2;
  }
  const [to, target, json, source, outDir, extra] = argv.slice(i);
  if (to !== '--to' || json !== '--json' || !target || !source || !outDir || extra !== undefined) throw new UsageError();
  if (!Object.hasOwn(TARGET_EXT, target)) throw new UsageError();
  return { ...opts, target, source, outDir };
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

/** @param {Record<string, unknown>} record */
function printLine(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

/**
 * `--hold <dir>` test handshake for every mode but `hang` (which reports its
 * pid instead, see its own branch): marks output written, then waits for the
 * test to release it.
 * @param {string | null} hold
 */
async function holdIfNeeded(hold) {
  if (!hold) return;
  await writeFile(path.join(hold, 'started'), '');
  await waitFor(path.join(hold, 'go'));
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
 * Writes `bytes` to `outPath`, runs the `--hold` handshake, then prints a
 * `converted` record naming `outPath` (which may not be `outPath` itself,
 * e.g. the `escape`/`wrong-ext` modes).
 * @param {string | null} hold
 * @param {string} outPath
 * @param {Buffer | null} bytes `null` for `missing-output` (nothing written)
 */
async function reportConverted(hold, outPath, bytes) {
  if (bytes) await writeFile(outPath, bytes);
  await holdIfNeeded(hold);
  printLine({ outcome: 'converted', output: outPath, error: null });
}

/** Writes more than 1 MiB of small JSON Lines to stdout (the `flood` mode). */
function flood() {
  const line = `${JSON.stringify({ outcome: 'skipped' })}\n`;
  let written = 0;
  while (written < 1024 * 1024 + 4096) {
    process.stdout.write(line);
    written += line.length;
  }
}

/**
 * Spawns a grandchild that inherits this process's stdio and outlives it (the
 * `orphan-pipe` mode), so the pipe stays open after this process exits.
 * @param {string} outDir
 */
async function spawnOrphan(outDir) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'inherit', detached: true });
  child.unref();
  await writeFile(path.join(outDir, 'grandchild.pid'), String(child.pid));
}

/** @param {StubArgs} args */
async function run(args) {
  const { mode, sampleDir, hold, target, source, outDir } = args;
  const ext = TARGET_EXT[target];
  const stem = path.parse(source).name;
  const outPath = path.join(outDir, `${stem}.${ext}`);

  switch (mode) {
    case 'usage':
      process.stderr.write('unrecognized arguments\n');
      process.exitCode = 2;
      return;
    case 'interrupted':
      process.exitCode = 130;
      return;
    case 'crash':
      await writeFile(outPath, syntheticBytes(target).subarray(0, 4));
      process.exitCode = 3;
      return;
    case 'hang':
      await writeFile(outPath, syntheticBytes(target).subarray(0, 4));
      if (hold) await writeFile(path.join(hold, 'pid'), String(process.pid));
      setInterval(() => {}, 60_000); // keep the process alive until the queue kills it
      return;
    case 'flood':
      flood();
      return;
    case 'garbage':
      process.stdout.write('not a json line\n');
      return;
    case 'orphan-pipe':
      await spawnOrphan(outDir);
      return;
    case 'echo':
      await writeFile(path.join(outDir, 'echo.json'), JSON.stringify({ argv: process.argv, env: process.env, cwd: process.cwd() }));
      return;
    case 'fail':
      await holdIfNeeded(hold);
      printLine({ outcome: 'failed', error: 'ffmpeg exited with 1' });
      process.exitCode = 1;
      return;
    case 'unsupported':
    case 'skipped':
      await holdIfNeeded(hold);
      printLine({ outcome: mode });
      return;
    case 'missing-output':
      await holdIfNeeded(hold);
      printLine({ outcome: 'converted', output: outPath, error: null });
      return;
    case 'escape':
      await reportConverted(hold, path.join(outDir, '..', `x.${ext}`), syntheticBytes(target));
      return;
    case 'wrong-ext':
      await reportConverted(hold, path.join(outDir, `${stem}.mkv`), syntheticBytes(target));
      return;
    case 'not-browser-safe':
      await reportConverted(hold, outPath, syntheticBytes(target, 'hvc1'));
      return;
    case 'no-record':
      await writeFile(outPath, syntheticBytes(target));
      await holdIfNeeded(hold);
      printLine({ done: true });
      return;
    case 'ok': {
      const bytes = sampleDir ? null : syntheticBytes(target);
      if (sampleDir) await copyFile(path.join(sampleDir, `sample.${ext}`), outPath);
      await reportConverted(hold, outPath, bytes);
      printLine({ done: true });
      return;
    }
    default:
      throw new UsageError();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await sleep(args.delayMs);
  await run(args);
}

main().catch((err) => {
  if (err instanceof UsageError) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  throw err;
});
