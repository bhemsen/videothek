/**
 * Home page (`/`): "Start" heading, three fixed row slots in order —
 * "Weiterschauen" (continue-row.js), "Weiterhören" (listen-row.js), the
 * category previews (category-previews.js) — and the "Willkommen" empty
 * state, shown only while every slot is empty. Fixed slots keep the order
 * stable whichever request settles first. See
 * docs/specs/spec-progress-resume.md "UI behaviour" and docs/architecture.md.
 */
import { el, createEmptyState } from './lib/dom.js';
import { mountShell } from './lib/shell.js';
import { mountContinueRow } from './lib/continue-row.js';
import { mountListenRow } from './lib/listen-row.js';
import { mountCategoryPreviews } from './lib/category-previews.js';

const { main } = mountShell({ active: null });

const heading = el('h1', { class: 'shell-title', tabindex: '-1' }, 'Start');
const continueSlot = el('div', { class: 'home-rows__slot', dataset: { slot: 'continue' } });
const listenSlot = el('div', { class: 'home-rows__slot', dataset: { slot: 'listen' } });
const previewsSlot = el('div', { class: 'home-rows__slot', dataset: { slot: 'previews' } });
const slots = [continueSlot, listenSlot, previewsSlot];
const rows = el('section', { class: 'home-rows', 'aria-label': 'Übersicht' }, ...slots);
const emptyState = createEmptyState({ title: 'Willkommen', text: 'Wähle eine Kategorie, um loszulegen.' });

/** @returns {boolean} whether any slot currently holds a row */
const hasContent = () => slots.some((slot) => slot.childElementCount > 0);
// Hidden while loading: "Willkommen" must not flash before the rows arrive.
emptyState.hidden = true;
let settled = false;

main.append(heading, rows, emptyState);

// P1's rule, now per slot: once every mount has settled, a later "×"
// removal in "Weiterschauen" can empty its slot again (it removes its own
// section and focuses the H1) — that re-toggles the empty state.
const observer = new MutationObserver(() => {
  if (settled) emptyState.hidden = hasContent();
});
for (const slot of slots) observer.observe(slot, { childList: true });

Promise.allSettled([
  mountContinueRow(continueSlot),
  mountListenRow(listenSlot),
  mountCategoryPreviews(previewsSlot),
]).then(() => {
  settled = true;
  emptyState.hidden = hasContent();
});
