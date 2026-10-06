import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createJsonLinesReader, validateRecord } from '../../src/convert/jsonl.js';

// --- validateRecord ---

const abs = path.resolve('/out/clip.mp4');
/** @param {Record<string, unknown>} fields */
const file = (fields) => ({ type: 'file', schema: 1, ...fields });

test('validateRecord: rejects a non-object line', () => {
  for (const value of ['hello', 42, true, null, [1, 2, 3]]) {
    assert.equal(validateRecord(value), 'invalid');
  }
});

test('validateRecord: a record without type, with a non-string type, or with schema other than 1 is invalid', () => {
  assert.equal(validateRecord({ schema: 1, outcome: 'skipped' }), 'invalid');
  assert.equal(validateRecord({ type: 7, schema: 1 }), 'invalid');
  assert.equal(validateRecord({ type: 'file', outcome: 'skipped' }), 'invalid');
  assert.equal(validateRecord({ type: 'file', schema: 2, outcome: 'skipped' }), 'invalid');
  assert.equal(validateRecord({ type: 'file', schema: '1', outcome: 'skipped' }), 'invalid');
  assert.equal(validateRecord({ type: 'summary', schema: 2, total: 1, exit_code: 0 }), 'invalid');
  assert.equal(validateRecord({ type: 'mystery', schema: 2 }), 'invalid');
});

test('validateRecord: an unknown record type with schema 1 is ignored', () => {
  assert.equal(validateRecord({ type: 'progress', schema: 1, percent: 50 }), null);
});

test('validateRecord: rejects an outcome outside the set', () => {
  assert.equal(validateRecord(file({ outcome: 'done' })), 'invalid');
  assert.equal(validateRecord(file({ outcome: 123 })), 'invalid');
  assert.equal(validateRecord(file({})), 'invalid');
});

test('validateRecord: converted requires an absolute output', () => {
  assert.equal(validateRecord(file({ outcome: 'converted' })), 'invalid');
  assert.equal(validateRecord(file({ outcome: 'converted', output: 'relative/path.mp4' })), 'invalid');
  assert.equal(validateRecord(file({ outcome: 'converted', output: 42 })), 'invalid');
  assert.deepEqual(validateRecord(file({ outcome: 'converted', output: abs })), {
    type: 'file',
    outcome: 'converted',
    output: abs,
    error: null,
    notes: [],
    sidecars: [],
  });
});

test('validateRecord: rejects bad error and notes field types', () => {
  assert.equal(validateRecord(file({ outcome: 'failed', error: 42 })), 'invalid');
  assert.equal(validateRecord(file({ outcome: 'failed', notes: 'oops' })), 'invalid');
  assert.equal(validateRecord(file({ outcome: 'failed', notes: ['ok', 5] })), 'invalid');
  assert.deepEqual(validateRecord(file({ outcome: 'failed', error: 'boom', output: abs })), {
    type: 'file',
    outcome: 'failed',
    output: abs,
    error: 'boom',
    notes: [],
    sidecars: [],
  });
});

test('validateRecord: unknown keys and source/attempt are ignored', () => {
  const result = validateRecord(file({ outcome: 'skipped', source: '/a.mkv', attempt: 2, future: { x: 1 } }));
  assert.deepEqual(result, { type: 'file', outcome: 'skipped', output: null, error: null, notes: [], sidecars: [] });
});

test('validateRecord: sidecars null or absent normalise to [], a valid list is kept', () => {
  const vtt = path.resolve('/out/clip.de.vtt');
  const base = { outcome: 'converted', output: abs };
  const read = (/** @type {unknown} */ sidecars) => {
    const result = validateRecord(file({ ...base, ...(sidecars === undefined ? {} : { sidecars }) }));
    return typeof result === 'object' && result?.type === 'file' ? result.sidecars : result;
  };
  assert.deepEqual(read(undefined), []);
  assert.deepEqual(read(null), []);
  assert.deepEqual(read([]), []);
  assert.deepEqual(read([{ path: vtt, stream: 2, language: 'de', extra: true }]), [{ path: vtt, stream: 2, language: 'de' }]);
});

test('validateRecord: wrong-typed sidecars are invalid', () => {
  const vtt = path.resolve('/out/clip.de.vtt');
  const bad = [
    'x', 5, {}, [null], [[]], ['x'],
    [{ path: 'rel.vtt', stream: 0, language: 'de' }],
    [{ path: 7, stream: 0, language: 'de' }],
    [{ path: vtt, stream: 1.5, language: 'de' }],
    [{ path: vtt, stream: '1', language: 'de' }],
    [{ path: vtt, stream: 0, language: 3 }],
    [{ path: vtt, stream: 0 }],
  ];
  for (const sidecars of bad) {
    assert.equal(validateRecord(file({ outcome: 'converted', output: abs, sidecars })), 'invalid', JSON.stringify(sidecars));
  }
});

test('validateRecord: summary needs integer total and exit_code; other keys are ignored', () => {
  const summary = { type: 'summary', schema: 1, total: 1, exit_code: 0, converted: 1, dry_run: false };
  assert.deepEqual(validateRecord(summary), { type: 'summary', total: 1, exitCode: 0 });
  for (const patch of [{ total: '1' }, { total: 1.5 }, { total: undefined }, { exit_code: null }, { exit_code: '0' }, { exit_code: undefined }]) {
    assert.equal(validateRecord({ ...summary, ...patch }), 'invalid', JSON.stringify(patch));
  }
});

test('validateRecord: notes keep only the first 10 entries, each cut to 2000 characters', () => {
  const notes = Array.from({ length: 15 }, (_, i) => (i === 0 ? 'x'.repeat(2500) : `n${i}`));
  const result = validateRecord(file({ outcome: 'skipped', notes }));
  if (result === 'invalid' || result === null || result.type !== 'file') throw new Error('expected a normalised file record');
  assert.equal(result.notes.length, 10);
  assert.equal(result.notes[0].length, 2000);
  assert.equal(result.notes[0], 'x'.repeat(2000));
  assert.equal(result.notes[9], 'n9');
});

// --- createJsonLinesReader ---

/**
 * @param {string} outcome
 * @param {string} [extra] raw JSON fragment appended inside the object
 * @returns {string} one `file` record as a JSON line (no newline)
 */
const F = (outcome, extra = '') => `{"type":"file","schema":1,"outcome":"${outcome}"${extra}}`;
/** @param {import('../../src/convert/jsonl.js').ConverterRecord} r */
const label = (r) => (r.type === 'file' ? r.outcome : r.type);

test('createJsonLinesReader: parses records in order, skips empty lines, strips \r, drops unknown types', () => {
  const reader = createJsonLinesReader();
  const payload = `${F('skipped')}\r\n\r\n{"type":"progress","schema":1}\n${F('unsupported')}\r\n{"type":"summary","schema":1,"total":1,"exit_code":0}\n`;
  assert.equal(reader.push(Buffer.from(payload, 'utf8')), 'ok');
  assert.equal(reader.invalid, false);
  assert.deepEqual(reader.records.map(label), ['skipped', 'unsupported', 'summary']);
});

test('createJsonLinesReader: a bad JSON line marks invalid but keeps reading', () => {
  const reader = createJsonLinesReader();
  reader.push(Buffer.from(`not-json\n${F('skipped')}\n`, 'utf8'));
  assert.equal(reader.invalid, true);
  assert.deepEqual(reader.records.map(label), ['skipped']);
});

test('createJsonLinesReader: a record without type or with schema 2 marks the stream invalid', () => {
  for (const line of ['{"outcome":"skipped"}', '{"type":"file","schema":2,"outcome":"skipped"}']) {
    const reader = createJsonLinesReader();
    reader.push(Buffer.from(`${line}\n`, 'utf8'));
    assert.equal(reader.invalid, true, line);
  }
});

test('createJsonLinesReader: end() finalises a trailing line with no newline', () => {
  const reader = createJsonLinesReader();
  reader.push(Buffer.from(F('failed', ',"error":"x"'), 'utf8'));
  assert.equal(reader.records.length, 0);
  reader.end();
  assert.deepEqual(reader.records.map(label), ['failed']);
});

test('createJsonLinesReader: a multi-byte character split across two chunks decodes intact', () => {
  const text = 'café-🎬-end';
  const payload = `${JSON.stringify(file({ outcome: 'skipped', notes: [text] }))}\n`;
  const buf = Buffer.from(payload, 'utf8');
  const markerIndex = payload.indexOf('🎬');
  const splitAt = Buffer.byteLength(payload.slice(0, markerIndex), 'utf8') + 2; // mid 4-byte emoji
  const reader = createJsonLinesReader();
  assert.equal(reader.push(buf.subarray(0, splitAt)), 'ok');
  assert.equal(reader.push(buf.subarray(splitAt)), 'ok');
  assert.equal(reader.records.length, 1);
  const [record] = reader.records;
  assert.equal(record.type === 'file' ? record.notes[0] : null, text);
});

test('createJsonLinesReader: line cap boundary — exact size ok, one byte more caps', () => {
  const ok = createJsonLinesReader({ maxLineBytes: 10, maxTotalBytes: 1000 });
  assert.equal(ok.push(Buffer.from(`${'a'.repeat(10)}\n`, 'utf8')), 'ok');
  const capped = createJsonLinesReader({ maxLineBytes: 10, maxTotalBytes: 1000 });
  assert.equal(capped.push(Buffer.from(`${'a'.repeat(11)}\n`, 'utf8')), 'cap');
});

test('createJsonLinesReader: total cap boundary — exact size ok, one byte more caps', () => {
  const ok = createJsonLinesReader({ maxLineBytes: 1000, maxTotalBytes: 10 });
  assert.equal(ok.push(Buffer.from('a'.repeat(10), 'utf8')), 'ok');
  const capped = createJsonLinesReader({ maxLineBytes: 1000, maxTotalBytes: 10 });
  assert.equal(capped.push(Buffer.from('a'.repeat(11), 'utf8')), 'cap');
});

test('createJsonLinesReader: default caps — a single line over 64 KiB trips the line cap while the total stays under 1 MiB', () => {
  const reader = createJsonLinesReader();
  const result = reader.push(Buffer.from(`${'a'.repeat(70000)}\n`, 'utf8'));
  assert.equal(result, 'cap');
});

test('createJsonLinesReader: default caps — many short lines over 1 MiB trip the total cap', () => {
  const reader = createJsonLinesReader();
  const chunk = Buffer.from('{}\n'.repeat(20000), 'utf8'); // 60000 bytes, well under the line cap
  let result = 'ok';
  for (let i = 0; i < 30 && result === 'ok'; i++) result = reader.push(chunk);
  assert.equal(result, 'cap');
});

test('createJsonLinesReader: after cap, nothing more is accumulated', () => {
  const reader = createJsonLinesReader({ maxLineBytes: 10, maxTotalBytes: 10 });
  assert.equal(reader.push(Buffer.from('aaaaaaaaaaaa\n', 'utf8')), 'cap');
  const recordsBefore = reader.records.length;
  const invalidBefore = reader.invalid;
  assert.equal(reader.push(Buffer.from('{"outcome":"skipped"}\n', 'utf8')), 'cap');
  assert.equal(reader.records.length, recordsBefore);
  assert.equal(reader.invalid, invalidBefore);
});
