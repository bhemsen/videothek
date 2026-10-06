// @ts-check

/**
 * Admin "Konvertierung" panel: `mountConversionPanel(container)` appends the
 * section, loads `GET /api/conversions` (no `ids` — every visible row,
 * grouped), renders the usage line and the five status groups via
 * `admin-conversions-rows.js`, and polls every 5 s while something is
 * `queued`/`converting` and the tab is visible (`convert-poller.js`, the
 * same generic poller `convert-control.js` uses). Mounted by `admin.js`
 * after its user list. See docs/specs/archive/spec-conversion-core.md
 * "UI behaviour" (Admin panel).
 */

import { el } from './lib/dom.js';
import { injectStylesheet } from './lib/stylesheet.js';
import { listConversions, requestConversion, cancelConversion } from './lib/conversions-api.js';
import { ApiError } from './lib/api.js';
import { formatFileSize, pluralize } from './lib/library-format.js';
import { startPolling, stopPolling } from './lib/convert-poller.js';
import { buildGroups } from './admin-conversions-rows.js';

/** @typedef {import('./lib/conversions-api.js').ConversionEntry} ConversionEntry */
/** @typedef {import('./lib/conversions-api.js').ConversionUsage} ConversionUsage */

const STYLESHEET_HREF = '/css/admin-conversions.css';
const ACTIVE_STATUSES = new Set(['queued', 'converting']);
const DISABLED_TEXT = 'Konvertierung ist nicht eingerichtet (CONVERTER_CMD fehlt).';
const EMPTY_TEXT = 'Keine Konvertierungen.';
const LOAD_ERROR_TEXT = 'Status konnte nicht geladen werden.';

/**
 * Mounts the panel into `container` (appended as its last child) and starts
 * loading. Never throws — a failed load renders {@link LOAD_ERROR_TEXT}.
 * @param {Element} container
 * @returns {void}
 */
export function mountConversionPanel(container) {
  injectStylesheet(STYLESHEET_HREF);
  const body = el('div', { class: 'conversion-panel__body' });
  container.append(el('section', { class: 'conversion-panel' }, el('h2', {}, 'Konvertierung'), body));

  /** @type {Map<string, ConversionEntry>} */
  let byId = new Map();
  /** @type {Set<string>} */
  const errorIds = new Set();
  /** @type {ConversionUsage} */
  let usage = { bytes: 0, count: 0, freeBytes: null };
  let enabled = true;
  let loadError = false;

  render();
  void initialLoad();

  /** @returns {Promise<void>} */
  async function initialLoad() {
    try {
      await refresh();
      loadError = false;
    } catch {
      loadError = true;
    }
    render();
    refreshPolling();
  }

  /** @returns {Promise<void>} */
  async function refresh() {
    const result = await listConversions();
    enabled = result.enabled;
    usage = result.usage;
    byId = new Map(result.items.map((item) => [String(item.itemId), item]));
    errorIds.clear();
  }

  /** A poll round: on a non-auth error the previous render is left as is and polling keeps retrying. @returns {Promise<boolean>} */
  async function tick() {
    try {
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return false;
      return true;
    }
    render();
    return [...byId.values()].some((entry) => ACTIVE_STATUSES.has(entry.status));
  }

  /** @returns {void} */
  function refreshPolling() {
    const active = !loadError && [...byId.values()].some((entry) => ACTIVE_STATUSES.has(entry.status));
    if (active) startPolling(body, tick);
    else stopPolling(body);
  }

  /** @param {string} id @returns {Promise<void>} */
  async function act(id) {
    errorIds.delete(id);
    try {
      byId.set(id, await requestConversion(id));
    } catch (err) {
      applyActionError(id, err, byId, errorIds);
    }
    render();
    refreshPolling();
  }

  /** Cancels a queued/running row, then reloads the list (a 409 etc. simply shows the real state). @param {string} id @returns {Promise<void>} */
  async function cancel(id) {
    try {
      await cancelConversion(id);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return;
    }
    try {
      await refresh();
    } catch {
      // keep the previous render; the poller (if running) retries
    }
    render();
    refreshPolling();
  }

  /** @returns {void} */
  function render() {
    body.replaceChildren(...renderBody({ enabled, loadError, usage, items: [...byId.values()], errorIds, onAction: act, onCancel: cancel }));
  }
}

/**
 * @param {{ enabled: boolean, loadError: boolean, usage: ConversionUsage, items: ConversionEntry[], errorIds: Set<string>, onAction: (id: string) => void, onCancel: (id: string) => void }} state
 * @returns {HTMLElement[]}
 */
function renderBody(state) {
  if (state.loadError) return [el('p', { class: 'conversion-error' }, LOAD_ERROR_TEXT)];
  if (!state.enabled) {
    const nodes = [el('p', { class: 'conversion-disabled' }, DISABLED_TEXT)];
    if (state.usage.count > 0) nodes.push(usageLine(state.usage));
    return nodes;
  }
  if (state.items.length === 0) return [el('p', { class: 'conversion-empty' }, EMPTY_TEXT)];
  return [usageLine(state.usage), ...buildGroups(state.items, { errorIds: state.errorIds, onAction: state.onAction, onCancel: state.onCancel })];
}

/**
 * `409 already_playable` → the row becomes `playable` (another admin was
 * faster); `400`/`404`/`503` → the row is dropped; anything else → kept as
 * is, marked for the generic-error text (spec "UI behaviour", the
 * decorator's POST error rules).
 * @param {string} id @param {unknown} err @param {Map<string, ConversionEntry>} byId @param {Set<string>} errorIds
 * @returns {void}
 */
function applyActionError(id, err, byId, errorIds) {
  const status = err instanceof ApiError ? err.status : 0;
  if (status === 409) {
    const prev = byId.get(id);
    if (prev) byId.set(id, { ...prev, status: 'playable', position: null, error: null, convertible: true });
    return;
  }
  if (status === 400 || status === 404 || status === 503) {
    byId.delete(id);
    return;
  }
  errorIds.add(id);
}

/** @param {ConversionUsage} usage @returns {HTMLElement} */
function usageLine(usage) {
  const files = pluralize(usage.count, 'Datei', 'Dateien');
  const free = usage.freeBytes === null ? '' : ` · ${formatFileSize(usage.freeBytes)} frei`;
  return el('p', { class: 'conversion-usage' }, `Kopien: ${formatFileSize(usage.bytes)} in ${files}${free}`);
}
