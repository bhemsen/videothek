import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretRun, redactDetail } from '../../src/convert/result.js';

/** @typedef {import('../../src/convert/jsonl.js').ConverterFileRecord} FileRecord */
/** @typedef {import('../../src/convert/jsonl.js').ConverterSummaryRecord} SummaryRecord */

/** @type {import('../../src/convert/run-converter.js').RunResult} */
const DEFAULT_RUN = {
  spawnError: null,
  exitCode: 0,
  signal: null,
  killedBy: null,
  records: [],
  stdoutInvalid: false,
  stdioTimedOut: false,
  stderrTail: '',
};

/** @type {FileRecord} */
const FILE = { type: 'file', outcome: 'converted', output: '/out/clip.mp4', error: null, notes: [], sidecars: [] };
/** @type {SummaryRecord} */
const SUMMARY = { type: 'summary', total: 1, exitCode: 0 };

/** A complete, valid run: one `file` record followed by the `summary`. */
const GOOD_RECORDS = [FILE, SUMMARY];

const TARGET = { target: /** @type {const} */ ('web') };
const INVALID = { ok: false, error: 'converter_output_invalid', detail: null };

/**
 * @param {Partial<FileRecord>} patch
 * @returns {FileRecord}
 */
const file = (patch) => ({ ...FILE, ...patch });

// --- interpretRun: rules 1-3 ---

test('interpretRun: rule 1 - a spawn failure is converter_unavailable with the errno code as detail', () => {
  const run = { ...DEFAULT_RUN, spawnError: 'ENOENT' };
  assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'converter_unavailable', detail: 'ENOENT' });
});

test('interpretRun: rule 1 wins over every later rule', () => {
  const run = { ...DEFAULT_RUN, spawnError: 'EACCES', exitCode: 130 };
  assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'converter_unavailable', detail: 'EACCES' });
});

test('interpretRun: rule 2 - a foreign signal (not the runner\'s own kill) is converter_interrupted', () => {
  const run = { ...DEFAULT_RUN, exitCode: null, signal: /** @type {const} */ ('SIGSEGV'), killedBy: null };
  assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'converter_interrupted', detail: null });
});

test('interpretRun: rule 2 - exit 130 and exit 143 are converter_interrupted', () => {
  for (const exitCode of [130, 143]) {
    const run = { ...DEFAULT_RUN, exitCode, records: GOOD_RECORDS };
    assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'converter_interrupted', detail: null }, String(exitCode));
  }
});

test('interpretRun: a cap kill is not rule 2 (killedBy is not null) - falls through to rule 4', () => {
  const run = {
    ...DEFAULT_RUN,
    exitCode: null,
    signal: /** @type {const} */ ('SIGKILL'),
    killedBy: /** @type {const} */ ('cap'),
    stdoutInvalid: true,
  };
  assert.deepEqual(interpretRun(run, TARGET), INVALID);
});

test('interpretRun: rule 3 - exit 2 with otherwise-valid JSON is converter_unavailable with the stderr tail', () => {
  const run = { ...DEFAULT_RUN, exitCode: 2, records: GOOD_RECORDS, stderrTail: 'usage: --to <target> --json <src> <outdir>' };
  assert.deepEqual(interpretRun(run, TARGET), {
    ok: false,
    error: 'converter_unavailable',
    detail: 'usage: --to <target> --json <src> <outdir>',
  });
});

test('interpretRun: rule 3 wins over rule 4 (exit 2 with a bad stdout line)', () => {
  const run = { ...DEFAULT_RUN, exitCode: 2, stdoutInvalid: true, stderrTail: 'usage error' };
  assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'converter_unavailable', detail: 'usage error' });
});

// --- interpretRun: rules 4-5 ---

test('interpretRun: rule 4 - exit 1 with an invalid stdout (bad line, schema 2, missing type) is converter_output_invalid', () => {
  const run = { ...DEFAULT_RUN, exitCode: 1, stdoutInvalid: true };
  assert.deepEqual(interpretRun(run, TARGET), INVALID);
});

test('interpretRun: rule 5 - exit 1 with a failed file record uses the record error as detail', () => {
  const run = {
    ...DEFAULT_RUN,
    exitCode: 1,
    records: [file({ outcome: 'failed', output: null, error: 'ffmpeg exited with 1' }), { ...SUMMARY, exitCode: 1 }],
  };
  assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'converter_failed', detail: 'ffmpeg exited with 1' });
});

test('interpretRun: rule 5 falls back to the stderr tail when there is no record error', () => {
  const run = { ...DEFAULT_RUN, exitCode: 3, stderrTail: 'Traceback (most recent call last): ...' };
  assert.deepEqual(interpretRun(run, TARGET), {
    ok: false,
    error: 'converter_failed',
    detail: 'Traceback (most recent call last): ...',
  });
});

test('interpretRun: rule 5 does not treat a signal-only termination (exitCode null) as a non-zero exit', () => {
  // Falls through rule 5 to rule 6 (zero records -> invalid).
  const run = { ...DEFAULT_RUN, exitCode: null };
  assert.deepEqual(interpretRun(run, TARGET), INVALID);
});

// --- interpretRun: rule 6 (file records) ---

test('interpretRun: rule 6 - zero records is converter_output_invalid', () => {
  assert.deepEqual(interpretRun({ ...DEFAULT_RUN, records: [] }, TARGET), INVALID);
});

test('interpretRun: rule 6 - a summary without a file record is converter_output_invalid', () => {
  assert.deepEqual(interpretRun({ ...DEFAULT_RUN, records: [{ ...SUMMARY, total: 0 }] }, TARGET), INVALID);
});

test('interpretRun: rule 6 - more than one file record is converter_output_invalid', () => {
  assert.deepEqual(interpretRun({ ...DEFAULT_RUN, records: [FILE, FILE, SUMMARY] }, TARGET), INVALID);
});

// --- interpretRun: rule 7 (summary) ---

test('interpretRun: rule 7 - a missing summary is converter_output_invalid', () => {
  assert.deepEqual(interpretRun({ ...DEFAULT_RUN, records: [FILE] }, TARGET), INVALID);
});

test('interpretRun: rule 7 - more than one summary is converter_output_invalid', () => {
  assert.deepEqual(interpretRun({ ...DEFAULT_RUN, records: [FILE, SUMMARY, SUMMARY] }, TARGET), INVALID);
});

test('interpretRun: rule 7 - a summary that is not the last recognised record is converter_output_invalid', () => {
  assert.deepEqual(interpretRun({ ...DEFAULT_RUN, records: [SUMMARY, FILE] }, TARGET), INVALID);
});

test('interpretRun: rule 7 - summary total 2 or exit_code other than 0 is converter_output_invalid', () => {
  assert.deepEqual(interpretRun({ ...DEFAULT_RUN, records: [FILE, { ...SUMMARY, total: 2 }] }, TARGET), INVALID);
  assert.deepEqual(interpretRun({ ...DEFAULT_RUN, records: [FILE, { ...SUMMARY, exitCode: 1 }] }, TARGET), INVALID);
});

// --- interpretRun: rule 8 (each outcome) ---

test('interpretRun: rule 8 - outcome failed is converter_failed with the record error', () => {
  const run = { ...DEFAULT_RUN, records: [file({ outcome: 'failed', error: 'no audio stream' }), SUMMARY] };
  assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'converter_failed', detail: 'no audio stream' });
});

test('interpretRun: rule 8 - outcome failed with a null or empty record error falls back to the stderr tail', () => {
  for (const error of [null, '']) {
    const run = { ...DEFAULT_RUN, stderrTail: 'stderr detail', records: [file({ outcome: 'failed', error }), SUMMARY] };
    assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'converter_failed', detail: 'stderr detail' });
  }
});

test('interpretRun: rule 8 - exit 0 with outcome unsupported is unsupported_source', () => {
  const run = { ...DEFAULT_RUN, records: [file({ outcome: 'unsupported', output: null }), SUMMARY] };
  assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'unsupported_source', detail: null });
});

test('interpretRun: rule 8 - outcome skipped is converter_output_invalid', () => {
  const run = { ...DEFAULT_RUN, records: [file({ outcome: 'skipped', output: null }), SUMMARY] };
  assert.deepEqual(interpretRun(run, TARGET), INVALID);
});

// --- interpretRun: rules 9-10 ---

test('interpretRun: rule 9 - stdioTimedOut with a complete converted run is still converter_output_invalid', () => {
  assert.deepEqual(interpretRun({ ...DEFAULT_RUN, stdioTimedOut: true, records: GOOD_RECORDS }, TARGET), INVALID);
});

test('interpretRun: rule 10 - a v3.3 run (file + summary) is ok with output, notes and sidecars', () => {
  const sidecars = [{ path: '/out/web.de.vtt', stream: 2, language: 'de' }];
  const run = { ...DEFAULT_RUN, records: [file({ output: '/out/web.mp4', notes: ['re-encoded audio'], sidecars }), SUMMARY] };
  assert.deepEqual(interpretRun(run, TARGET), { ok: true, output: '/out/web.mp4', notes: ['re-encoded audio'], sidecars });
});

test('interpretRun: rule 10 - a v3.2 run without sidecars (normalised to []) is ok', () => {
  const run = { ...DEFAULT_RUN, records: GOOD_RECORDS };
  assert.deepEqual(interpretRun(run, TARGET), { ok: true, output: '/out/clip.mp4', notes: [], sidecars: [] });
});

// --- redactDetail ---

/** @type {import('../../src/convert/result.js').RedactRoots} */
const EMPTY_ROOTS = { mediaRoot: [], convertDir: [], converterDir: null };

test('redactDetail: cuts to the last 500 characters when there is nothing to redact', () => {
  const text = 'y'.repeat(600);
  const result = redactDetail(text, EMPTY_ROOTS);
  assert.equal(result.length, 500);
  assert.equal(result, 'y'.repeat(500));
});

test('redactDetail: redacts before cutting, so a root straddling the cut point is still replaced', () => {
  // 512 chars raw; cutting first would keep 'rv/media/a...' and leak the root
  // remainder. Redacting first yields 514 chars, whose last 500 start mid-placeholder.
  /** @type {import('../../src/convert/result.js').RedactRoots} */
  const roots = { mediaRoot: ['/srv/media'], convertDir: [], converterDir: null };
  const text = `${'x'.repeat(10)}/srv/media/a${'y'.repeat(490)}`;
  assert.equal(redactDetail(text, roots, { platform: 'linux' }), `IA_ROOT>/a${'y'.repeat(490)}`);
});

test('redactDetail: replaces the longest root spelling first so a shorter root never matches inside it', () => {
  /** @type {import('../../src/convert/result.js').RedactRoots} */
  const roots = { mediaRoot: ['/srv/media'], convertDir: ['/srv/media-converted'], converterDir: null };
  const text = 'wrote to /srv/media-converted/x.mp4, read from /srv/media/src.mkv';
  assert.equal(redactDetail(text, roots, { platform: 'linux' }), 'wrote to <CONVERT_DIR>/x.mp4, read from <MEDIA_ROOT>/src.mkv');
});

test('redactDetail: replaces every configured spelling of a root, not only the first', () => {
  /** @type {import('../../src/convert/result.js').RedactRoots} */
  const roots = { mediaRoot: ['/media', '/real/media'], convertDir: [], converterDir: null };
  const text = 'a /media/x.mkv and a symlinked /real/media/y.mkv';
  assert.equal(redactDetail(text, roots, { platform: 'linux' }), 'a <MEDIA_ROOT>/x.mkv and a symlinked <MEDIA_ROOT>/y.mkv');
});

test('redactDetail: replaces all three roots, including <CONVERTER> for the converter install dir', () => {
  /** @type {import('../../src/convert/result.js').RedactRoots} */
  const roots = { mediaRoot: ['/media'], convertDir: ['/data/converted'], converterDir: '/opt/converter' };
  const text = 'src /media/movie.mkv out /data/converted/x.mp4 via /opt/converter/ffmpeg: boom';
  assert.equal(
    redactDetail(text, roots, { platform: 'linux' }),
    'src <MEDIA_ROOT>/movie.mkv out <CONVERT_DIR>/x.mp4 via <CONVERTER>/ffmpeg: boom',
  );
});

test('redactDetail: skips <CONVERTER> when the converter dirname is a filesystem root', () => {
  /** @type {import('../../src/convert/result.js').RedactRoots} */
  const roots = { mediaRoot: [], convertDir: [], converterDir: '/' };
  const text = 'ran /ffmpeg --version: boom';
  assert.equal(redactDetail(text, roots, { platform: 'linux' }), text);
});

test('redactDetail: on win32 matches case-insensitively and with either separator style', () => {
  /** @type {import('../../src/convert/result.js').RedactRoots} */
  const roots = { mediaRoot: ['C:\\Media'], convertDir: [], converterDir: null };
  const text = 'from c:/MEDIA/Movie.mkv and C:\\Media\\other.mkv';
  const result = redactDetail(text, roots, { platform: 'win32' });
  assert.equal(result, 'from <MEDIA_ROOT>/Movie.mkv and <MEDIA_ROOT>\\other.mkv');
});

test('redactDetail: on win32 also skips <CONVERTER> for a drive-letter filesystem root', () => {
  /** @type {import('../../src/convert/result.js').RedactRoots} */
  const roots = { mediaRoot: [], convertDir: [], converterDir: 'C:\\' };
  const text = 'ran C:\\node.exe --version';
  assert.equal(redactDetail(text, roots, { platform: 'win32' }), text);
});

test('redactDetail: does not match a differently-cased root off win32', () => {
  // Explicit non-win32 platform: default `process.platform` is the host OS
  // and must not be relied on for this assertion (it is 'win32' when this
  // suite runs on a Windows dev machine).
  /** @type {import('../../src/convert/result.js').RedactRoots} */
  const roots = { mediaRoot: ['/srv/media'], convertDir: [], converterDir: null };
  const text = '/SRV/MEDIA/movie.mkv';
  assert.equal(redactDetail(text, roots, { platform: 'linux' }), text);
});
