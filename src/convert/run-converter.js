import { spawn } from 'node:child_process';
import { createJsonLinesReader } from './jsonl.js';

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
 */

/**
 * @typedef {object} RunConverter
 * @property {Promise<RunResult>} result
 * @property {(signal: NodeJS.Signals) => void} kill
 */

/**
 * Extracts a safe-to-log identifier for a spawn failure: the errno code
 * (`'ENOENT'`, …) when there is one, never the raw message, which can embed
 * the converter's install path.
 * @param {unknown} err
 * @returns {string}
 */
function errorCode(err) {
  const code = /** @type {{ code?: unknown }} */ (err)?.code;
  if (typeof code === 'string') return code;
  const name = /** @type {{ name?: unknown }} */ (err)?.name;
  return typeof name === 'string' ? name : 'ERR_SPAWN';
}

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
 * @param {{ reader: ReturnType<typeof createJsonLinesReader>, stderrRing: ReturnType<typeof createStderrRing>, closeGraceMs: number, settle: (extra: Partial<RunResult>) => void, onCap: () => void }} ctx
 */
function wireChild(child, { reader, stderrRing, closeGraceMs, settle, onCap }) {
  let spawnSucceeded = false;
  let capped = false;
  child.once('spawn', () => {
    spawnSucceeded = true;
  });
  child.on('error', (err) => {
    if (spawnSucceeded) return;
    settle({ spawnError: errorCode(err) });
  });
  child.stdout?.on('data', (chunk) => {
    if (capped) return;
    if (reader.push(chunk) === 'cap') {
      capped = true;
      onCap();
      child.kill('SIGKILL');
      child.stdout?.destroy();
    }
  });
  child.stderr?.on('data', (chunk) => stderrRing.push(chunk));
  child.once('exit', (code, signal) => {
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
export function runConverter({ cmd, env, target, source, outDir, cwd, closeGraceMs = 2000 }) {
  const reader = createJsonLinesReader();
  const stderrRing = createStderrRing(STDERR_TAIL_BYTES);
  let settled = false;
  /** @type {'cap' | 'stop' | null} */
  let killedBy = null;

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
      ...extra,
    });
  }

  let child;
  try {
    child = spawn(cmd[0], [...cmd.slice(1), '--to', target, '--json', source, outDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env,
      cwd,
    });
  } catch (err) {
    settle({ spawnError: errorCode(err) });
    return { result, kill: () => {} };
  }

  wireChild(child, {
    reader,
    stderrRing,
    closeGraceMs,
    settle,
    onCap: () => {
      killedBy = killedBy ?? 'cap';
    },
  });

  return {
    result,
    kill(signal) {
      killedBy = killedBy ?? 'stop';
      child.kill(signal);
    },
  };
}
