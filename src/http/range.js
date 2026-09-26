/**
 * @typedef {{ type: 'none' }} RangeNone
 * @typedef {{ type: 'range', start: number, end: number }} RangeSatisfiable
 * @typedef {{ type: 'unsatisfiable' }} RangeUnsatisfiable
 * @typedef {RangeNone | RangeSatisfiable | RangeUnsatisfiable} RangeResult
 */

const RANGE_PREFIX = 'bytes=';
const SPEC_PATTERN = /^(\d*)-(\d*)$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Parses an HTTP `Range` request header for a single byte-range against a
 * resource of the given size. Defined for `GET` only (RFC 9110 §14.2); the
 * caller must not invoke this for other methods.
 *
 * Follows the `send`/`range-parser` precedent recorded in the "Range
 * semantics" decision of docs/specs/spec-video-streaming.md: a missing or
 * malformed header, one not using the `bytes` unit, or one carrying more
 * than one range-spec is ignored (`none`, i.e. send the whole entity with
 * `200`); a syntactically valid but out-of-bounds range is `unsatisfiable`
 * (`416`); everything else is a clamped, satisfiable `range` (`206`).
 *
 * Pure and side-effect free: performs no I/O and touches no external state.
 *
 * @param {string | undefined | null} header - the raw `Range` header value.
 * @param {number} size - the resource size in bytes.
 * @returns {RangeResult} the parsed range decision.
 */
export function parseRange(header, size) {
  if (typeof header !== 'string' || !header.startsWith(RANGE_PREFIX)) {
    return { type: 'none' };
  }
  const specs = header.slice(RANGE_PREFIX.length).split(',');
  if (specs.length !== 1) {
    return { type: 'none' };
  }
  const match = SPEC_PATTERN.exec(specs[0].trim());
  if (!match || (match[1] === '' && match[2] === '')) {
    return { type: 'none' };
  }
  return resolveRange(match[1], match[2], size);
}

/**
 * Resolves a syntactically valid `start-end` or suffix (`-n`) spec against
 * the resource size, applying the clamping, empty-resource and
 * oversized-digit-string rules from the Range semantics decision.
 *
 * @param {string} startStr - digits before `-`, or `''` for a suffix spec.
 * @param {string} endStr - digits after `-`, or `''` for an open-ended spec.
 * @param {number} size - the resource size in bytes.
 * @returns {RangeResult} the parsed range decision.
 */
function resolveRange(startStr, endStr, size) {
  if (size === 0) {
    return { type: 'unsatisfiable' };
  }
  if (startStr === '') {
    return resolveSuffix(endStr, size);
  }
  const start = parseUint(startStr);
  if (start.oversized || start.value >= size) {
    return { type: 'unsatisfiable' };
  }
  const end = endStr === '' ? size - 1 : clampEnd(parseUint(endStr), size);
  if (start.value > end) {
    return { type: 'unsatisfiable' };
  }
  return { type: 'range', start: start.value, end };
}

/**
 * Resolves a suffix-length spec (`-n`, "the last n bytes") against the
 * resource size: `n === 0` is unsatisfiable, `n >= size` (or an oversized
 * digit string) serves the whole file.
 *
 * @param {string} suffixStr - digits of the suffix length.
 * @param {number} size - the resource size in bytes (never 0 here).
 * @returns {RangeResult} the parsed range decision.
 */
function resolveSuffix(suffixStr, size) {
  const suffix = parseUint(suffixStr);
  if (!suffix.oversized && suffix.value === 0) {
    return { type: 'unsatisfiable' };
  }
  if (suffix.oversized || suffix.value >= size) {
    return { type: 'range', start: 0, end: size - 1 };
  }
  return { type: 'range', start: size - suffix.value, end: size - 1 };
}

/**
 * Clamps a parsed end value to the last valid byte offset of the resource.
 *
 * @param {{ oversized: boolean, value: number }} end - the parsed end digits.
 * @param {number} size - the resource size in bytes.
 * @returns {number} the clamped end offset.
 */
function clampEnd(end, size) {
  if (end.oversized || end.value > size - 1) {
    return size - 1;
  }
  return end.value;
}

/**
 * Parses a digit string as an unsigned integer, flagging values beyond
 * `Number.MAX_SAFE_INTEGER` as oversized instead of silently losing
 * precision.
 *
 * @param {string} digits - a non-empty string of ASCII digits.
 * @returns {{ oversized: boolean, value: number }} the parsed value, or
 *   `oversized: true` (with `value` unset) when it exceeds the safe range.
 */
function parseUint(digits) {
  const big = BigInt(digits);
  if (big > MAX_SAFE) {
    return { oversized: true, value: NaN };
  }
  return { oversized: false, value: Number(big) };
}
