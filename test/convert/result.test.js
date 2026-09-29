import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretRun, redactDetail } from '../../src/convert/result.js';

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

/** @type {import('../../src/convert/jsonl.js').ConverterRecord} */
const DEFAULT_RECORD = { outcome: 'converted', output: '/out/clip.mp4', error: null, notes: [] };

const TARGET = { target: /** @type {const} */ ('web') };

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

test('interpretRun: rule 2 - exit 130 is converter_interrupted', () => {
  const run = { ...DEFAULT_RUN, exitCode: 130 };
  assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'converter_interrupted', detail: null });
});

test('interpretRun: a cap kill is not rule 2 (killedBy is not null) - falls through to rule 4', () => {
  const run = {
    ...DEFAULT_RUN,
    exitCode: null,
    signal: /** @type {const} */ ('SIGKILL'),
    killedBy: /** @type {const} */ ('cap'),
    stdoutInvalid: true,
  };
  assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'converter_output_invalid', detail: null });
});

test('interpretRun: rule 3 - exit 2 with otherwise-valid JSON is converter_unavailable with the stderr tail', () => {
  const run = { ...DEFAULT_RUN, exitCode: 2, stderrTail: 'usage: --to <target> --json <src> <outdir>' };
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

// --- interpretRun: rules 4-6 ---

test('interpretRun: rule 4 - exit 1 with a garbage stdout line is converter_output_invalid, not converter_failed', () => {
  const run = { ...DEFAULT_RUN, exitCode: 1, stdoutInvalid: true };
  assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'converter_output_invalid', detail: null });
});

test('interpretRun: rule 5 - any other non-zero exit is converter_failed with the record error', () => {
  const run = {
    ...DEFAULT_RUN,
    exitCode: 1,
    records: [{ ...DEFAULT_RECORD, outcome: /** @type {const} */ ('failed'), error: 'ffmpeg exited with 1' }],
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
  // No signal and no exitCode - falls through rule 5 to rule 6 (zero records -> invalid),
  // never misread as "any other non-zero exit" because null !== 0 alone is not a real exit code.
  const run = { ...DEFAULT_RUN, exitCode: null };
  assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'converter_output_invalid', detail: null });
});

test('interpretRun: rule 6 - zero records is converter_output_invalid', () => {
  const run = { ...DEFAULT_RUN, records: [] };
  assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'converter_output_invalid', detail: null });
});

test('interpretRun: rule 6 - more than one record is converter_output_invalid', () => {
  const run = { ...DEFAULT_RUN, records: [DEFAULT_RECORD, DEFAULT_RECORD] };
  assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'converter_output_invalid', detail: null });
});

// --- interpretRun: rule 7 (each outcome) ---

test('interpretRun: rule 7 - outcome failed is converter_failed with the record error', () => {
  const run = { ...DEFAULT_RUN, records: [{ ...DEFAULT_RECORD, outcome: /** @type {const} */ ('failed'), error: 'no audio stream' }] };
  assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'converter_failed', detail: 'no audio stream' });
});

test('interpretRun: rule 7 - outcome failed with no record error falls back to the stderr tail', () => {
  const run = {
    ...DEFAULT_RUN,
    stderrTail: 'stderr detail',
    records: [{ ...DEFAULT_RECORD, outcome: /** @type {const} */ ('failed'), error: null }],
  };
  assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'converter_failed', detail: 'stderr detail' });
});

test('interpretRun: rule 7 - outcome unsupported is unsupported_source', () => {
  const run = { ...DEFAULT_RUN, records: [{ ...DEFAULT_RECORD, outcome: /** @type {const} */ ('unsupported'), output: null }] };
  assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'unsupported_source', detail: null });
});

test('interpretRun: rule 7 - outcome skipped is converter_output_invalid', () => {
  const run = { ...DEFAULT_RUN, records: [{ ...DEFAULT_RECORD, outcome: /** @type {const} */ ('skipped'), output: null }] };
  assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'converter_output_invalid', detail: null });
});

// --- interpretRun: rules 8-9 ---

test('interpretRun: rule 8 - stdioTimedOut with one valid converted record is still converter_output_invalid', () => {
  const run = { ...DEFAULT_RUN, stdioTimedOut: true, records: [{ ...DEFAULT_RECORD }] };
  assert.deepEqual(interpretRun(run, TARGET), { ok: false, error: 'converter_output_invalid', detail: null });
});

test('interpretRun: rule 9 - a complete converted record is ok with its output and notes', () => {
  const run = { ...DEFAULT_RUN, records: [{ ...DEFAULT_RECORD, output: '/out/web.mp4', notes: ['re-encoded audio'] }] };
  assert.deepEqual(interpretRun(run, TARGET), { ok: true, output: '/out/web.mp4', notes: ['re-encoded audio'] });
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
