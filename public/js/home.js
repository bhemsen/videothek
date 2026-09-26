/**
 * Home page (`/`): "Start" heading, an initially-empty rows slot that a
 * later phase (P4) fills, and the "Willkommen" empty state shown only while
 * the rows slot has no children. No nav entry is active on this page.
 */
import { el, createEmptyState } from './lib/dom.js';
import { mountShell } from './lib/shell.js';

const { main } = mountShell({ active: null });

const rows = el('section', { class: 'home-rows', 'aria-label': 'Übersicht' });
const emptyState = createEmptyState({
  title: 'Willkommen',
  text: 'Wähle eine Kategorie, um loszulegen.',
});
emptyState.hidden = rows.children.length > 0;

main.append(el('h1', {}, 'Start'), rows, emptyState);
