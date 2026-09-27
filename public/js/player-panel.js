/**
 * Loading placeholder and error/empty-state panel for the video player page
 * — one DOM builder per row of the state table in
 * docs/specs/spec-video-streaming.md "Design". No item/API knowledge: every
 * piece of text this module cannot derive itself (the file extension, the
 * "Nächste Folge" label) is passed in by `public/js/player.js`.
 */

import { el } from './lib/dom.js';
import { filmOffIcon, banIcon, skipIcon } from './player-icons.js';

/** @typedef {'not-found' | 'load-failed' | 'not-playable' | 'file-missing' | 'codec' | 'connection-lost'} PanelState */

/**
 * @typedef {object} PanelCopy
 * @property {boolean} badge - Shows the "Nicht abspielbar" pill above the heading.
 * @property {string} heading
 * @property {string | null} body - `null` for `'not-playable'`, whose body needs the file extension (built in {@link buildBody}).
 * @property {'retry' | 'next' | null} secondaryAction
 */

/** @type {Record<PanelState, PanelCopy>} */
const PANEL_COPY = {
  'not-found': {
    badge: false,
    heading: 'Titel nicht gefunden',
    body: 'Dieser Titel ist nicht (mehr) in der Bibliothek.',
    secondaryAction: null,
  },
  'load-failed': {
    badge: false,
    heading: 'Titel konnte nicht geladen werden',
    body: 'Bitte prüfe die Verbindung und versuche es erneut.',
    secondaryAction: 'retry',
  },
  'not-playable': {
    badge: true,
    heading: 'Dieses Video kann nicht abgespielt werden',
    body: null,
    secondaryAction: 'next',
  },
  'file-missing': {
    badge: false,
    heading: 'Datei nicht gefunden',
    body: 'Die Datei wurde verschoben oder gelöscht. Die Bibliothek aktualisiert sich automatisch.',
    secondaryAction: 'retry',
  },
  codec: {
    badge: true,
    heading: 'Wiedergabe nicht möglich',
    body: 'Der Browser kann diese Datei nicht wiedergeben – vermutlich ein nicht unterstützter Codec (z. B. HEVC).',
    secondaryAction: 'next',
  },
  'connection-lost': {
    badge: false,
    heading: 'Verbindung unterbrochen',
    body: 'Die Übertragung wurde unterbrochen.',
    secondaryAction: 'retry',
  },
};

/**
 * Builds the muted "Lädt …" placeholder shown before any item or panel
 * exists (state table row "Loading").
 * @returns {HTMLElement}
 */
export function buildLoadingNode() {
  return el('p', { class: 'player-loading' }, 'Lädt …');
}

/**
 * The "Nicht abspielbar" pill badge (ban icon + German text).
 * @returns {HTMLElement}
 */
function buildBadge() {
  return el('span', { class: 'player-badge' }, banIcon(), 'Nicht abspielbar');
}

/**
 * Resolves the panel body text, substituting the upper-cased file extension
 * into the `'not-playable'` copy (the only state whose body is dynamic).
 * @param {PanelState} state
 * @param {string | undefined} ext
 * @returns {string}
 */
function buildBody(state, ext) {
  const copy = PANEL_COPY[state];
  if (copy.body !== null) return copy.body;
  return `Das Format ${ext} kann der Browser nicht direkt wiedergeben. Die Datei bleibt unverändert in der Bibliothek.`;
}

/**
 * Builds the state's secondary action button (after the primary "Zurück zur
 * Übersicht"), or `null` when the state has none — including a `'next'`
 * state with no next episode, per the state table's "if `next`" qualifier.
 * @param {PanelCopy} copy
 * @param {string | null | undefined} nextLabel
 * @param {(() => void) | undefined} onRetry
 * @param {(() => void) | undefined} onNext
 * @returns {HTMLElement | null}
 */
function buildSecondaryAction(copy, nextLabel, onRetry, onNext) {
  if (copy.secondaryAction === 'retry') {
    return el('button', { type: 'button', class: 'btn btn-secondary', onClick: onRetry }, 'Erneut versuchen');
  }
  if (copy.secondaryAction === 'next' && nextLabel != null) {
    return el('button', { type: 'button', class: 'btn btn-secondary', onClick: onNext }, skipIcon(), nextLabel);
  }
  return null;
}

/**
 * @typedef {object} ErrorPanelConfig
 * @property {PanelState} state
 * @property {boolean} hasItem - Whether an item is loaded: decides the
 *   heading's tag (`h1` when `false` — the page has no other heading yet —
 *   `h2` when `true`, since the title block already carries the page's `h1`).
 * @property {string} [ext] - Required for `'not-playable'` (upper-cased extension).
 * @property {string | null} [nextLabel] - "Nächste Folge: …" label from `nextLabel()`, or `null`.
 * @property {() => void} onBack
 * @property {() => void} [onRetry]
 * @property {() => void} [onNext]
 */

/**
 * Builds the centred error/empty-state panel for one state (spec "Design"
 * state table): destructive icon, optional badge, heading, body, actions
 * (primary "Zurück zur Übersicht" first, then the state's secondary action).
 * The caller focuses `focusTarget` once the panel is in the document (spec:
 * "the primary action receives focus on render").
 * @param {ErrorPanelConfig} config
 * @returns {{ node: HTMLElement, focusTarget: HTMLElement, heading: string }}
 */
export function buildErrorPanel({ state, hasItem, ext, nextLabel, onBack, onRetry, onNext }) {
  const copy = PANEL_COPY[state];
  const headingEl = el(hasItem ? 'h2' : 'h1', { class: 'player-panel__heading' }, copy.heading);
  const backButton = /** @type {HTMLButtonElement} */ (
    el('button', { type: 'button', class: 'btn btn-primary', onClick: onBack }, 'Zurück zur Übersicht')
  );
  const secondary = buildSecondaryAction(copy, nextLabel, onRetry, onNext);
  const node = el(
    'div',
    { class: 'player-panel' },
    filmOffIcon(),
    copy.badge ? buildBadge() : null,
    headingEl,
    el('p', { class: 'player-panel__body' }, buildBody(state, ext)),
    el('div', { class: 'player-panel__actions' }, backButton, secondary),
  );
  return { node, focusTarget: backButton, heading: copy.heading };
}
