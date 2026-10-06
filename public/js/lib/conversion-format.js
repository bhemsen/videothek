// @ts-check

/**
 * Pure formatting helpers for conversion status and failure reasons — no DOM
 * access, no I/O. Consumed by the conversion control decorator and the admin
 * panel (later issues) to render a `ConversionEntry` as German text. See
 * docs/specs/archive/spec-conversion-core.md "Failure codes and German reasons" and
 * "UI behaviour".
 */

/** @typedef {import('./conversions-api.js').ConversionEntry} ConversionEntry */

/**
 * German reason for a conversion's stored `error` code
 * (spec-conversion-core.md "Failure codes and German reasons"). `interrupted`
 * is a historical alias of `converter_interrupted`; both read the same.
 * @type {Readonly<Record<string, string>>}
 */
export const FAILURE_REASONS = Object.freeze({
  converter_unavailable: 'Konverter nicht erreichbar',
  converter_failed: 'Der Konverter meldet einen Fehler',
  converter_interrupted: 'Abgebrochen',
  interrupted: 'Abgebrochen',
  cancelled: 'Vom Admin abgebrochen',
  converter_output_invalid: 'Unerwartete Antwort des Konverters',
  unsupported_source: 'Format wird vom Konverter nicht unterstützt',
  not_browser_safe: 'Ergebnis ist im Browser nicht abspielbar',
  source_missing: 'Quelldatei nicht gefunden',
  source_changed: 'Quelldatei hat sich während der Konvertierung geändert',
  storage_failed: 'Kopie konnte nicht gespeichert werden',
  internal: 'Interner Fehler',
});

/** Shown for an `error` code not in {@link FAILURE_REASONS} (defensive; every code the server writes is covered). */
const FALLBACK_REASON = 'Unbekannter Fehler';

/**
 * The German reason for a stored failure `error` code.
 * @param {string | null} error
 * @returns {string}
 */
export function failureReason(error) {
  if (error === null) return FALLBACK_REASON;
  return FAILURE_REASONS[error] ?? FALLBACK_REASON;
}

/**
 * The status text for one conversion entry (spec-conversion-core.md "UI
 * behaviour"): the queue position for `queued`, the failure reason for
 * `failed` (for `cancelled` the reason alone, no prefix), fixed German text for `converting`/`playable`, and a plain label
 * for `none`/`stale` (shown next to their "Konvertieren" button — the spec
 * fixes no separate status wording for them).
 * @param {Pick<ConversionEntry, 'status' | 'position' | 'error'> & { cancelling?: boolean }} entry
 * @returns {string}
 */
export function statusLabel(entry) {
  if (entry.status === 'none') return 'Nicht konvertiert';
  if (entry.status === 'stale') return 'Veraltet';
  if (entry.status === 'converting') return entry.cancelling === true ? 'Wird abgebrochen …' : 'Wird konvertiert …';
  if (entry.status === 'playable') return 'Konvertiert';
  if (entry.status === 'failed' && entry.error === 'cancelled') return failureReason(entry.error);
  if (entry.status === 'failed') return `Konvertierung fehlgeschlagen: ${failureReason(entry.error)}`;
  return entry.position === null ? 'In Warteschlange' : `In Warteschlange · Platz ${entry.position}`;
}
