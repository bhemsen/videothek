import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountCountLabel, formatCreatedDate } from '../../public/js/admin-format.js';

test('accountCountLabel uses the singular only for exactly one account', () => {
  assert.equal(accountCountLabel(1), '1 Konto');
  assert.equal(accountCountLabel(0), '0 Konten');
  assert.equal(accountCountLabel(2), '2 Konten');
  assert.equal(accountCountLabel(12), '12 Konten');
});

// Noon UTC keeps the calendar day stable in every real-world time zone.
test('formatCreatedDate zero-pads day and month (dd.mm.yyyy)', () => {
  assert.equal(formatCreatedDate('2026-09-05T12:00:00.000Z'), '05.09.2026');
  assert.equal(formatCreatedDate('2026-01-01T12:00:00.000Z'), '01.01.2026');
});

test('formatCreatedDate keeps two-digit day and month unchanged', () => {
  assert.equal(formatCreatedDate('2026-12-31T12:00:00.000Z'), '31.12.2026');
  assert.equal(formatCreatedDate('2026-09-26T12:00:00.000Z'), '26.09.2026');
});
