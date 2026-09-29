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
 * One normalised per-file record from the converter's stdout
 * (spec-conversion-core.md, "Converter contract and stub"). Phase 7 parses
 * only these four fields; `source` is ignored.
 * @typedef {object} ConverterRecord
 * @property {ConverterOutcome} outcome
 * @property {string | null} output - absolute path; required when `outcome`
 *   is `'converted'`, `null` when absent otherwise.
 * @property {string | null} error
 * @property {string[]} notes - at most 10 entries, each at most 2000
 *   characters.
 */

/**
 * @typedef {object} JsonLinesReader
 * @property {(chunk: Buffer) => 'ok' | 'cap'} push - feeds one stdout chunk.
 *   Returns `'cap'` once a byte cap has tripped (that call and every later
 *   one); returns `'ok'` otherwise.
 * @property {() => void} end - finalises a trailing line with no terminating
 *   `\n`. A no-op once capped.
 * @property {ConverterRecord[]} records - every valid per-file record seen
 *   so far, in order.
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
 * Normalises and validates one JSON-parsed stdout line against the
 * converter contract (spec-conversion-core.md, "Converter contract and
 * stub" / "Record validation"). `source` is accepted but ignored, per the
 * Phase-7 field set.
 *
 * @param {unknown} value - the result of `JSON.parse` on one line.
 * @returns {ConverterRecord | 'invalid' | null} the normalised record;
 *   `'invalid'` for a non-object line, an `outcome` outside the set, a
 *   non-absolute or non-string `output`, a `converted` record with no
 *   `output`, a non-string/non-null `error`, or `notes` that is not an array
 *   of strings; `null` for an object with no `outcome` field at all (e.g.
 *   the stub's summary line), which is ignored.
 */
export function validateRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'invalid';
  const record = /** @type {Record<string, unknown>} */ (value);
  if (record.outcome === undefined) return null;
  if (typeof record.outcome !== 'string' || !OUTCOMES.has(record.outcome)) return 'invalid';

  const { output } = record;
  if (output !== undefined && (typeof output !== 'string' || !isAbsolute(output))) return 'invalid';
  if (record.outcome === 'converted' && output === undefined) return 'invalid';

  const { error } = record;
  if (error !== undefined && error !== null && typeof error !== 'string') return 'invalid';

  const { notes } = record;
  if (notes !== undefined && !isStringArray(notes)) return 'invalid';

  return {
    outcome: /** @type {ConverterOutcome} */ (record.outcome),
    output: typeof output === 'string' ? output : null,
    error: typeof error === 'string' ? error : null,
    notes: (notes ?? []).slice(0, MAX_NOTES).map((note) => note.slice(0, MAX_NOTE_LENGTH)),
  };
}
