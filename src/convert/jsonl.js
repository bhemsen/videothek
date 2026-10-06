import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const NEWLINE = 0x0a;
const OUTCOMES = new Set(['converted', 'skipped', 'failed', 'unsupported']);
const MAX_NOTES = 10;
const MAX_NOTE_LENGTH = 2000;

/**
 * @typedef {'converted' | 'skipped' | 'failed' | 'unsupported'} ConverterOutcome
 */

/**
 * @typedef {object} ConverterSidecar
 * @property {string} path - absolute path of the sidecar file.
 * @property {number} stream - integer stream index.
 * @property {string} language
 */

/**
 * One normalised `file` record from the converter's stdout
 * (spec-converter-adapter.md, "Converter contract"). `source`, `attempt` and
 * unknown keys are ignored.
 * @typedef {object} ConverterFileRecord
 * @property {'file'} type
 * @property {ConverterOutcome} outcome
 * @property {string | null} output - absolute path; required when `outcome`
 *   is `'converted'`, `null` when absent otherwise.
 * @property {string | null} error
 * @property {string[]} notes - at most 10 entries, each at most 2000
 *   characters.
 * @property {ConverterSidecar[]} sidecars - `[]` when null or absent.
 */

/**
 * One normalised `summary` record (the last line of a complete run).
 * @typedef {object} ConverterSummaryRecord
 * @property {'summary'} type
 * @property {number} total
 * @property {number} exitCode - the record's `exit_code`.
 */

/** @typedef {ConverterFileRecord | ConverterSummaryRecord} ConverterRecord */

/**
 * @typedef {object} JsonLinesReader
 * @property {(chunk: Buffer) => 'ok' | 'cap'} push - feeds one stdout chunk.
 *   Returns `'cap'` once a byte cap has tripped (that call and every later
 *   one); returns `'ok'` otherwise.
 * @property {() => void} end - finalises a trailing line with no terminating
 *   `\n`. A no-op once capped.
 * @property {ConverterRecord[]} records - every valid recognised (`file` or
 *   `summary`) record seen so far, in order; unknown types are dropped.
 * @property {boolean} invalid - `true` once any line failed to parse as JSON
 *   or {@link validateRecord} rejected it; sticky, never reset to `false`.
 */

/**
 * Creates a stateful reader for the converter's stdout: JSON Lines, UTF-8,
 * `\n`-separated, `\r` stripped, empty lines skipped
 * (spec-conversion-core.md, "Converter contract and stub" / "JSON Lines
 * reader"). Pure and side-effect-free so the runner's cap handling, the line
 * cap vs. the total cap, a multi-byte character split across chunks, and
 * record validation are all unit-testable without a stub process.
 *
 * Both caps count raw bytes *before* decoding, so a line or a run is capped
 * consistently regardless of how many UTF-16 code units its characters
 * decode to. Once a cap trips, no further bytes are decoded, parsed or
 * accumulated.
 *
 * @param {object} [options]
 * @param {number} [options.maxLineBytes] - a single line whose raw byte
 *   length exceeds this trips the line cap. Default `65536` (64 KiB).
 * @param {number} [options.maxTotalBytes] - once the raw bytes pushed so far
 *   exceed this, the total cap trips. Default `1048576` (1 MiB).
 * @returns {JsonLinesReader}
 */
export function createJsonLinesReader({ maxLineBytes = 65536, maxTotalBytes = 1048576 } = {}) {
  const decoder = new StringDecoder('utf8');
  let totalBytes = 0;
  let lineBytes = 0;
  let linePending = '';
  let capped = false;

  /** @type {JsonLinesReader} */
  const reader = { push, end, records: [], invalid: false };

  /**
   * @param {string} line - one decoded line, `\r`/`\n` already removed.
   */
  function finishLine(line) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) return;
    /** @type {unknown} */
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      reader.invalid = true;
      return;
    }
    const result = validateRecord(value);
    if (result === null) return;
    if (result === 'invalid') {
      reader.invalid = true;
      return;
    }
    reader.records.push(result);
  }

  /** @param {Buffer} chunk */
  function push(chunk) {
    if (capped) return 'cap';
    totalBytes += chunk.length;
    if (totalBytes > maxTotalBytes) {
      capped = true;
      return 'cap';
    }
    let offset = 0;
    while (offset < chunk.length) {
      const newlineAt = chunk.indexOf(NEWLINE, offset);
      const segmentEnd = newlineAt === -1 ? chunk.length : newlineAt;
      const segment = chunk.subarray(offset, segmentEnd);
      lineBytes += segment.length;
      if (lineBytes > maxLineBytes) {
        capped = true;
        return 'cap';
      }
      linePending += decoder.write(segment);
      if (newlineAt === -1) {
        offset = chunk.length;
      } else {
        finishLine(linePending);
        linePending = '';
        lineBytes = 0;
        offset = newlineAt + 1;
      }
    }
    return 'ok';
  }

  function end() {
    if (capped) return;
    linePending += decoder.end();
    if (linePending.length > 0 || lineBytes > 0) finishLine(linePending);
    linePending = '';
    lineBytes = 0;
  }

  return reader;
}

/**
 * @param {unknown} notes
 * @returns {notes is string[]}
 */
function isStringArray(notes) {
  return Array.isArray(notes) && notes.every((note) => typeof note === 'string');
}

/**
 * @param {unknown} sidecars
 * @returns {ConverterSidecar[] | null} the normalised list, or `null` when
 *   the value is wrongly typed.
 */
function normaliseSidecars(sidecars) {
  if (sidecars === undefined || sidecars === null) return [];
  if (!Array.isArray(sidecars)) return null;
  /** @type {ConverterSidecar[]} */
  const result = [];
  for (const entry of sidecars) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const { path: sidecarPath, stream, language } = /** @type {Record<string, unknown>} */ (entry);
    if (typeof sidecarPath !== 'string' || !isAbsolute(sidecarPath)) return null;
    if (typeof stream !== 'number' || !Number.isInteger(stream)) return null;
    if (typeof language !== 'string') return null;
    result.push({ path: sidecarPath, stream, language });
  }
  return result;
}

/**
 * @param {Record<string, unknown>} record
 * @returns {ConverterFileRecord | 'invalid'}
 */
function validateFileRecord(record) {
  if (typeof record.outcome !== 'string' || !OUTCOMES.has(record.outcome)) return 'invalid';

  const { output } = record;
  if (output !== undefined && (typeof output !== 'string' || !isAbsolute(output))) return 'invalid';
  if (record.outcome === 'converted' && output === undefined) return 'invalid';

  const { error } = record;
  if (error !== undefined && error !== null && typeof error !== 'string') return 'invalid';

  const { notes } = record;
  if (notes !== undefined && !isStringArray(notes)) return 'invalid';

  const sidecars = normaliseSidecars(record.sidecars);
  if (sidecars === null) return 'invalid';

  return {
    type: 'file',
    outcome: /** @type {ConverterOutcome} */ (record.outcome),
    output: typeof output === 'string' ? output : null,
    error: typeof error === 'string' ? error : null,
    notes: (notes ?? []).slice(0, MAX_NOTES).map((note) => note.slice(0, MAX_NOTE_LENGTH)),
    sidecars,
  };
}

/**
 * Normalises and validates one JSON-parsed stdout line against the
 * converter contract (spec-converter-adapter.md, "Converter contract").
 *
 * @param {unknown} value - the result of `JSON.parse` on one line.
 * @returns {ConverterRecord | 'invalid' | null} the normalised record;
 *   `'invalid'` for a non-object line, a missing/non-string `type`, a
 *   `schema` other than `1`, or a `file`/`summary` record with a wrongly
 *   typed field; `null` for a record of any other (unknown) type, which is
 *   ignored.
 */
export function validateRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'invalid';
  const record = /** @type {Record<string, unknown>} */ (value);
  if (typeof record.type !== 'string' || record.schema !== 1) return 'invalid';
  if (record.type === 'file') return validateFileRecord(record);
  if (record.type === 'summary') {
    const { total, exit_code: exitCode } = record;
    if (typeof total !== 'number' || !Number.isInteger(total)) return 'invalid';
    if (typeof exitCode !== 'number' || !Number.isInteger(exitCode)) return 'invalid';
    return { type: 'summary', total, exitCode };
  }
  return null;
}
