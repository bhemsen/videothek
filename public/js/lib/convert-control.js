// @ts-check

/**
 * Admin-only "Konvertieren" control decorator: renders the per-item
 * conversion control on not-playable movie cards, episode rows, album track
 * rows and audiobook file rows, wires its POST retries and (re)starts a
 * per-root poller (`convert-poller.js`) while something is
 * `queued`/`converting`. See docs/specs/archive/spec-conversion-core.md
 * "UI behaviour"; precedent: `progress-badges.js`'s grid decoration.
 */

import { el } from './dom.js';
import { injectStylesheet } from './stylesheet.js';
import { listConversions, requestConversion } from './conversions-api.js';
import { ApiError } from './api.js';
import { statusLabel } from './conversion-format.js';
import { startPolling, stopPolling } from './convert-poller.js';

/** @typedef {import('./conversions-api.js').ConversionEntry} ConversionEntry */
/** @typedef {Pick<ConversionEntry, 'status' | 'position' | 'error' | 'convertible'>} EntryLike */
/** @typedef {{ root: Element, hosts: Element[], byId: Map<string, EntryLike>, controls: Map<string, HTMLElement> }} Ctx */

const STYLESHEET_HREF = '/css/convert-control.css';
const CONTROL_ATTR = 'data-convert-control';
const BATCH_SIZE = 500;
const ACTIVE_STATUSES = new Set(['queued', 'converting']);
const SHOWN_REGARDLESS = new Set(['queued', 'converting', 'playable']);
const GENERIC_ERROR = 'Konvertieren nicht möglich. Bitte erneut versuchen.';

/**
 * Per-root race guards. `generations`: every `decorateConversionsFor(root)`
 * call bumps it, so an initial fetch that settles after a newer call for the
 * same root is dropped (no out-of-order render). `owners`: the context whose
 * controls are currently in the DOM; a poll or POST response of any other
 * (superseded) context is dropped instead of adding a second control or
 * re-arming the poller for stale data.
 * @type {WeakMap<Element, number>}
 */
const generations = new WeakMap();
/** @type {WeakMap<Element, Ctx>} */
const owners = new WeakMap();

/**
 * Decorates every not-playable host under `root` with its conversion
 * control, idempotently (earlier `data-convert-control` nodes are removed
 * first), and (re)starts the 5 s poller while something is
 * `queued`/`converting`. A `403` (non-admin), `enabled: false` or any fetch
 * error leaves the page untouched; with no matching host there is no
 * request, and the stylesheet is only injected once controls will render.
 * Re-decorating the same root always cancels its previous poller; once the
 * new decoration renders, the previous one's in-flight responses are dropped.
 * @param {Element} root
 * @returns {Promise<void>}
 */
export async function decorateConversionsFor(root) {
  stopPolling(root);
  const gen = (generations.get(root) ?? 0) + 1;
  generations.set(root, gen);
  const hosts = collectHosts(root);
  if (hosts.length === 0) return;
  let fetched;
  try {
    fetched = await fetchEntries(hosts.map(hostId));
  } catch {
    return;
  }
  if (generations.get(root) !== gen || !fetched.enabled) return;
  injectStylesheet(STYLESHEET_HREF);
  clearControls(root);
  /** @type {Ctx} */
  const ctx = { root, hosts, byId: byIdMap(fetched.items), controls: new Map() };
  owners.set(root, ctx);
  for (const host of hosts) render(ctx, host, hostId(host));
  refreshPolling(ctx);
}

/** @param {Ctx} ctx @returns {boolean} whether `ctx`'s controls are still the ones in the DOM */
function isCurrent(ctx) {
  return owners.get(ctx.root) === ctx;
}

/** @param {ConversionEntry[]} items @returns {Map<string, EntryLike>} */
function byIdMap(items) {
  return new Map(items.map((item) => [String(item.itemId), item]));
}

/** @param {Element} root @returns {Element[]} */
function collectHosts(root) {
  return [...root.querySelectorAll('[data-item-id]')].filter(isHost);
}

/**
 * `div.media-card` / `div.episode-row` (unplayable ones only — playable
 * cards/rows are links, never divs) or `.track-row--unplayable` /
 * `.file-row--unplayable` (any tag).
 * @param {Element} node
 * @returns {boolean}
 */
function isHost(node) {
  const classes = (node.getAttribute('class') ?? '').split(/\s+/);
  if (node.tagName === 'DIV' && (classes.includes('media-card') || classes.includes('episode-row'))) return true;
  return classes.includes('track-row--unplayable') || classes.includes('file-row--unplayable');
}

/** @param {Element} host @returns {string} */
function hostId(host) {
  return /** @type {HTMLElement} */ (host).dataset.itemId ?? '';
}

/** @param {Element} root @returns {void} */
function clearControls(root) {
  for (const node of root.querySelectorAll(`[${CONTROL_ATTR}]`)) node.remove();
}

/**
 * Fetches `listConversions` in batches of ≤ {@link BATCH_SIZE}, merging the
 * results (`enabled` is the same server-wide flag on every batch).
 * @param {string[]} ids
 * @returns {Promise<{ enabled: boolean, items: ConversionEntry[] }>}
 */
async function fetchEntries(ids) {
  const batches = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) batches.push(ids.slice(i, i + BATCH_SIZE));
  const results = await Promise.all(batches.map((batch) => listConversions({ ids: batch })));
  return { enabled: results[0]?.enabled ?? true, items: results.flatMap((result) => result.items) };
}

/** @param {Ctx} ctx @returns {void} */
function refreshPolling(ctx) {
  const active = [...ctx.byId.values()].some((entry) => ACTIVE_STATUSES.has(entry.status));
  if (active) startPolling(ctx.root, () => tick(ctx));
  else stopPolling(ctx.root);
}

/**
 * One poll round: re-fetches every host's entry and re-renders it. `401`/
 * `403` stop the poller for good (returns `false`); any other fetch error is
 * rethrown so `convert-poller.js` keeps its interval and retries.
 * @param {Ctx} ctx
 * @returns {Promise<boolean>}
 */
async function tick(ctx) {
  let fetched;
  try {
    fetched = await fetchEntries(ctx.hosts.map(hostId));
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return false;
    throw err;
  }
  if (!isCurrent(ctx)) return false;
  for (const item of fetched.items) ctx.byId.set(String(item.itemId), item);
  for (const host of ctx.hosts) render(ctx, host, hostId(host));
  return [...ctx.byId.values()].some((entry) => ACTIVE_STATUSES.has(entry.status));
}

/** @param {Ctx} ctx @param {Element} host @param {string} id @returns {void} */
function render(ctx, host, id) {
  const entry = ctx.byId.get(id);
  setControl(ctx, host, id, entry ? buildControl(ctx, host, id, entry) : null);
}

/** @param {Ctx} ctx @param {Element} host @param {string} id @param {HTMLElement | null} node @returns {void} */
function setControl(ctx, host, id, node) {
  ctx.controls.get(id)?.remove();
  if (node === null) {
    ctx.controls.delete(id);
    return;
  }
  host.append(node);
  ctx.controls.set(id, node);
}

/**
 * Builds `.convert-control` per the status table (spec "UI behaviour"), or
 * `null` when the entry warrants no control at all.
 * @param {Ctx} ctx @param {Element} host @param {string} id @param {EntryLike} entry
 * @returns {HTMLElement | null}
 */
function buildControl(ctx, host, id, entry) {
  if (!entry.convertible && !SHOWN_REGARDLESS.has(entry.status)) return null;
  const container = el('div', { class: 'convert-control', dataset: { convertControl: 'true' } });
  if (entry.status === 'none' || entry.status === 'stale') {
    container.append(actionButton('Konvertieren', () => act(ctx, host, id, 'Konvertieren')));
  } else if (entry.status === 'failed') {
    container.append(statusText(entry), actionButton('Erneut versuchen', () => act(ctx, host, id, 'Erneut versuchen')));
  } else if (entry.status === 'playable') {
    container.append(statusText(entry), actionButton('Neu laden', () => location.reload()));
  } else if (ACTIVE_STATUSES.has(entry.status)) {
    container.append(statusText(entry));
  } else {
    return null;
  }
  return container;
}

/** @param {EntryLike} entry @returns {HTMLElement} */
function statusText(entry) {
  return el('span', { class: ['status-text', entry.status === 'failed' && 'is-error'], role: 'status' }, statusLabel(entry));
}

/**
 * A `.btn.btn-secondary` whose click never reaches the host and disables the
 * button synchronously (before `onClick`'s own await, if any).
 * @param {string} label @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function actionButton(label, onClick) {
  const button = /** @type {HTMLButtonElement} */ (el('button', { type: 'button', class: 'btn btn-secondary' }, label));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    button.disabled = true;
    onClick();
  });
  return button;
}

/**
 * A button click's POST: success re-renders from the returned entry; the
 * POST error mapping is fixed by the spec. A response for a root that was
 * re-decorated meanwhile is dropped (the newer context owns the DOM).
 * @param {Ctx} ctx @param {Element} host @param {string} id @param {string} label
 * @returns {Promise<void>}
 */
async function act(ctx, host, id, label) {
  /** @type {{ entry: ConversionEntry } | { err: unknown }} */
  let outcome;
  try {
    outcome = { entry: await requestConversion(id) };
  } catch (err) {
    outcome = { err };
  }
  if (!isCurrent(ctx)) return;
  if ('entry' in outcome) {
    ctx.byId.set(id, outcome.entry);
    render(ctx, host, id);
  } else {
    applyPostError(ctx, host, id, label, outcome.err);
  }
  refreshPolling(ctx);
}

/**
 * `409 already_playable` → the `playable` control; `400`/`404`/`503` → the
 * control is removed; anything else → the generic retry text, button
 * enabled again (same label as before the click).
 * @param {Ctx} ctx @param {Element} host @param {string} id @param {string} label @param {unknown} err
 * @returns {void}
 */
function applyPostError(ctx, host, id, label, err) {
  const status = err instanceof ApiError ? err.status : 0;
  if (status === 409) {
    ctx.byId.set(id, { status: 'playable', position: null, error: null, convertible: true });
    render(ctx, host, id);
    return;
  }
  if (status === 400 || status === 404 || status === 503) {
    ctx.byId.delete(id);
    setControl(ctx, host, id, null);
    return;
  }
  setControl(ctx, host, id, errorControl(label, () => act(ctx, host, id, label)));
}

/** @param {string} label @param {() => void} onClick @returns {HTMLElement} */
function errorControl(label, onClick) {
  const container = el('div', { class: 'convert-control', dataset: { convertControl: 'true' } });
  container.append(el('span', { class: 'status-text is-error', role: 'status' }, GENERIC_ERROR), actionButton(label, onClick));
  return container;
}
