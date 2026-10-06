import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APP_PUBLIC_DIR,
  isInside,
  parseConverterCmd,
  pickConverterEnv,
} from '../src/config-converter.js';
import { loadConfig, ConfigError } from '../src/config.js';

const mediaRoot = mkdtempSync(join(tmpdir(), 'vt-media-'));

test.after(() => {
  rmSync(mediaRoot, { recursive: true, force: true });
});

/**
 * @param {() => unknown} fn
 * @returns {ConfigError}
 */
function assertConfigError(fn) {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  assert.fail('expected loadConfig to throw ConfigError');
}

// --- parseConverterCmd -------------------------------------------------

test('parseConverterCmd: unset is off (null, no problem)', () => {
  assert.deepEqual(parseConverterCmd(undefined), { cmd: null, problem: null });
});

test('parseConverterCmd: empty string is off', () => {
  assert.deepEqual(parseConverterCmd(''), { cmd: null, problem: null });
});

test('parseConverterCmd: whitespace-only is off', () => {
  assert.deepEqual(parseConverterCmd('   '), { cmd: null, problem: null });
});

test('parseConverterCmd: a valid absolute command is parsed and frozen', () => {
  const { cmd, problem } = parseConverterCmd('/usr/bin/node  --sample  ', { platform: 'linux' });
  assert.equal(problem, null);
  assert.deepEqual(cmd, ['/usr/bin/node', '--sample']);
  assert.ok(Object.isFrozen(cmd));
});

test('parseConverterCmd: a relative first token is rejected', () => {
  const { cmd, problem } = parseConverterCmd('relative/node --to web', { platform: 'linux' });
  assert.equal(cmd, null);
  assert.equal(problem, 'CONVERTER_CMD: first token must be an absolute path');
});

test('parseConverterCmd: more than 32 tokens is rejected', () => {
  const value = '/usr/bin/node ' + Array.from({ length: 32 }, (_, i) => `t${i}`).join(' ');
  const { cmd, problem } = parseConverterCmd(value, { platform: 'linux' });
  assert.equal(cmd, null);
  assert.equal(problem, 'CONVERTER_CMD: must have at most 32 tokens');
});

test('parseConverterCmd: exactly 32 tokens is accepted', () => {
  const value = '/usr/bin/node ' + Array.from({ length: 31 }, (_, i) => `t${i}`).join(' ');
  const { cmd, problem } = parseConverterCmd(value, { platform: 'linux' });
  assert.equal(problem, null);
  assert.equal(cmd?.length, 32);
});

test('parseConverterCmd: on win32 a rooted path without a drive letter is rejected', () => {
  const { cmd, problem } = parseConverterCmd('\\node.exe --to web', { platform: 'win32' });
  assert.equal(cmd, null);
  assert.equal(
    problem,
    'CONVERTER_CMD: first token must be an absolute path with a drive letter or UNC prefix',
  );
});

/** @type {[string, string, NodeJS.Platform][]} */
const acceptedConverterCmds = [
  ['a win32 drive-letter path', 'C:\\node.exe --to web', 'win32'],
  ['a win32 forward-slash drive path', 'C:/node.exe --to web', 'win32'],
  ['a win32 UNC path', '\\\\srv\\share\\node.exe --to web', 'win32'],
  ['a POSIX absolute path', '/usr/bin/node --to web', 'linux'],
];
for (const [label, value, platform] of acceptedConverterCmds) {
  test(`parseConverterCmd: ${label} is accepted`, () => {
    const { problem } = parseConverterCmd(value, { platform });
    assert.equal(problem, null);
  });
}

test('parseConverterCmd: problem text never contains the offending value', () => {
  const secret = 'relative/top-secret-converter-path';
  const { problem } = parseConverterCmd(`${secret} --to web`, { platform: 'linux' });
  assert.ok(problem !== null && !problem.includes(secret));
});

// --- pickConverterEnv ---------------------------------------------------

test('pickConverterEnv: copies only the allowlisted keys (POSIX)', () => {
  const env = pickConverterEnv(
    {
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      SystemRoot: 'C:\\Windows',
      ADMIN_PASSWORD: 'secret',
      TMPDIR: '/tmp',
      TEMP: '/tmp',
      TMP: '/tmp',
      OTHER: 'x',
    },
    { platform: 'linux' },
  );
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/home/u',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    SystemRoot: 'C:\\Windows',
  });
  assert.ok(Object.isFrozen(env));
});

test('pickConverterEnv: never contains ADMIN_PASSWORD, TMPDIR, TEMP or TMP', () => {
  const env = pickConverterEnv(
    { ADMIN_PASSWORD: 'x', TMPDIR: '/a', TEMP: '/b', TMP: '/c', PATH: '/usr/bin' },
    { platform: 'linux' },
  );
  for (const forbidden of ['ADMIN_PASSWORD', 'TMPDIR', 'TEMP', 'TMP']) {
    assert.equal(Object.hasOwn(env, forbidden), false);
  }
});

test('pickConverterEnv: only variables actually set are copied', () => {
  const env = pickConverterEnv({ PATH: '/usr/bin' }, { platform: 'linux' });
  assert.deepEqual(env, { PATH: '/usr/bin' });
});

test('pickConverterEnv: on win32 the lookup is case-insensitive, keeps the key and passes PATHEXT', () => {
  const env = pickConverterEnv({ Path: 'C:\\x', PathExt: '.COM;.EXE', ADMIN_PASSWORD: 'y' }, { platform: 'win32' });
  assert.deepEqual(env, { Path: 'C:\\x', PathExt: '.COM;.EXE' });
});

// --- isInside -------------------------------------------------------------

test('isInside: a path is inside itself', () => {
  const p = join(mediaRoot, 'a', 'b');
  assert.equal(isInside(p, p), true);
});

test('isInside: a child is inside its parent', () => {
  assert.equal(isInside(mediaRoot, join(mediaRoot, 'child')), true);
});

test('isInside: a sibling with a shared name prefix is not inside', () => {
  const parent = join(mediaRoot, 'media');
  const sibling = join(mediaRoot, 'media-other');
  assert.equal(isInside(parent, sibling), false);
});

test('isInside: a parent is not inside its own child (".." direction)', () => {
  const child = join(mediaRoot, 'a', 'b');
  assert.equal(isInside(child, mediaRoot), false);
});

// --- CONVERT_DIR via loadConfig -------------------------------------------

test('CONVERT_DIR defaults to <DATA_DIR>/converted', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'vt-data-'));
  try {
    const config = loadConfig({ MEDIA_ROOT: mediaRoot, DATA_DIR: dataDir });
    assert.equal(config.convertDir, join(dataDir, 'converted'));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an explicit CONVERT_DIR inside MEDIA_ROOT is rejected (valid DATA_DIR)', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'vt-data-'));
  try {
    const err = assertConfigError(() =>
      loadConfig({
        MEDIA_ROOT: mediaRoot,
        DATA_DIR: dataDir,
        CONVERT_DIR: join(mediaRoot, 'converted'),
      }),
    );
    assert.deepEqual(err.problems, ['CONVERT_DIR: must not overlap MEDIA_ROOT']);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// The reverse direction (an explicit CONVERT_DIR containing MEDIA_ROOT) uses
// the same symmetric `isInside(convertDir, mediaRoot)` check exercised
// directly by the `isInside` unit tests above; this covers it end to end via
// the default CONVERT_DIR instead, per the acceptance list's paired cases.
test('MEDIA_ROOT inside the default <DATA_DIR>/converted is rejected', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'vt-data-'));
  const nestedMediaRoot = join(dataDir, 'converted', 'media');
  mkdirSync(nestedMediaRoot, { recursive: true });
  try {
    const err = assertConfigError(() => loadConfig({ MEDIA_ROOT: nestedMediaRoot, DATA_DIR: dataDir }));
    assert.deepEqual(err.problems, ['CONVERT_DIR: must not overlap MEDIA_ROOT']);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a defaulted CONVERT_DIR with DATA_DIR inside MEDIA_ROOT yields exactly the DATA_DIR problem', () => {
  const err = assertConfigError(() =>
    loadConfig({ MEDIA_ROOT: mediaRoot, DATA_DIR: join(mediaRoot, 'data') }),
  );
  assert.deepEqual(err.problems, ['DATA_DIR: must not be inside MEDIA_ROOT']);
});

test('missing MEDIA_ROOT with the default CONVERT_DIR raises no false overlap problem', () => {
  const err = assertConfigError(() => loadConfig({}));
  assert.deepEqual(err.problems, ['MEDIA_ROOT: required']);
});

test('relative MEDIA_ROOT with the default CONVERT_DIR raises no false overlap problem', () => {
  const err = assertConfigError(() => loadConfig({ MEDIA_ROOT: 'relative/media' }));
  assert.deepEqual(err.problems, ['MEDIA_ROOT: must be an absolute path']);
});

test('an explicit CONVERT_DIR inside the public directory is rejected (also under requireMediaRoot: false)', () => {
  const dir = join(APP_PUBLIC_DIR, 'converted');
  const problem = 'CONVERT_DIR: must not be inside the public directory';
  assert.deepEqual(
    assertConfigError(() => loadConfig({ MEDIA_ROOT: mediaRoot, CONVERT_DIR: dir })).problems,
    [problem],
  );
  assert.deepEqual(
    assertConfigError(() => loadConfig({ CONVERT_DIR: dir }, { requireMediaRoot: false })).problems,
    [problem],
  );
});

// --- CONVERTER_CMD via loadConfig -----------------------------------------

test('CONVERTER_CMD unset or empty yields converterCmd: null via loadConfig', () => {
  const unset = loadConfig({ MEDIA_ROOT: mediaRoot });
  assert.equal(unset.converterCmd, null);
  const empty = loadConfig({ MEDIA_ROOT: mediaRoot, CONVERTER_CMD: '' });
  assert.equal(empty.converterCmd, null);
});

// The offending token is relative on every platform, but the reported rule
// text differs: win32 also names the drive-letter/UNC requirement (see
// `parseConverterCmd`'s win32 rule above), so the expectation follows
// `loadConfig`'s real `process.platform`, never a fixed platform.
test('a relative CONVERTER_CMD first token is rejected via loadConfig (also under requireMediaRoot: false)', () => {
  const problem =
    process.platform === 'win32'
      ? 'CONVERTER_CMD: first token must be an absolute path with a drive letter or UNC prefix'
      : 'CONVERTER_CMD: first token must be an absolute path';
  assert.deepEqual(
    assertConfigError(() =>
      loadConfig({ MEDIA_ROOT: mediaRoot, CONVERTER_CMD: 'relative/node --to web' }),
    ).problems,
    [problem],
  );
  assert.deepEqual(
    assertConfigError(() =>
      loadConfig({ CONVERTER_CMD: 'relative/node --to web' }, { requireMediaRoot: false }),
    ).problems,
    [problem],
  );
});

test('more than 32 CONVERTER_CMD tokens is rejected via loadConfig', () => {
  const value = 'relative-but-checked-later ' + Array.from({ length: 33 }, (_, i) => `t${i}`).join(' ');
  const err = assertConfigError(() => loadConfig({ MEDIA_ROOT: mediaRoot, CONVERTER_CMD: value }));
  assert.deepEqual(err.problems, ['CONVERTER_CMD: must have at most 32 tokens']);
});

test('converterCmd is frozen when set', () => {
  const config = loadConfig({
    MEDIA_ROOT: mediaRoot,
    // A Windows-style absolute path so this passes regardless of host
    // platform, since loadConfig validates with the real process.platform.
    CONVERTER_CMD: process.platform === 'win32' ? 'C:\\fake\\node.exe --to web' : '/fake/node --to web',
  });
  assert.ok(Array.isArray(config.converterCmd));
  assert.ok(Object.isFrozen(config.converterCmd));
});

test('converterEnv is present and frozen via loadConfig', () => {
  const config = loadConfig({ MEDIA_ROOT: mediaRoot });
  assert.ok(Object.isFrozen(config.converterEnv));
});
