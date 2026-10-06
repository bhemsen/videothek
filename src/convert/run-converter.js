import { spawn } from 'node:child_process';
import os from 'node:os';
import { createJsonLinesReader } from './jsonl.js';
import { errorCode } from './error-code.js';
import { createStderrRing } from './stderr-ring.js';

// The only src/ module allowed to import node:child_process
// (test/constitution.test.js, "src/ and public/ never use child_process,
// eval() or new Function() (except the converter runner)"). It builds the
// argv itself, never passes a shell option, and always settles `result` -
// a spawn failure, a bad output or a stuck child are all reported as
// fields, never a rejection or a thrown error (spec-conversion-core.md,
// "Runner").

const STDERR_TAIL_BYTES = 4096;
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
 *   {@link createStderrRing} in `stderr-ring.js`).
 * @property {string | null} priorityError - the errno code when lowering the
 *   child's priority (`setPriority(pid, 19)`) failed, `null` otherwise
 *   (best effort; the run continues either way).
 * @property {string | null} signalError - the code of the first signal
 *   delivery failure other than ESRCH (e.g. `'EPERM'`), `null` otherwise.
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
 * One run's handle. Accepted gap: a converter that exits 0 while a
 * grandchild still holds its stdout open is not swept (a clean exit is not a
 * kill signal); the run then settles after `closeGraceMs` with
 * `stdioTimedOut`.
 * @typedef {object} RunConverter
 * @property {Promise<RunResult>} result
 * @property {(signal: NodeJS.Signals) => void} kill
 */

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
 * The errno of a failed `os.setPriority`: a real failure is a SystemError whose
 * `code` is `ERR_SYSTEM_ERROR` and whose errno (e.g. `EACCES`) is `info.code`.
 * @param {unknown} err
 * @returns {string}
 */
function systemErrorCode(err) {
  const infoCode = /** @type {{ info?: { code?: unknown } }} */ (err)?.info?.code;
  return typeof infoCode === 'string' ? infoCode : errorCode(err, 'ERR_PRIORITY');
}

/**
 * Best-effort `setPriority(pid, 19)`; never throws.
 * @param {number | undefined} pid
 * @param {(pid: number, priority: number) => void} setPriority
 * @returns {string | null} the errno code on failure, else `null`
 */
function lowerPriority(pid, setPriority) {
  if (pid === undefined) return null;
  try {
    setPriority(pid, CONVERTER_PRIORITY);
    return null;
  } catch (err) {
    return systemErrorCode(err);
  }
}

/**
 * Signals the run: POSIX goes to the whole process group (`-pid`), so the
 * converter's own ffmpeg children are reached; Windows uses `child.kill`.
 * Nothing without a pid. ESRCH (group already gone) is ignored; any other
 * error is reported through `onError` - this never throws.
 * @param {{ child: import('node:child_process').ChildProcess, pid: number | undefined, posix: boolean, killProcess: (pid: number, signal: NodeJS.Signals) => unknown, onError: (code: string) => void }} ctx
 * @returns {(signal: NodeJS.Signals) => void}
 */
function createSignaller({ child, pid, posix, killProcess, onError }) {
  return (signal) => {
    if (pid === undefined) return;
    try {
      if (posix) killProcess(-pid, signal);
      else child.kill(signal);
    } catch (err) {
      const code = errorCode(err, 'ERR_KILL');
      if (code !== 'ESRCH') onError(code);
    }
  };
}

/**
 * The promise + one-shot `settle` for a run; `state` is read at settle time.
 * @param {{ killedBy: 'cap' | 'stop' | null, priorityError: string | null, signalError: string | null }} state
 * @param {ReturnType<typeof createJsonLinesReader>} reader
 * @param {ReturnType<typeof createStderrRing>} stderrRing
 * @returns {{ result: Promise<RunResult>, settle: (extra: Partial<RunResult>) => void }}
 */
function createSettler(state, reader, stderrRing) {
  let settled = false;
  /** @type {(value: RunResult) => void} */
  let resolveResult = () => {};
  const result = /** @type {Promise<RunResult>} */ (new Promise((resolve) => { resolveResult = resolve; }));
  return {
    result,
    settle(extra) {
      if (settled) return;
      settled = true;
      reader.end();
      resolveResult({
        spawnError: null,
        exitCode: null,
        signal: null,
        killedBy: state.killedBy,
        records: reader.records,
        stdoutInvalid: state.killedBy === 'cap' || reader.invalid,
        stdioTimedOut: false,
        stderrTail: stderrRing.finish(),
        priorityError: state.priorityError,
        signalError: state.signalError,
        ...extra,
      });
    },
  };
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
  const state = { killedBy: /** @type {'cap' | 'stop' | null} */ (null), priorityError: /** @type {string | null} */ (null), signalError: /** @type {string | null} */ (null) };
  const { result, settle } = createSettler(state, reader, stderrRing);

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

  state.priorityError = lowerPriority(child.pid, setPriority);
  const send = createSignaller({ child, pid: child.pid, posix, killProcess, onError: (code) => { state.signalError = state.signalError ?? code; } });
  let exited = false;
  wireChild(child, {
    reader,
    stderrRing,
    closeGraceMs,
    settle,
    onCap: () => {
      state.killedBy = state.killedBy ?? 'cap';
      send('SIGKILL');
    },
    // One synchronous group sweep: after a queue/cap kill, or a non-zero or
    // signalled exit (an OOM-killed converter must not leave ffmpeg behind).
    onExit(code, signal) {
      exited = true;
      if (posix && (state.killedBy !== null || code !== 0 || signal !== null)) send('SIGKILL');
    },
  });

  return {
    result,
    kill(signal) {
      if (exited) return;
      state.killedBy = state.killedBy ?? 'stop';
      send(signal);
    },
  };
}
