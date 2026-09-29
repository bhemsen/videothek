import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusLabel, failureReason, FAILURE_REASONS } from '../../public/js/lib/conversion-format.js';

/**
 * @param {Partial<import('../../public/js/lib/conversions-api.js').ConversionEntry>} overrides
 * @returns {Pick<import('../../public/js/lib/conversions-api.js').ConversionEntry, 'status' | 'position' | 'error'>}
 */
function entry(overrides = {}) {
  return { status: 'none', position: null, error: null, ...overrides };
}

test('statusLabel: none has no queue/error info', () => {
  assert.equal(statusLabel(entry({ status: 'none' })), 'Nicht konvertiert');
});

test('statusLabel: stale (a fresh copy whose source has since changed)', () => {
  assert.equal(statusLabel(entry({ status: 'stale' })), 'Veraltet');
});

test('statusLabel: queued includes the 1-based FIFO position', () => {
  assert.equal(statusLabel(entry({ status: 'queued', position: 1 })), 'In Warteschlange · Platz 1');
  assert.equal(statusLabel(entry({ status: 'queued', position: 2 })), 'In Warteschlange · Platz 2');
});

test('statusLabel: queued with no position falls back to the plain label', () => {
  assert.equal(statusLabel(entry({ status: 'queued', position: null })), 'In Warteschlange');
});

test('statusLabel: converting is the one running job', () => {
  assert.equal(statusLabel(entry({ status: 'converting' })), 'Wird konvertiert …');
});

test('statusLabel: playable is the verified, fresh copy', () => {
  assert.equal(statusLabel(entry({ status: 'playable' })), 'Konvertiert');
});

test('statusLabel: failed includes the German reason for the stored error code', () => {
  assert.equal(
    statusLabel(entry({ status: 'failed', error: 'converter_failed' })),
    'Konvertierung fehlgeschlagen: Der Konverter meldet einen Fehler'
  );
  assert.equal(
    statusLabel(entry({ status: 'failed', error: 'not_browser_safe' })),
    'Konvertierung fehlgeschlagen: Ergebnis ist im Browser nicht abspielbar'
  );
});

test('failureReason: exact German text for every failure code in the spec table', () => {
  assert.equal(failureReason('converter_unavailable'), 'Konverter nicht erreichbar');
  assert.equal(failureReason('converter_failed'), 'Der Konverter meldet einen Fehler');
  assert.equal(failureReason('converter_output_invalid'), 'Unerwartete Antwort des Konverters');
  assert.equal(failureReason('unsupported_source'), 'Format wird vom Konverter nicht unterstützt');
  assert.equal(failureReason('not_browser_safe'), 'Ergebnis ist im Browser nicht abspielbar');
  assert.equal(failureReason('source_missing'), 'Quelldatei nicht gefunden');
  assert.equal(failureReason('source_changed'), 'Quelldatei hat sich während der Konvertierung geändert');
  assert.equal(failureReason('storage_failed'), 'Kopie konnte nicht gespeichert werden');
  assert.equal(failureReason('internal'), 'Interner Fehler');
});

test('failureReason: converter_interrupted and the interrupted alias both read "Abgebrochen"', () => {
  assert.equal(failureReason('converter_interrupted'), 'Abgebrochen');
  assert.equal(failureReason('interrupted'), 'Abgebrochen');
});

test('failureReason: an unknown code and null fall back to a generic reason', () => {
  assert.equal(failureReason('something_new'), 'Unbekannter Fehler');
  assert.equal(failureReason(null), 'Unbekannter Fehler');
});

test('FAILURE_REASONS is frozen and covers every documented failure code', () => {
  assert.ok(Object.isFrozen(FAILURE_REASONS));
  assert.deepEqual(Object.keys(FAILURE_REASONS).sort(), [
    'converter_failed',
    'converter_interrupted',
    'converter_output_invalid',
    'converter_unavailable',
    'internal',
    'interrupted',
    'not_browser_safe',
    'source_changed',
    'source_missing',
    'storage_failed',
    'unsupported_source',
  ]);
});
