// @ts-check

/**
 * Row and group builders for the admin "Konvertierung" panel
 * (`admin-conversions.js`): groups the flat `GET /api/conversions` list into
 * its five fixed sections and renders one row per entry. Pure DOM
 * construction only — no fetching, no polling; the panel owns those. See
 * docs/specs/archive/spec-conversion-core.md "UI behaviour" (Admin panel).
 */

import { el } from './lib/dom.js';
import { NAV_ENTRIES } from './lib/nav.js';
import { episodeLabel } from './lib/library-format.js';
import { failureReason, statusLabel } from './lib/conversion-format.js';

/** @typedef {import('./lib/conversions-api.js').ConversionEntry} ConversionEntry */
/** @typedef {import('./lib/conversions-api.js').ConversionStatus} ConversionStatus */

/**
 * @typedef {object} RowsCtx
 * @property {Set<string>} errorIds - itemIds whose last POST failed with an
 *   error the decorator's rules treat as "generic" (see conversion-format.js
 *   consumers); shows the fallback text instead of the row's own reason.
 * @property {(id: string) => void} onAction - invoked with the itemId when a
 *   retry/re-convert button is pressed.
 * @property {(id: string) => void} onCancel - invoked with the itemId when the
 *   "Abbrechen" button of a queued/running row is pressed.
 */

const MIDDLE_DOT = '·';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_FINISHED = 20;
const GENERIC_ERROR = 'Konvertieren nicht möglich. Bitte erneut versuchen.';

/** @type {readonly { status: ConversionStatus, heading: string }[]} */
const GROUPS = Object.freeze([
  { status: 'converting', heading: 'Läuft gerade' },
  { status: 'queued', heading: 'Warteschlange' },
  { status: 'failed', heading: 'Fehlgeschlagen' },
  { status: 'stale', heading: 'Veraltet – Quelle geändert' },
  { status: 'playable', heading: 'Fertig' },
]);

/**
 * Builds every non-empty group section, in the fixed order above (the
 * "Fertig" group keeps only its newest {@link MAX_FINISHED} entries; the
 * server already returns each group newest-first / FIFO-first, so no
 * re-sorting happens here).
 * @param {ConversionEntry[]} items
 * @param {RowsCtx} ctx
 * @returns {HTMLElement[]}
 */
export function buildGroups(items, ctx) {
  const byStatus = groupByStatus(items);
  /** @type {HTMLElement[]} */
  const sections = [];
  for (const { status, heading } of GROUPS) {
    const entries = byStatus.get(status) ?? [];
    const visible = status === 'playable' ? entries.slice(0, MAX_FINISHED) : entries;
    if (visible.length > 0) sections.push(buildGroupSection(status, heading, visible, ctx));
  }
  return sections;
}

/** @param {ConversionEntry[]} items @returns {Map<ConversionStatus, ConversionEntry[]>} */
function groupByStatus(items) {
  /** @type {Map<ConversionStatus, ConversionEntry[]>} */
  const map = new Map();
  for (const item of items) {
    const list = map.get(item.status) ?? [];
    list.push(item);
    map.set(item.status, list);
  }
  return map;
}

/**
 * @param {ConversionStatus} status @param {string} heading @param {ConversionEntry[]} entries @param {RowsCtx} ctx
 * @returns {HTMLElement}
 */
function buildGroupSection(status, heading, entries, ctx) {
  const list = el('div', { class: 'conversion-group__list' }, ...entries.map((entry) => buildRow(status, entry, ctx)));
  return el('section', { class: 'conversion-group' }, el('h3', { class: 'conversion-group__heading' }, heading), list);
}

/** @param {ConversionStatus} status @param {ConversionEntry} entry @param {RowsCtx} ctx @returns {HTMLElement} */
function buildRow(status, entry, ctx) {
  const main = el(
    'div',
    { class: 'conversion-row__main' },
    el('p', { class: 'conversion-row__title' }, rowTitle(entry.item)),
    el('p', { class: 'conversion-row__meta' }, rowMeta(entry.item)),
    ...notesFor(status, entry),
  );
  return el('div', { class: 'conversion-row' }, main, el('div', { class: 'conversion-row__status' }, buildStatus(status, entry, ctx)));
}

/** @param {{ seriesTitle: string | null, title: string, season: number | null, episode: number | null, episodeEnd: number | null }} item @returns {string} */
function rowTitle(item) {
  if (item.seriesTitle === null) return item.title;
  const label = episodeLabel({ title: item.title, season: item.season, episode: item.episode, episodeEnd: item.episodeEnd });
  return `${item.seriesTitle} ${MIDDLE_DOT} ${label}`;
}

/** @param {{ category: string, ext: string }} item @returns {string} */
function rowMeta(item) {
  return `${categoryLabel(item.category)} ${MIDDLE_DOT} ${item.ext.toUpperCase()}`;
}

/** @param {string} category @returns {string} */
function categoryLabel(category) {
  return NAV_ENTRIES.find((entry) => entry.id === category)?.label ?? category;
}

/** @param {ConversionStatus} status @param {ConversionEntry} entry @returns {HTMLElement[]} */
function notesFor(status, entry) {
  if (status !== 'playable') return [];
  return entry.notes.map((note) => el('p', { class: 'conversion-row__note' }, note));
}

/** @param {ConversionStatus} status @param {ConversionEntry} entry @param {RowsCtx} ctx @returns {HTMLElement} */
function buildStatus(status, entry, ctx) {
  if (status === 'converting' || status === 'queued') return buildActive(status, entry, ctx);
  if (status === 'playable') return el('span', { class: 'conversion-status-text conversion-status-text--done' }, checkIcon(), 'Konvertiert');
  const id = String(entry.itemId);
  const label = status === 'failed' ? 'Erneut versuchen' : 'Erneut konvertieren';
  return buildActionable(status, entry, ctx.errorIds.has(id), label, () => ctx.onAction(id));
}

/**
 * Status text plus the "Abbrechen" button of a queued/running row; while the
 * cancel is pending the text reads "Wird abgebrochen …" and the button stays disabled.
 * @param {ConversionStatus} status @param {ConversionEntry} entry @param {RowsCtx} ctx
 * @returns {HTMLElement}
 */
function buildActive(status, entry, ctx) {
  const text = status === 'converting'
    ? el('span', { class: 'conversion-status-text conversion-status-text--running' }, dot(), runningText(entry))
    : el('span', { class: 'conversion-status-text' }, entry.position !== null ? `Platz ${entry.position}` : '');
  const button = /** @type {HTMLButtonElement} */ (el('button', { type: 'button', class: 'btn btn-inline btn-danger' }, 'Abbrechen'));
  button.disabled = entry.cancelling;
  button.addEventListener('click', () => {
    button.disabled = true;
    ctx.onCancel(String(entry.itemId));
  });
  return el('div', { class: 'conversion-active' }, text, button);
}

/** @param {ConversionEntry} entry @returns {string} */
function runningText(entry) {
  if (entry.cancelling) return statusLabel(entry);
  const elapsed = elapsedLabel(entry.startedAt);
  const base = statusLabel(entry);
  return elapsed === null ? base : `${base} ${MIDDLE_DOT} ${elapsed}`;
}

/** @param {string | null} startedAt @returns {string | null} */
function elapsedLabel(startedAt) {
  if (startedAt === null) return null;
  const mins = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 60000));
  return `seit ${mins} Min.`;
}

/**
 * The "Fehlgeschlagen"/"Veraltet" row's right side: a reason (failed only,
 * or the generic fallback after an "other" POST error) plus the retry
 * button, shown only while `entry.convertible` (spec "UI behaviour").
 * @param {ConversionStatus} status @param {ConversionEntry} entry @param {boolean} hasError @param {string} label @param {() => void} onClick
 * @returns {HTMLElement}
 */
function buildActionable(status, entry, hasError, label, onClick) {
  const reason = hasError ? GENERIC_ERROR : status === 'failed' ? failureReason(entry.error) : null;
  const children = reason === null ? [] : [el('span', { class: 'conversion-fail__reason' }, reason)];
  if (entry.convertible) children.push(actionButton(label, onClick));
  return el('div', { class: 'conversion-fail' }, ...children);
}

/** @param {string} label @param {() => void} onClick @returns {HTMLButtonElement} */
function actionButton(label, onClick) {
  const button = /** @type {HTMLButtonElement} */ (el('button', { type: 'button', class: 'btn btn-secondary btn-inline' }, label));
  button.addEventListener('click', () => {
    button.disabled = true;
    onClick();
  });
  return button;
}

/** @returns {HTMLElement} */
function dot() {
  return el('span', { class: 'conversion-dot', 'aria-hidden': 'true' });
}

/** A 12x12 checkmark, decorative (the "Konvertiert" text already says it). @returns {SVGSVGElement} */
function checkIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const polyline = document.createElementNS(SVG_NS, 'polyline');
  polyline.setAttribute('points', '2 6 5 9 10 3');
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', 'currentColor');
  polyline.setAttribute('stroke-width', '2');
  polyline.setAttribute('stroke-linecap', 'round');
  polyline.setAttribute('stroke-linejoin', 'round');
  svg.append(polyline);
  return svg;
}

export { GENERIC_ERROR };
