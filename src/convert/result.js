// @ts-check

/**
 * Run interpretation and error-detail redaction for on-demand conversion
 * (`docs/specs/spec-conversion-core.md`, "Converter contract and stub" /
 * "Interpretation"). Pure: no I/O, no DB, no process spawning.
 *
 * `interpretRun` turns a finished `RunResult` (from
 * `src/convert/run-converter.js`) into either a verifiable success or one of
 * the fixed failure codes the queue stores. `redactDetail` strips the
 * configured filesystem roots out of free-form converter text (the
 * interpreted `detail`, and each converter note) before it is persisted,
 * returned by the API or shown in the admin panel.
 */

import path from 'node:path';

/** @typedef {import('./run-converter.js').RunResult} RunResult */
/** @typedef {import('./targets.js').ConversionTarget} ConversionTarget */

/**
 * The fixed set of failure codes `interpretRun` can return (stored as
 * `conversions.error`). `storage_failed`, `source_missing` and `internal`
 * (queue steps) and `not_browser_safe` (`verifyOutput`) are separate codes
 * from other stages of the job and are never returned here.
 * @typedef {'converter_unavailable' | 'converter_interrupted' | 'converter_output_invalid' | 'converter_failed' | 'unsupported_source'} InterpretationErrorCode
 */

/**
 * @typedef {object} InterpretedSuccess
 * @property {true} ok
 * @property {string} output - absolute path the converter reported.
 * @property {string[]} notes
 */

/**
 * @typedef {object} InterpretedFailure
 * @property {false} ok
 * @property {InterpretationErrorCode} error
 * @property {string | null} detail - redaction-worthy free text (an errno
 *   code, a record's own `error`, or the stderr tail), or `null` when the
 *   rule that matched has no useful diagnostic text.
 */

/** @typedef {InterpretedSuccess | InterpretedFailure} Interpretation */

/**
 * @typedef {object} InterpretRunOptions
 * @property {ConversionTarget} target - the requested target. Unused by
 *   every Phase-7 rule below; carried in the signature because a later
 *   converter-adapter issue is the one expected to add target-specific rules
 *   (spec-conversion-core.md Decision log, "Phase-8 converter's JSON shape
 *   differs from this minimum").
 */

/**
 * Classifies one finished converter run against the fixed rule table - the
 * first matching rule wins (spec-conversion-core.md "Interpretation", rules
 * 1-9). Never called for a run the queue's own `stop()` ended
 * (`run.killedBy === 'stop'`); such a run is always recorded
 * `converter_interrupted` without interpretation (see "Queue", `stop()`).
 *
 * @param {RunResult} run
 * @param {InterpretRunOptions} _options
 * @returns {Interpretation}
 */
export function interpretRun(run, _options) {
  // Rule 1: a spawn failure. Detail is the errno code only, never the raw
  // error message (which can carry the converter's install path).
  if (run.spawnError !== null) return { ok: false, error: 'converter_unavailable', detail: run.spawnError };

  // Rule 2: a signal the queue did not send (`killedBy === null` rules out
  // the runner's own cap kill), or the converter's own "interrupted" exit.
  if ((run.signal !== null && run.killedBy === null) || run.exitCode === 130) {
    return { ok: false, error: 'converter_interrupted', detail: null };
  }

  // Rule 3: usage error or tool missing.
  if (run.exitCode === 2) return { ok: false, error: 'converter_unavailable', detail: run.stderrTail };

  // Rule 4: a bad stdout line, a record that failed validation, or a cap
  // kill (which also sets `stdoutInvalid`) - checked before the exit code,
  // so a nonzero exit with garbage output is still `converter_output_invalid`.
  if (run.stdoutInvalid) return { ok: false, error: 'converter_output_invalid', detail: null };

  // Rule 5: any other non-zero exit (a real exit code, not a signal-only
  // termination, which leaves `exitCode` as `null`).
  if (run.exitCode !== null && run.exitCode !== 0) {
    return { ok: false, error: 'converter_failed', detail: failedDetail(run) };
  }

  // Rule 6: Phase 7 always converts exactly one file, so anything but one
  // record is malformed output.
  if (run.records.length !== 1) return { ok: false, error: 'converter_output_invalid', detail: null };

  return interpretSingleRecord(run);
}

/**
 * Rules 7-9, once rule 6 has confirmed there is exactly one record.
 * @param {RunResult} run
 * @returns {Interpretation}
 */
function interpretSingleRecord(run) {
  const record = run.records[0];

  // Rule 7: the record's own outcome.
  if (record.outcome === 'failed') return { ok: false, error: 'converter_failed', detail: failedDetail(run) };
  if (record.outcome === 'unsupported') return { ok: false, error: 'unsupported_source', detail: null };
  if (record.outcome === 'skipped') return { ok: false, error: 'converter_output_invalid', detail: null };

  // Rule 8: stdio never settled within `closeGraceMs`, so even a `converted`
  // record here may be incomplete and must never be published.
  if (run.stdioTimedOut) return { ok: false, error: 'converter_output_invalid', detail: null };

  // Rule 9: a genuine, complete `converted` record - handed to `verifyOutput`.
  return { ok: true, output: /** @type {string} */ (record.output), notes: record.notes };
}

/**
 * The `converter_failed` detail formula shared by rule 5 (any other
 * non-zero exit) and rule 7's `failed` outcome: the single record's own
 * `error` field when present and non-empty, else the stderr tail (an empty
 * `error` carries no diagnostic text).
 * @param {RunResult} run
 * @returns {string}
 */
function failedDetail(run) {
  const record = run.records[0];
  return record?.error || run.stderrTail;
}

const MAX_DETAIL_LENGTH = 500;
/** Regex-special characters that need escaping when building a literal-text pattern. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/;
/** Regex source matching either path separator (built via string escaping, see `toPatternSource`). */
const SEPARATOR_CLASS = '[\\\\/]';

/**
 * The filesystem roots `redactDetail` replaces, each as every spelling that
 * should count as that root.
 * @typedef {object} RedactRoots
 * @property {readonly string[]} mediaRoot - configured and realpath'd
 *   `MEDIA_ROOT` spellings.
 * @property {readonly string[]} convertDir - configured and realpath'd
 *   `CONVERT_DIR` spellings.
 * @property {string | null} converterDir - `path.dirname(converterCmd[0])`,
 *   or `null` when no converter is configured (`converterCmd === null`).
 */

/**
 * @typedef {object} RedactDetailOptions
 * @property {NodeJS.Platform} [platform] - drives case-insensitive,
 *   separator-agnostic matching; default `process.platform`.
 */

/**
 * Replaces every occurrence of the configured filesystem roots in free-form
 * converter text with a fixed placeholder, then cuts the result to its last
 * 500 characters (spec-conversion-core.md "Interpretation"). Applied to
 * `interpretRun`'s `detail` and to each converter note before either is
 * stored, returned by the API or shown in the admin panel - both can carry
 * an absolute path (ffmpeg's stderr, a Python traceback's install path).
 *
 * @param {string} text
 * @param {RedactRoots} roots
 * @param {RedactDetailOptions} [options]
 * @returns {string}
 */
export function redactDetail(text, roots, { platform = process.platform } = {}) {
  const anySeparator = platform === 'win32';
  let result = text;
  for (const { spelling, placeholder } of collectRootEntries(roots, platform)) {
    const pattern = new RegExp(toPatternSource(spelling, anySeparator), anySeparator ? 'gi' : 'g');
    result = result.replace(pattern, placeholder);
  }
  return result.length > MAX_DETAIL_LENGTH ? result.slice(-MAX_DETAIL_LENGTH) : result;
}

/**
 * Builds the (spelling, placeholder) pairs to replace, longest spelling
 * first so a shorter root never matches inside a longer sibling's spelling
 * (e.g. `/srv/media` inside `/srv/media-converted`, which would otherwise
 * yield `<MEDIA_ROOT>-converted/...`). Drops empty spellings and the
 * `<CONVERTER>` entry when its dirname is itself a filesystem root (`/`,
 * `C:\`), which would otherwise rewrite every separator in the text.
 *
 * @param {RedactRoots} roots
 * @param {NodeJS.Platform} platform
 * @returns {Array<{ spelling: string, placeholder: string }>}
 */
function collectRootEntries(roots, platform) {
  /** @type {Array<{ spelling: string, placeholder: string }>} */
  const entries = [];
  for (const spelling of roots.mediaRoot) {
    if (spelling.length > 0) entries.push({ spelling, placeholder: '<MEDIA_ROOT>' });
  }
  for (const spelling of roots.convertDir) {
    if (spelling.length > 0) entries.push({ spelling, placeholder: '<CONVERT_DIR>' });
  }
  const { converterDir } = roots;
  if (converterDir !== null && converterDir.length > 0 && !isFilesystemRoot(converterDir, platform)) {
    entries.push({ spelling: converterDir, placeholder: '<CONVERTER>' });
  }
  return entries.sort((a, b) => b.spelling.length - a.spelling.length);
}

/**
 * Whether `dirname` is itself a filesystem root, using the path semantics of
 * `platform` (not the host OS), so this is testable for both platforms from
 * either dev machine.
 * @param {string} dirname
 * @param {NodeJS.Platform} platform
 * @returns {boolean}
 */
function isFilesystemRoot(dirname, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.parse(dirname).root === dirname;
}

/**
 * Turns one root spelling into a regex source string: every path separator
 * becomes a class matching either `/` or `\` when `anySeparator` (win32),
 * every other regex-special character is escaped, everything else is
 * literal.
 *
 * @param {string} spelling
 * @param {boolean} anySeparator
 * @returns {string}
 */
function toPatternSource(spelling, anySeparator) {
  let source = '';
  for (const ch of spelling) {
    if (anySeparator && (ch === '/' || ch === '\\')) {
      source += SEPARATOR_CLASS;
    } else if (REGEX_SPECIAL.test(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  return source;
}
