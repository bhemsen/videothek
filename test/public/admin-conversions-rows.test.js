import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Node, setup, entry, click } from '../helpers/convert-control-fakes.js';
import { buildGroups } from '../../public/js/admin-conversions-rows.js';

/**
 * "Abbrechen" on the admin panel's queued/running rows (#264). DOM fakes:
 * `test/helpers/convert-control-fakes.js`.
 */

const ITEM = { title: 'Metropolis', seriesTitle: null, category: 'movies', ext: 'mkv', season: null, episode: null, episodeEnd: null };

/** @param {Node} node @param {(n: Node) => boolean} test @returns {Node[]} */
function find(node, test) {
  const out = /** @type {Node[]} */ ([]);
  for (const c of node.children) if (c instanceof Node) { if (test(c)) out.push(c); out.push(...find(c, test)); }
  return out;
}

/** @param {object} overrides @returns {{ sections: Node[], cancelled: string[] }} */
function render(overrides) {
  setup();
  const cancelled = /** @type {string[]} */ ([]);
  const e = { ...entry(7, {}), item: ITEM, cancelling: false, ...overrides };
  const sections = buildGroups([/** @type {any} */ (e)], { errorIds: new Set(), onAction: () => {}, onCancel: (id) => cancelled.push(id) });
  return { sections: /** @type {Node[]} */ (/** @type {unknown} */ (sections)), cancelled };
}

/** @param {Node[]} sections @returns {Node[]} */
const dangerButtons = (sections) => sections.flatMap((s) => find(s, (n) => n.tagName === 'BUTTON' && (n.getAttribute('class') ?? '').includes('btn-danger')));

test('queued row: "Abbrechen" btn-danger; click disables it and reports the itemId', () => {
  const { sections, cancelled } = render({ status: 'queued', position: 2 });
  const [button] = dangerButtons(sections);
  assert.equal(button.textContent, 'Abbrechen');
  assert.equal(button.getAttribute('class'), 'btn btn-inline btn-danger');
  assert.equal(button.disabled, false);
  click(button);
  assert.equal(button.disabled, true);
  assert.deepEqual(cancelled, ['7']);
  assert.match(sections[0].textContent, /Platz 2/);
});

test('running row: button enabled; while cancelling it is disabled and the text reads "Wird abgebrochen …"', () => {
  const running = render({ status: 'converting', startedAt: new Date().toISOString() });
  assert.equal(dangerButtons(running.sections)[0].disabled, false);
  assert.match(running.sections[0].textContent, /Wird konvertiert …/);

  const cancelling = render({ status: 'converting', cancelling: true, startedAt: new Date().toISOString() });
  assert.equal(dangerButtons(cancelling.sections)[0].disabled, true);
  assert.match(cancelling.sections[0].textContent, /Wird abgebrochen …/);
  assert.doesNotMatch(cancelling.sections[0].textContent, /Wird konvertiert/);
});

test('failed/stale rows have no "Abbrechen"; a cancelled row shows the reason alone and "Erneut versuchen"', () => {
  for (const status of ['stale']) assert.equal(dangerButtons(render({ status }).sections).length, 0);
  const failed = render({ status: 'failed', error: 'cancelled' });
  assert.equal(dangerButtons(failed.sections).length, 0);
  assert.match(failed.sections[0].textContent, /Vom Admin abgebrochen/);
  assert.match(failed.sections[0].textContent, /Erneut versuchen/);
  assert.doesNotMatch(failed.sections[0].textContent, /fehlgeschlagen:/);
});
