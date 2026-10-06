import { spawn } from 'node:child_process';
import os from 'node:os';
import { createJsonLinesReader } from './jsonl.js';
import { errorCode } from './error-code.js';

// The only src/ module allowed to import node:child_process
// (test/constitution.test.js, "src/ and public/ never use child_process,
// eval() or new Function() (except the converter runner)"). It builds the
// argv itself, never passes a shell option, and always settles `result` -
// a spawn failure, a bad output or a stuck child are all reported as
// fields, never a rejection or a thrown error (spec-conversion-core.md,
// "Runner").

const STDERR_TAIL_BYTES = 4096;
const CONTINUATION_BYTE_MIN = 0x80;
const CONTINUATION_BYTE_MAX = 0xbf;
const CONVERTER_PRIORITY = 19;

/**
 * @typedef {import('./jsonl.js').ConverterRecord} ConverterRecord
 */

/**
 * The outcome of one converter invocation. Never thrown or rejected: every
 * failure mode is a field so `interpretRun` (src/convert/result.js) can
 * classify it without a try/catch.
 * @typedef {object} RunResult
 * @property {string | null} spawnError - the error code (e.g. `'ENOENT'`)
 *   when the child could not be spawned at all, `null` otherwise. Never the
 *   raw error message, which can carry the converter's install path.
 * @property {number | null} exitCode - the child's exit code, `null` if it
 *   never started or was terminated by a signal.
 * @property {NodeJS.Signals | null} signal - the signal that ended the
 *   child, `null` on a normal exit.
 * @property {'cap' | 'stop' | null} killedBy - `'cap'` after the runner's
 *   own output-cap kill, `'stop'` after an explicit `kill()` call, else
 *   `null`.
 * @property {ConverterRecord[]} records - every valid per-file record read
 *   from stdout, in order.
 * @property {boolean} stdoutInvalid - `true` once stdout held a bad line, a
 *   record that failed validation, or the output cap tripped.
 * @property {boolean} stdioTimedOut - `true` when `'close'` had not fired
 *   `closeGraceMs` after `'exit'`, so `records` may be incomplete.
 * @property {string} stderrTail - the last 4 KiB of stderr, decoded (see
 *   {@link createStderrRing}).
 * @property {string | null} priorityError - the error code when lowering the
 *   child's priority (`setPriority(pid, 19)`) failed, `null` otherwise
 *   (best effort; the run continues either way).
 */

/**
 * @typedef {object} RunConverterOptions
 * @property {readonly string[]} cmd - `CONVERTER_CMD` tokens; `cmd[0]` is
 *   the executable, the rest are its own fixed leading arguments.
 * @property {Readonly<Record<string, string>>} env - the child's entire
 *   environment (already allow-listed by `pickConverterEnv`).
 * @property {'web' | 'flac' | 'opus'} target
 * @property {string} source - absolute path to the input file.
 * @property {string} outDir - an existing, empty, absolute directory.
 * @property {string} cwd - the per-job directory (`outDir`'s parent).
 * @property {number} [closeGraceMs] - bound on the wait for `'close'` after
 *   `'exit'`. Default `2000`.
 * @property {NodeJS.Platform} [platform] - injectable seam, default
 *   `process.platform`. POSIX spawns a process group and signals it.
 * @property {(pid: number, signal: NodeJS.Signals) => unknown} [killProcess] -
 *   injectable seam, default `process.kill`; receives `-pid` on POSIX.
 * @property {(pid: number, priority: number) => void} [setPriority] -
 *   injectable seam, default `os.setPriority`.
 */

/**
 * @typedef {object} RunConverter
 * @property {Promise<RunResult>} result
 * @property {(signal: NodeJS.Signals) => void} kill
 */

/**
 * A fixed-size trailing window over the bytes seen so far, for
 * `stderrTail`: memory stays bounded to `maxBytes` however much the
 * converter prints (spec-conversion-core.md, "Runner"). Once the window has
 * wrapped, leading continuation bytes are dropped, then the decoded text's
 * partial first line - which may hold a cut root spelling `redactDetail`
 * would otherwise miss - is dropped too.
 * @param {number} maxBytes
 */
function createStderrRing(maxBytes) {
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  let wrapped = false;

  /** @param {Buffer} chunk */
  function push(chunk) {
    chunks.push(chunk);
    total += chunk.length;
    while (total > maxBytes) {
      const first = chunks[0];
      const excess = total - maxBytes;
      if (first.length <= excess) {
        chunks.shift();
        total -= first.length;
      } else {
        chunks[0] = first.subarray(excess);
        total -= excess;
      }
      wrapped = true;
    }
  }

  /** @returns {string} the decoded, trimmed tail */
  function finish() {
    const bytes = Buffer.concat(chunks, total);
    let start = 0;
    while (start < bytes.length && bytes[start] >= CONTINUATION_BYTE_MIN && bytes[start] <= CONTINUATION_BYTE_MAX) start++;
    let text = bytes.subarray(start).toString('utf8');
    if (wrapped) {
      const newlineAt = text.indexOf('\n');
      text = newlineAt === -1 ? '' : text.slice(newlineAt + 1);
    }
    return text;
  }

  return { push, finish };
}

/**
 * Wires the child's stdio and lifecycle events to the shared `settle`/state
 * closure, so {@link runConverter} itself stays a straight-line setup.
 * @param {import('node:child_process').ChildProcess} child
 * @param {{ reader: ReturnType<typeof createJsonLinesReader>, stderrRing: ReturnType<typeof createStderrRing>, closeGraceMs: number, settle: (extra: Partial<RunResult>) => void, onCap: () => void, onExit: (code: number | null, signal: NodeJS.Signals | null) => void }} ctx
 */
function wireChild(child, { reader, stderrRing, closeGraceMs, settle, onCap, onExit }) {
  let spawnSucceeded = false;
  let capped = false;
  child.once('spawn', () => {
    spawnSucceeded = true;
  });
  child.on('error', (err) => {
    if (spawnSucceeded) return;
    settle({ spawnError: errorCode(err, 'ERR_SPAWN') });
  });
  child.stdout?.on('data', (chunk) => {
    if (capped) return;
    if (reader.push(chunk) === 'cap') {
      capped = true;
      onCap();
      child.stdout?.destroy();
    }
  });
  child.stderr?.on('data', (chunk) => stderrRing.push(chunk));
  child.once('exit', (code, signal) => {
    onExit(code, signal);
    const graceTimer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle({ exitCode: code, signal, stdioTimedOut: true });
    }, closeGraceMs);
    child.once('close', () => {
      clearTimeout(graceTimer);
      settle({ exitCode: code, signal });
    });
  });
}

/**
 * Runs the external converter once
 * (`<cmd tokens…> --to <target> --json <source> <outDir>`), the only `src/`
 * use of `node:child_process` (spec-conversion-core.md, "Runner").
 * @param {RunConverterOptions} options
 * @returns {RunConverter}
 */
export function runConverter({ cmd, env, target, source, outDir, cwd, closeGraceMs = 2000, platform = process.platform, killProcess = process.kill, setPriority = os.setPriority }) {
  const posix = platform !== 'win32';
  const reader = createJsonLinesReader();
  const stderrRing = createStderrRing(STDERR_TAIL_BYTES);
  let settled = false;
  /** @type {'cap' | 'stop' | null} */
  let killedBy = null;
  let exited = false;
  /** @type {string | null} */
  let priorityError = null;

  /** @type {(value: RunResult) => void} */
  let resolveResult = () => {};
  const result = /** @type {Promise<RunResult>} */ (new Promise((resolve) => { resolveResult = resolve; }));

  /** @param {Partial<RunResult>} extra */
  function settle(extra) {
    if (settled) return;
    settled = true;
    reader.end();
    resolveResult({
      spawnError: null,
      exitCode: null,
      signal: null,
      killedBy,
      records: reader.records,
      stdoutInvalid: killedBy === 'cap' || reader.invalid,
      stdioTimedOut: false,
      stderrTail: stderrRing.finish(),
      priorityError,
      ...extra,
    });
  }

  /** @type {import('node:child_process').ChildProcess} */
  let child;
  try {
    child = spawn(cmd[0], [...cmd.slice(1), '--to', target, '--json', source, outDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: posix,
      env,
      cwd,
    });
  } catch (err) {
    settle({ spawnError: errorCode(err, 'ERR_SPAWN') });
    return { result, kill: () => {} };
  }

  const pid = child.pid;
  if (pid !== undefined) {
    try {
      setPriority(pid, CONVERTER_PRIORITY);
    } catch (err) {
      priorityError = errorCode(err, 'ERR_PRIORITY');
    }
  }

  /**
   * Signals the run: POSIX goes to the whole process group (`-pid`), so the
   * converter's own ffmpeg children are reached; Windows uses `child.kill`.
   * Nothing without a pid; ESRCH (group already gone) and any other signal
   * error are swallowed - this never throws.
   * @param {NodeJS.Signals} signal
   */
  function send(signal) {
    if (pid === undefined) return;
    try {
      if (posix) killProcess(-pid, signal);
      else child.kill(signal);
    } catch {
      // ESRCH: the group is already gone.
    }
  }

  wireChild(child, {
    reader,
    stderrRing,
    closeGraceMs,
    settle,
    onCap: () => {
      killedBy = killedBy ?? 'cap';
      send('SIGKILL');
    },
    // One synchronous group sweep: after a queue/cap kill, or a non-zero or
    // signalled exit (an OOM-killed converter must not leave ffmpeg behind).
    onExit(code, signal) {
      exited = true;
      if (posix && (killedBy !== null || code !== 0 || signal !== null)) send('SIGKILL');
    },
  });

  return {
    result,
    kill(signal) {
      if (exited) return;
      killedBy = killedBy ?? 'stop';
      send(signal);
    },
  };
}
