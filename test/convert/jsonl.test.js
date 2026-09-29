import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createJsonLinesReader, validateRecord } from '../../src/convert/jsonl.js';

// --- validateRecord ---

test('validateRecord: ignores an object with no outcome field', () => {
  assert.equal(validateRecord({ note: 'summary line' }), null);
});

test('validateRecord: rejects a non-object line', () => {
  for (const value of ['hello', 42, true, null, [1, 2, 3]]) {
    assert.equal(validateRecord(value), 'invalid');
  }
});

test('validateRecord: rejects an outcome outside the set', () => {
  assert.equal(validateRecord({ outcome: 'done' }), 'invalid');
  assert.equal(validateRecord({ outcome: 123 }), 'invalid');
});

test('validateRecord: converted requires an absolute output', () => {
  assert.equal(validateRecord({ outcome: 'converted' }), 'invalid');
  assert.equal(validateRecord({ outcome: 'converted', output: 'relative/path.mp4' }), 'invalid');
  assert.equal(validateRecord({ outcome: 'converted', output: 42 }), 'invalid');
  const abs = path.resolve('/out/clip.mp4');
  assert.deepEqual(validateRecord({ outcome: 'converted', output: abs }), {
    outcome: 'converted',
    output: abs,
    error: null,
    notes: [],
  });
});

test('validateRecord: rejects bad error and notes field types', () => {
  const abs = path.resolve('/out/clip.mp4');
  assert.equal(validateRecord({ outcome: 'failed', error: 42 }), 'invalid');
  assert.equal(validateRecord({ outcome: 'failed', notes: 'oops' }), 'invalid');
  assert.equal(validateRecord({ outcome: 'failed', notes: ['ok', 5] }), 'invalid');
  assert.deepEqual(validateRecord({ outcome: 'failed', error: null }), {
    outcome: 'failed',
    output: null,
    error: null,
    notes: [],
  });
  assert.deepEqual(validateRecord({ outcome: 'failed', error: 'boom', output: abs }), {
    outcome: 'failed',
    output: abs,
    error: 'boom',
    notes: [],
  });
});

test('validateRecord: notes keep only the first 10 entries, each cut to 2000 characters', () => {
  const notes = Array.from({ length: 15 }, (_, i) => (i === 0 ? 'x'.repeat(2500) : `n${i}`));
  const result = validateRecord({ outcome: 'skipped', notes });
  if (result === 'invalid' || result === null) throw new Error('expected a normalised record');
  assert.equal(result.notes.length, 10);
  assert.equal(result.notes[0].length, 2000);
  assert.equal(result.notes[0], 'x'.repeat(2000));
  assert.equal(result.notes[9], 'n9');
});

// --- createJsonLinesReader ---

test('createJsonLinesReader: parses records, skips empty lines, strips \\r, ignores no-outcome lines', () => {
  const reader = createJsonLinesReader();
  const payload = '{"outcome":"skipped"}\r\n\r\n{"summary":true}\n{"outcome":"unsupported"}\r\n';
  assert.equal(reader.push(Buffer.from(payload, 'utf8')), 'ok');
  assert.equal(reader.invalid, false);
  assert.deepEqual(reader.records.map((r) => r.outcome), ['skipped', 'unsupported']);
});

test('createJsonLinesReader: a bad JSON line marks invalid but keeps reading', () => {
  const reader = createJsonLinesReader();
  reader.push(Buffer.from('not-json\n{"outcome":"skipped"}\n', 'utf8'));
  assert.equal(reader.invalid, true);
  assert.deepEqual(reader.records.map((r) => r.outcome), ['skipped']);
});

test('createJsonLinesReader: end() finalises a trailing line with no newline', () => {
  const reader = createJsonLinesReader();
  reader.push(Buffer.from('{"outcome":"failed","error":"x"}', 'utf8'));
  assert.equal(reader.records.length, 0);
  reader.end();
  assert.deepEqual(reader.records.map((r) => r.outcome), ['failed']);
});

test('createJsonLinesReader: a multi-byte character split across two chunks decodes intact', () => {
  const text = 'café-🎬-end';
  const payload = `${JSON.stringify({ outcome: 'skipped', notes: [text] })}\n`;
  const buf = Buffer.from(payload, 'utf8');
  const markerIndex = payload.indexOf('🎬');
  const splitAt = Buffer.byteLength(payload.slice(0, markerIndex), 'utf8') + 2; // mid 4-byte emoji
  const reader = createJsonLinesReader();
  assert.equal(reader.push(buf.subarray(0, splitAt)), 'ok');
  assert.equal(reader.push(buf.subarray(splitAt)), 'ok');
  assert.equal(reader.records.length, 1);
  assert.equal(reader.records[0].notes[0], text);
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
