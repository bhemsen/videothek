import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Machine-checked constitution/frontend rules (docs/constitution.md). Plain
// string/regex scans only — TypeScript 7 ships no compiler API to lint with.
// Every check must pass on an empty src/ (nothing built there yet).
// The pattern scans strip comments first (see stripComments) so a JSDoc line
// documenting a rule (e.g. "no `console.*` in `src/`") does not trip the
// rule it documents. They stay intentionally conservative about string
// literals though: a rule name inside a string literal still trips a scan,
// trading that occasional false positive for a dependency-free check.

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
 * Strips `//` line comments and `/* *\/` block comments from JS source text
 * so the pattern scans below don't trip on a rule name mentioned in a
 * comment. String and template literals are copied through untouched
 * (including any `//` or `/* *\/`-like text inside them), so a match inside
 * a string literal still trips a scan — see the module comment above.
 * @param {string} content
 * @returns {string} content with comments removed, strings left intact
 */
function stripComments(content) {
  let out = '';
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      out += ch;
      i++;
      while (i < n && content[i] !== ch) {
        if (content[i] === '\\') {
          out += content[i] + (content[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += content[i];
        i++;
      }
      if (i < n) {
        out += content[i];
        i++;
      }
      continue;
    }
    const two = content.slice(i, i + 2);
    if (two === '//') {
      while (i < n && content[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < n && content.slice(i, i + 2) !== '*/') {
        if (content[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Reads a source file with comments stripped, for the rule scans below.
 * @param {string} file absolute path
 * @returns {string} the file's content, comment-free
 */
function readSourceForScan(file) {
  return stripComments(readFileSync(file, 'utf8'));
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
    if (/\bprocess\.env\b/.test(readSourceForScan(file))) {
      offenders.push(path.relative(rootDir, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test('src/ never calls console.*', () => {
  const offenders = [];
  for (const file of listFiles(srcDir).filter((f) => f.endsWith('.js'))) {
    if (/\bconsole\./.test(readSourceForScan(file))) {
      offenders.push(path.relative(rootDir, file));
    }
  }
  assert.deepEqual(offenders, []);
});

// The one src/ file allowed to import node:child_process
// (spec-conversion-core.md, "Constraints" / "Constitution-test change").
const CHILD_PROCESS_EXEMPT_FILE = 'src/convert/run-converter.js';

test('src/ and public/ never use child_process (except the converter runner), eval() or new Function()', () => {
  const forbidden = [
    { name: 'child_process', re: /child_process/ },
    { name: 'eval(', re: /\beval\s*\(/ },
    { name: 'new Function', re: /\bnew\s+Function\b/ },
  ];
  const offenders = [];
  const files = [...listFiles(srcDir), ...listFiles(publicDir)].filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const rel = path.relative(rootDir, file).split(path.sep).join('/');
    const content = readSourceForScan(file);
    for (const { name, re } of forbidden) {
      if (name === 'child_process' && rel === CHILD_PROCESS_EXEMPT_FILE) continue;
      if (re.test(content)) offenders.push(`${rel}: ${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('src/convert/run-converter.js imports only spawn from node:child_process, uses no shell and calls no bare exec/fork', () => {
  const file = path.join(rootDir, ...CHILD_PROCESS_EXEMPT_FILE.split('/'));
  const content = readSourceForScan(file);
  const bareCallRe = /(?<![.\w$])(?:exec|execFile|execSync|execFileSync|fork)\s*\(/;

  const occurrences = content.match(/child_process/g) ?? [];
  assert.equal(occurrences.length, 1, 'child_process must occur exactly once (no second or dynamic import)');
  assert.match(content, /import\s*\{\s*spawn\s*\}\s*from\s*['"]node:child_process['"]/, 'the only import must be { spawn } from node:child_process');
  assert.equal(/\bshell\b/.test(content), false, 'the word "shell" must not appear (the file never needs it)');
  assert.equal(bareCallRe.test(content), false, 'no bare exec/execFile/execSync/execFileSync/fork call');

  // The bare-call pattern itself: a member call must never trip it, a bare call always must.
  assert.equal(bareCallRe.test('re.exec(pattern)'), false, 'a member call like re.exec( must be allowed');
  assert.equal(bareCallRe.test('exec(cmd)'), true, 'a genuine bare exec( call must be caught');
});

test('src/ and public/ never import from one another', () => {
  const offenders = [];
  for (const file of listFiles(srcDir).filter((f) => f.endsWith('.js'))) {
    for (const spec of extractImportSpecifiers(readSourceForScan(file))) {
      if (/(^|\/)public(\/|$)/.test(spec)) offenders.push(`${path.relative(rootDir, file)} -> ${spec}`);
    }
  }
  for (const file of listFiles(publicDir).filter((f) => f.endsWith('.js'))) {
    for (const spec of extractImportSpecifiers(readSourceForScan(file))) {
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

test('stripComments removes // and /* */ comments but leaves string literals intact', () => {
  const source = [
    '/**',
    ' * mentions console.* only in a comment, like this file documents.',
    ' */',
    "const a = 1; // also mentions process.env in a line comment",
    'console.log(a);',
    'const url = "https://example.com"; // not a comment despite the //',
    "const note = 'contains /* not a real block comment */ inside a string';",
  ].join('\n');
  const stripped = stripComments(source);
  assert.equal(/\bconsole\./.test(stripped), true, 'the real console.log call must survive stripping');
  assert.equal(/\bprocess\.env\b/.test(stripped), false, 'the comment-only mention must be gone');
  assert.equal(stripped.includes('https://example.com'), true, 'string literals must survive stripping');
  assert.equal(
    stripped.includes('contains /* not a real block comment */ inside a string'),
    true,
    'comment-like text inside a string literal must survive stripping',
  );
});

const PROCESS_CONTROL = /\bprocess\s*(?:\.|\[\s*['\"])kill\b|\{[^}]*\bkill\b[^}]*\}\s*=\s*process\b|\bsetPriority\b|\bdetached\b/;

test('process.kill, setPriority and detached appear only in src/convert/run-converter.js', () => {
  const offenders = listFiles(srcDir)
    .filter((f) => f.endsWith('.js') && path.relative(rootDir, f).split(path.sep).join('/') !== CHILD_PROCESS_EXEMPT_FILE)
    .filter((f) => PROCESS_CONTROL.test(readSourceForScan(f)))
    .map((f) => path.relative(rootDir, f));
  assert.deepEqual(offenders, []);
});

const DELETE_USE = /\b(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\b/;
const DELETE_ALLOWED = new Set(['queue.js', 'job.js', 'work-dir.js', 'publish.js', 'sidecars.js', 'cleanup.js']);

test('any use of rm/unlink/rmdir under src/convert/ appear only in the allowed modules', () => {
  const offenders = listFiles(path.join(srcDir, 'convert'))
    .filter((f) => f.endsWith('.js') && !DELETE_ALLOWED.has(path.relative(path.join(srcDir, 'convert'), f).split(path.sep).join('/')))
    .filter((f) => DELETE_USE.test(readSourceForScan(f)))
    .map((f) => path.relative(rootDir, f));
  assert.deepEqual(offenders, []);
});
