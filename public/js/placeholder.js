/**
 * Category placeholder page: heading = the category label, "Noch nicht
 * verfügbar" empty state. Retired by the phase that replaces
 * `<body data-category>`'s page file with real category content.
 */
import { el, createEmptyState } from './lib/dom.js';
import { mountShell } from './lib/shell.js';
import { NAV_ENTRIES } from './lib/nav.js';

const category = document.body.dataset.category ?? null;
const entry = NAV_ENTRIES.find((candidate) => candidate.id === category) ?? null;
const { main } = mountShell({ active: category });

main.append(
  el('h1', {}, entry ? entry.label : ''),
  createEmptyState({
    title: 'Noch nicht verfügbar',
    text: 'Diese Kategorie wird in einer späteren Version freigeschaltet.',
  }),
);
