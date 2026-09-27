/**
 * Home page (`/`): "Start" heading, a rows slot, the "Willkommen" empty
 * state shown only while the slot has no children, and the "Weiterschauen"
 * row mounted into that slot. See
 * docs/specs/spec-progress-resume.md "UI behaviour".
 */
import { el, createEmptyState } from './lib/dom.js';
import { mountShell } from './lib/shell.js';
import { mountContinueRow } from './lib/continue-row.js';

const { main } = mountShell({ active: null });

const heading = el('h1', { tabindex: '-1' }, 'Start');
const rows = el('section', { class: 'home-rows', 'aria-label': 'Übersicht' });
const emptyState = createEmptyState({
  title: 'Willkommen',
  text: 'Wähle eine Kategorie, um loszulegen.',
});
emptyState.hidden = rows.children.length > 0;

main.append(heading, rows, emptyState);

// P1's rule (hidden whenever the slot has at least one child) applied
// reactively: mountContinueRow fills the slot asynchronously, and a later
// "×" removal can empty it again — both must re-toggle the empty state.
new MutationObserver(() => {
  emptyState.hidden = rows.children.length > 0;
}).observe(rows, { childList: true });

mountContinueRow(rows);
