import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(repoRoot, 'public');
const tokensPath = path.join(publicDir, 'css', 'tokens.css');
const faviconPath = path.join(publicDir, 'favicon.svg');
const designMdPath = path.join(repoRoot, 'docs', 'design.md');

const tokensCss = fs.readFileSync(tokensPath, 'utf8');
const designMd = fs.readFileSync(designMdPath, 'utf8');

/**
 * Recursively collects files under `dir` whose extension is in `exts`.
 * @param {string} dir
 * @param {string[]} exts
 * @returns {string[]}
 */
function walk(dir, exts) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, exts));
    else if (exts.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/**
 * Returns docs/design.md's front-matter lines (between the `---` fences).
 * @param {string} content
 * @returns {string[]}
 */
function readFrontMatter(content) {
  const lines = content.split(/\r?\n/);
  assert.equal(lines[0].trim(), '---', 'design.md must start with front matter');
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0, 'design.md front matter must be closed with ---');
  return lines.slice(1, end);
}

/**
 * Parses a top-level front-matter section's `key: "value"` children.
 * @param {string[]} lines
 * @param {string} sectionKey
 * @returns {Record<string, string>}
 */
function parseSection(lines, sectionKey) {
  const start = lines.findIndex((l) => l.trim() === `${sectionKey}:`);
  assert.ok(start >= 0, `design.md front matter missing section "${sectionKey}"`);
  /** @type {Record<string, string>} */
  const result = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) break;
    const m = line.match(/^\s+([\w-]+):\s*"([^"]*)"\s*(?:#.*)?$/);
    if (m) result[m[1]] = m[2];
  }
  return result;
}

/** @param {string} str @returns {string[]} */
const numbers = (str) => [...str.matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]);
/** @param {string} s @returns {string} */
const norm = (s) => s.replace(/\s+/g, '').toLowerCase();

/**
 * Strips `/* … *\/`, `//` line and `<!-- … -->` comments so a banned-API scan
 * does not flag a mention inside a doc comment describing what the code
 * deliberately avoids.
 * @param {string} content
 * @returns {string}
 */
function stripComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/.*$/gm, '');
}

/**
 * Extracts a `--name: value;` declaration's value from CSS text.
 * @param {string} css
 * @param {string} name
 * @returns {string | null}
 */
function getDeclaration(css, name) {
  const m = css.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

/** @param {string} name @param {string} expectedValue @returns {void} */
function assertToken(name, expectedValue) {
  const actual = getDeclaration(tokensCss, name);
  assert.ok(actual, `tokens.css is missing --${name}`);
  assert.equal(norm(actual ?? ''), norm(expectedValue), `--${name} must mirror design.md`);
}

/** @param {string} name @param {string} base @param {'white' | 'black'} mix @returns {void} */
function assertDerivedColor(name, base, mix) {
  const value = getDeclaration(tokensCss, name);
  assert.ok(value, `tokens.css is missing --${name}`);
  const re = /^color-mix\(\s*in\s+srgb\s*,\s*var\(--color-([a-z]+)\)\s*,\s*(white|black)\s+8%\s*\)$/i;
  const m = value.match(re);
  assert.ok(m, `--${name} must be color-mix(in srgb, var(--color-${base}), ${mix} 8%)`);
  assert.equal(m[1], base);
  assert.equal(m[2].toLowerCase(), mix);
}

const frontMatter = readFrontMatter(designMd);
const color = parseSection(frontMatter, 'color');
const type = parseSection(frontMatter, 'type');
const spacing = parseSection(frontMatter, 'spacing');
const radii = parseSection(frontMatter, 'radii');
const shadow = parseSection(frontMatter, 'shadow');

test('design.md front matter parses completely (regression guard)', () => {
  // Guards the parser above against silently skipping keys (e.g. a trailing
  // "# comment" on a value line breaking the regex) and the token tests
  // below then passing vacuously over an empty section.
  assert.deepEqual(
    Object.keys(color).sort(),
    ['accent', 'background', 'border', 'destructive', 'foreground', 'muted', 'primary', 'secondary'],
  );
  assert.deepEqual(Object.keys(type).sort(), ['font-mono', 'font-sans', 'line-height', 'scale', 'weights']);
  assert.ok('scale' in spacing, 'spacing.scale missing');
  assert.deepEqual(Object.keys(radii).sort(), ['full', 'lg', 'md', 'sm']);
  assert.deepEqual(Object.keys(shadow).sort(), ['md', 'sm']);
  // Guards the per-entry token tests below against a silently shortened
  // scale (e.g. a removed size), which would otherwise pair textNames[i]/
  // spaceNames[i] with the wrong number or leave them undefined.
  assert.equal(numbers(type.scale).length, 7, 'type.scale must have 7 sizes');
  assert.equal(numbers(type.weights).length, 3, 'type.weights must have 3 weights');
  assert.equal(numbers(type['line-height']).length, 2, 'type.line-height must have 2 values');
  assert.equal(numbers(spacing.scale).length, 8, 'spacing.scale must have 8 sizes');
});

test('tokens.css mirrors every design.md colour token', () => {
  for (const [key, value] of Object.entries(color)) assertToken(`color-${key}`, value);
});

test('tokens.css has the derived hover/active state colours', () => {
  assertDerivedColor('color-primary-hover', 'primary', 'white');
  assertDerivedColor('color-primary-active', 'primary', 'black');
  assertDerivedColor('color-secondary-hover', 'secondary', 'white');
  assertDerivedColor('color-secondary-active', 'secondary', 'black');
});

test('tokens.css mirrors design.md type tokens', () => {
  assertToken('font-sans', type['font-sans']);
  assertToken('font-mono', type['font-mono']);
  const textNames = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'];
  numbers(type.scale).forEach((n, i) => assertToken(`text-${textNames[i]}`, `${n}px`));
  const weightNames = ['regular', 'semibold', 'bold'];
  numbers(type.weights).forEach((n, i) => assertToken(`weight-${weightNames[i]}`, n));
  const leadingNames = ['body', 'heading'];
  numbers(type['line-height']).forEach((n, i) => assertToken(`leading-${leadingNames[i]}`, n));
});

test('tokens.css mirrors design.md spacing and radii tokens', () => {
  const spaceNames = ['1', '2', '3', '4', '6', '8', '12', '16'];
  numbers(spacing.scale).forEach((n, i) => assertToken(`space-${spaceNames[i]}`, `${n}px`));
  for (const [key, value] of Object.entries(radii)) assertToken(`radius-${key}`, value);
});

test('tokens.css mirrors design.md shadow tokens', () => {
  for (const [key, value] of Object.entries(shadow)) assertToken(`shadow-${key}`, value);
});

test('tokens.css has the fixed layout tokens', () => {
  assertToken('bar-height', '64px');
  assertToken('bar-height-mobile', '56px');
  assertToken('tap-min', '44px');
  assertToken('content-max', '1280px');
  assertToken('border-width', '1px');
  assertToken('focus-width', '2px');
  assertToken('focus-offset', '2px');
  assertToken('grid-min', '160px');
  assertToken('row-min', '48px');
});

/**
 * Hex/rgb()/hsl() colour literals found in `content`.
 * @param {string} content
 * @returns {string[]}
 */
function findRawColors(content) {
  const hexRe = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{3}\b/g;
  const fnRe = /\b(rgba|rgb|hsla|hsl)\(/g;
  return [...content.matchAll(hexRe), ...content.matchAll(fnRe)].map((m) => m[0]);
}

/**
 * Raw px/rem/em lengths in `content`, outside allowed @media breakpoints.
 * @param {string} content
 * @returns {string[]}
 */
function findRawLengths(content) {
  /** @type {string[]} */
  const violations = [];
  for (const m of content.matchAll(/@media([^{]*)\{/g)) {
    for (const n of m[1].matchAll(/(-?\d+(?:\.\d+)?)(px|rem|em)\b/g)) {
      const length = `${n[1]}${n[2]}`;
      if (length !== '768px' && length !== '1024px') violations.push(`@media ${length}`);
    }
  }
  const stripped = content.replace(/@media[^{]*\{/g, '@media {');
  for (const m of stripped.matchAll(/-?\d+(?:\.\d+)?(?:px|rem|em)\b/g)) violations.push(m[0]);
  return violations;
}

const cssJsHtmlFiles = walk(publicDir, ['.css', '.js', '.html']).filter((f) => f !== tokensPath);

test('no raw colour outside tokens.css', () => {
  const violations = cssJsHtmlFiles.flatMap((file) => {
    const hits = findRawColors(fs.readFileSync(file, 'utf8'));
    return hits.map((h) => `${path.relative(repoRoot, file)}: ${h}`);
  });
  assert.deepEqual(violations, []);
});

test('no raw px/rem/em length outside tokens.css (breakpoints excepted)', () => {
  const violations = cssJsHtmlFiles.flatMap((file) => {
    const hits = findRawLengths(fs.readFileSync(file, 'utf8'));
    return hits.map((h) => `${path.relative(repoRoot, file)}: ${h}`);
  });
  assert.deepEqual(violations, []);
});

test('favicon.svg colours are all design.md tokens', () => {
  const svg = fs.readFileSync(faviconPath, 'utf8');
  const tokenColors = new Set(Object.values(color).map((v) => v.toLowerCase()));
  const used = findRawColors(svg).filter((h) => h.startsWith('#'));
  assert.ok(used.length > 0, 'favicon.svg has no colour at all');
  for (const hex of used) {
    assert.ok(tokenColors.has(hex.toLowerCase()), `favicon.svg colour ${hex} is not a design.md token`);
  }
});

test('no http(s):// URL outside the SVG namespace', () => {
  const files = walk(publicDir, ['.css', '.js', '.html', '.svg']);
  const violations = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const m of content.matchAll(/https?:\/\/\S+/g)) {
      const url = m[0].replace(/[)"'<>,;]+$/, '');
      if (url !== 'http://www.w3.org/2000/svg') {
        violations.push(`${path.relative(repoRoot, file)}: ${url}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('no innerHTML/outerHTML/insertAdjacentHTML/document.write', () => {
  const files = walk(publicDir, ['.js', '.html']);
  const violations = [];
  for (const file of files) {
    const content = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of content.matchAll(/\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/g)) {
      violations.push(`${path.relative(repoRoot, file)}: ${m[0]}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('no style attribute or inline <script>/<style>', () => {
  const files = walk(publicDir, ['.js', '.html']);
  const violations = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(repoRoot, file);
    if (/\sstyle\s*=/.test(content)) violations.push(`${rel}: style= attribute`);
    if (/setAttribute\(\s*['"]style['"]/.test(content)) violations.push(`${rel}: setAttribute('style')`);
    if (/<style[\s>]/i.test(content)) violations.push(`${rel}: inline <style>`);
    for (const m of content.matchAll(/<script\b[^>]*>/gi)) {
      if (!/\bsrc\s*=/i.test(m[0])) violations.push(`${rel}: inline <script>`);
    }
  }
  assert.deepEqual(violations, []);
});
