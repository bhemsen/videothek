import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Static checks on `public/css/convert-control.css` (#227): the stylesheet
 * must only change rows that actually hold a control, and select
 * `.convert-control` by class only (spec "UI behaviour" / "Design").
 */

const css = (await readFile(new URL('../../public/css/convert-control.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule's selector list, split on commas. @returns {string[]} */
function selectors() {
  return [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => m[1].split(',').map((s) => s.trim())).filter((s) => s && !s.startsWith('@'));
}

test('every selector is scoped to .convert-control (itself, a descendant, or a host that :has one)', () => {
  for (const selector of selectors()) {
    assert.match(selector, /\.convert-control/, `unscoped selector: ${selector}`);
  }
});

test('the <768px wrap only applies to hosts holding a control, never to every episode/track row', () => {
  const media = /@media not \(min-width: 768px\)\s*\{([\s\S]*)\}\s*$/.exec(css.trim());
  assert.ok(media, 'the narrow-viewport block exists');
  const wrapRule = /([^{}]+)\{[^{}]*flex-wrap:\s*wrap[^{}]*\}/.exec(media[1]);
  assert.ok(wrapRule, 'a flex-wrap rule exists');
  const hosts = wrapRule[1].split(',').map((s) => s.trim());
  assert.deepEqual(hosts, ['.episode-row:has(> .convert-control)', '.track-row--unplayable:has(> .convert-control)']);
  assert.match(media[1], /\.episode-row:has\(> \.convert-control\) > \.episode-row__body\s*\{[^}]*flex:\s*1 1 0/);
  assert.match(media[1], /\.track-row--unplayable:has\(> \.convert-control\) > \.track-row__title\s*\{[^}]*flex:\s*1 1 0/);
  assert.match(media[1], /> \.convert-control\s*\{[^}]*flex-basis:\s*100%/);
});

test('no rule relies on sibling order or :last-child', () => {
  assert.doesNotMatch(css, /:last-child|:first-child|:nth-|[+~]\s*\./);
});
