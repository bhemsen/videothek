import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Machine-checked constitution/frontend rules (docs/constitution.md). Plain
// string/regex scans only — TypeScript 7 ships no compiler API to lint with.
// Every check must pass on an empty src/ (nothing built there yet).
// The scans below are intentionally conservative: they also match inside
// comments and string literals (e.g. a JSDoc line mentioning `console.log`
// trips the console.* rule), trading occasional false positives for a
// dependency-free check.

const rootDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const srcDir = path.join(rootDir, 'src');
const publicDir = path.join(rootDir, 'public');
const testDir = path.join(rootDir, 'test');

/**
 * Recursively lists files under a directory.
 * @param {string} dir
 * @returns {string[]} absolute file paths, or `[]` if `dir` does not exist
 */
function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

/**
 * Counts lines in file content, ignoring a single trailing newline so a
 * 300-line file saved with a final `\n` (the normal case) still counts as
 * 300, not 301.
 * @param {string} content
 * @returns {number} the line count
 */
function countLines(content) {
  const lines = content.split('\n');
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

/**
 * Extracts static/dynamic import and require specifiers from source text.
 * @param {string} content
 * @returns {string[]} the quoted module specifiers found
 */
function extractImportSpecifiers(content) {
  const patterns = [
    /import\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /export\s+(?:[^'";]+?\s+from\s+)['"]([^'"]+)['"]/g,
  ];
  const specifiers = [];
  for (const re of patterns) {
    for (const match of content.matchAll(re)) specifiers.push(match[1]);
  }
  return specifiers;
}

test('package.json has no runtime dependencies and only the allowed devDependencies', () => {
  const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  assert.equal(Object.hasOwn(pkg, 'dependencies'), false, 'package.json must not have a "dependencies" key');
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}).sort(), ['@types/node', 'typescript']);
});

test('process.env is read only in src/config.js', () => {
  const offenders = [];
  for (const file of listFiles(srcDir).filter((f) => f.endsWith('.js'))) {
    if (path.relative(srcDir, file) === 'config.js') continue;
    if (/\bprocess\.env\b/.test(readFileSync(file, 'utf8'))) {
      offenders.push(path.relative(rootDir, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test('src/ never calls console.*', () => {
  const offenders = [];
  for (const file of listFiles(srcDir).filter((f) => f.endsWith('.js'))) {
    if (/\bconsole\./.test(readFileSync(file, 'utf8'))) {
      offenders.push(path.relative(rootDir, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test('src/ and public/ never use child_process, eval() or new Function()', () => {
  const forbidden = [
    { name: 'child_process', re: /child_process/ },
    { name: 'eval(', re: /\beval\s*\(/ },
    { name: 'new Function(', re: /new\s+Function\s*\(/ },
  ];
  const offenders = [];
  const files = [...listFiles(srcDir), ...listFiles(publicDir)].filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const { name, re } of forbidden) {
      if (re.test(content)) offenders.push(`${path.relative(rootDir, file)}: ${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('src/ and public/ never import from one another', () => {
  const offenders = [];
  for (const file of listFiles(srcDir).filter((f) => f.endsWith('.js'))) {
    for (const spec of extractImportSpecifiers(readFileSync(file, 'utf8'))) {
      if (/(^|\/)public(\/|$)/.test(spec)) offenders.push(`${path.relative(rootDir, file)} -> ${spec}`);
    }
  }
  for (const file of listFiles(publicDir).filter((f) => f.endsWith('.js'))) {
    for (const spec of extractImportSpecifiers(readFileSync(file, 'utf8'))) {
      if (/(^|\/)src(\/|$)/.test(spec)) offenders.push(`${path.relative(rootDir, file)} -> ${spec}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('every src/**/*.js module has a mirrored test/**/*.test.js', () => {
  const missing = [];
  for (const file of listFiles(srcDir).filter((f) => f.endsWith('.js'))) {
    const rel = path.relative(srcDir, file).split(path.sep).join('/');
    const testPath = path.join(testDir, rel.replace(/\.js$/, '.test.js'));
    if (!existsSync(testPath)) missing.push(`src/${rel}`);
  }
  assert.deepEqual(missing, []);
});

test('no .js/.css/.html file under src/, public/ or test/ (fixtures excluded) exceeds 300 lines', () => {
  const offenders = [];
  for (const dir of [srcDir, publicDir, testDir]) {
    for (const file of listFiles(dir).filter((f) => /\.(js|css|html)$/.test(f))) {
      if (dir === testDir && path.relative(testDir, file).split(path.sep)[0] === 'fixtures') continue;
      const lineCount = countLines(readFileSync(file, 'utf8'));
      if (lineCount > 300) offenders.push(`${path.relative(rootDir, file)}: ${lineCount} lines`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('countLines does not count a trailing newline as an extra line', () => {
  const exactly300 = `${Array(300).fill('x').join('\n')}\n`;
  const exactly301 = `${Array(301).fill('x').join('\n')}\n`;
  assert.equal(countLines(exactly300), 300);
  assert.equal(countLines(exactly301), 301);
});
