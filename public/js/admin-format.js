/**
 * DOM-free formatting helpers for the admin page (unit-tested in
 * `test/public/admin-format.test.js`).
 */

/**
 * The muted subline under the heading: "1 Konto" / "{n} Konten".
 * @param {number} count
 * @returns {string}
 */
export function accountCountLabel(count) {
  return count === 1 ? '1 Konto' : `${count} Konten`;
}

/**
 * Formats an ISO timestamp as a zero-padded German date (`dd.mm.yyyy`).
 * Plain `toLocaleDateString('de-DE')` drops the padding ("5.9.2026").
 * @param {string} isoDate
 * @returns {string}
 */
export function formatCreatedDate(isoDate) {
  return new Date(isoDate).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}
