import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { loadConfig, ConfigError } from '../src/config.js';

const mediaRoot = mkdtempSync(join(tmpdir(), 'vt-media-'));
const nonDirDir = mkdtempSync(join(tmpdir(), 'vt-file-'));
const nonDirPath = join(nonDirDir, 'not-a-dir');
writeFileSync(nonDirPath, 'x');

test.after(() => {
  rmSync(mediaRoot, { recursive: true, force: true });
  rmSync(nonDirDir, { recursive: true, force: true });
});

/** @returns {NodeJS.ProcessEnv} a minimal, valid base env */
function baseEnv() {
  return { MEDIA_ROOT: mediaRoot };
}

/**
 * Runs `fn`, asserting it throws a {@link ConfigError}, and returns it (so
 * `assert.throws`, which is typed to return `void`, does not have to be
 * used just to inspect `problems`).
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

test('returns a frozen Config with the given values', () => {
  const config = loadConfig({
    MEDIA_ROOT: mediaRoot,
    DATA_DIR: './somewhere-else',
    HOST: '127.0.0.1',
    PORT: '9090',
    RESCAN_INTERVAL_MIN: '30',
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: 'secret',
  });
  assert.equal(config.mediaRoot, mediaRoot);
  assert.equal(config.dataDir, resolve(process.cwd(), './somewhere-else'));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 9090);
  assert.equal(config.rescanIntervalMin, 30);
  assert.equal(config.adminUser, 'admin');
  assert.equal(config.adminPassword, 'secret');
  assert.ok(Object.isFrozen(config));
});

test('applies defaults when optional variables are unset', () => {
  const config = loadConfig(baseEnv());
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 8080);
  assert.equal(config.rescanIntervalMin, 15);
  assert.equal(config.dataDir, resolve(process.cwd(), './data'));
  assert.equal(config.adminUser, null);
  assert.equal(config.adminPassword, null);
});

test('treats an empty string as unset', () => {
  const config = loadConfig({
    ...baseEnv(),
    DATA_DIR: '',
    ADMIN_USER: '',
    ADMIN_PASSWORD: '',
  });
  assert.equal(config.dataDir, resolve(process.cwd(), './data'));
  assert.equal(config.adminUser, null);
  assert.equal(config.adminPassword, null);
});

test('missing MEDIA_ROOT is rejected', () => {
  const err = assertConfigError(() => loadConfig({}));
  assert.deepEqual(err.problems, ['MEDIA_ROOT: required']);
});

test('relative MEDIA_ROOT is rejected', () => {
  const err = assertConfigError(() =>
    loadConfig({ MEDIA_ROOT: 'relative/media' }),
  );
  assert.deepEqual(err.problems, ['MEDIA_ROOT: must be an absolute path']);
});

test('non-directory MEDIA_ROOT is rejected', () => {
  const err = assertConfigError(() => loadConfig({ MEDIA_ROOT: nonDirPath }));
  assert.deepEqual(err.problems, ['MEDIA_ROOT: must be a readable directory']);
});

test('nonexistent MEDIA_ROOT is rejected', () => {
  const err = assertConfigError(() =>
    loadConfig({ MEDIA_ROOT: join(mediaRoot, 'does-not-exist') }),
  );
  assert.deepEqual(err.problems, ['MEDIA_ROOT: must be a readable directory']);
});

test('DATA_DIR inside MEDIA_ROOT is rejected', () => {
  const err = assertConfigError(() =>
    loadConfig({
      MEDIA_ROOT: mediaRoot,
      DATA_DIR: join(mediaRoot, 'data'),
    }),
  );
  assert.deepEqual(err.problems, ['DATA_DIR: must not be inside MEDIA_ROOT']);
});

test('DATA_DIR equal to MEDIA_ROOT is rejected', () => {
  const err = assertConfigError(() =>
    loadConfig({ MEDIA_ROOT: mediaRoot, DATA_DIR: mediaRoot }),
  );
  assert.deepEqual(err.problems, ['DATA_DIR: must not be inside MEDIA_ROOT']);
});

test('MEDIA_ROOT with a trailing "." segment is resolved and DATA_DIR containment still catches it', () => {
  const err = assertConfigError(() =>
    loadConfig({
      MEDIA_ROOT: `${mediaRoot}${sep}.`,
      DATA_DIR: join(mediaRoot, 'data'),
    }),
  );
  assert.deepEqual(err.problems, ['DATA_DIR: must not be inside MEDIA_ROOT']);
});

test('MEDIA_ROOT with a "dir/.." segment is resolved and DATA_DIR containment still catches it', () => {
  const err = assertConfigError(() =>
    loadConfig({
      MEDIA_ROOT: join(mediaRoot, 'x', '..'),
      DATA_DIR: join(mediaRoot, 'data'),
    }),
  );
  assert.deepEqual(err.problems, ['DATA_DIR: must not be inside MEDIA_ROOT']);
});

test('mediaRoot always comes back normalized (resolved), even with a trailing "." segment', () => {
  const config = loadConfig({
    MEDIA_ROOT: `${mediaRoot}${sep}.`,
    DATA_DIR: './somewhere-else',
  });
  assert.equal(config.mediaRoot, mediaRoot);
});

if (process.platform === 'win32') {
  test('DATA_DIR inside MEDIA_ROOT is caught regardless of letter case (win32)', () => {
    const err = assertConfigError(() =>
      loadConfig({
        MEDIA_ROOT: mediaRoot.toUpperCase(),
        DATA_DIR: join(mediaRoot, 'data'),
      }),
    );
    assert.deepEqual(err.problems, ['DATA_DIR: must not be inside MEDIA_ROOT']);
  });
}

for (const badPort of ['0', '65536', 'abc', '8080.5', '-1', ' 80']) {
  test(`bad PORT "${badPort}" is rejected`, () => {
    const err = assertConfigError(() =>
      loadConfig({ ...baseEnv(), PORT: badPort }),
    );
    assert.deepEqual(err.problems, [
      'PORT: must be an integer between 1 and 65535',
    ]);
  });
}

for (const badInterval of ['0', '1441', 'abc']) {
  test(`bad RESCAN_INTERVAL_MIN "${badInterval}" is rejected`, () => {
    const err = assertConfigError(() =>
      loadConfig({ ...baseEnv(), RESCAN_INTERVAL_MIN: badInterval }),
    );
    assert.deepEqual(err.problems, [
      'RESCAN_INTERVAL_MIN: must be an integer between 1 and 1440',
    ]);
  });
}

test('lone ADMIN_USER without ADMIN_PASSWORD is rejected', () => {
  const err = assertConfigError(() =>
    loadConfig({ ...baseEnv(), ADMIN_USER: 'admin' }),
  );
  assert.deepEqual(err.problems, [
    'ADMIN_PASSWORD: required when the other ADMIN_* variable is set',
  ]);
});

test('lone ADMIN_PASSWORD without ADMIN_USER is rejected', () => {
  const err = assertConfigError(() =>
    loadConfig({ ...baseEnv(), ADMIN_PASSWORD: 'secret' }),
  );
  assert.deepEqual(err.problems, [
    'ADMIN_USER: required when the other ADMIN_* variable is set',
  ]);
});

test('collects every problem in one throw', () => {
  const err = assertConfigError(() =>
    loadConfig({
      PORT: '0',
      ADMIN_USER: 'admin',
    }),
  );
  assert.deepEqual(err.problems, [
    'MEDIA_ROOT: required',
    'PORT: must be an integer between 1 and 65535',
    'ADMIN_PASSWORD: required when the other ADMIN_* variable is set',
  ]);
});

test('never includes a variable value in a problem message', () => {
  const secretPort = '9999999-not-a-port';
  const secretUser = 'top-secret-admin-name';
  const err = assertConfigError(() =>
    loadConfig({
      MEDIA_ROOT: 'relative/should-not-appear',
      PORT: secretPort,
      ADMIN_USER: secretUser,
    }),
  );
  const joined = err.problems.join(' | ');
  assert.ok(!joined.includes('relative/should-not-appear'));
  assert.ok(!joined.includes(secretPort));
  assert.ok(!joined.includes(secretUser));
});

test('requireMediaRoot: false skips MEDIA_ROOT checks when unset', () => {
  const config = loadConfig({}, { requireMediaRoot: false });
  assert.equal(config.mediaRoot, null);
});

test('requireMediaRoot: false skips MEDIA_ROOT checks for a relative value', () => {
  const config = loadConfig(
    { MEDIA_ROOT: 'relative/media' },
    { requireMediaRoot: false },
  );
  assert.equal(config.mediaRoot, null);
});

test('requireMediaRoot: false skips MEDIA_ROOT checks for a nonexistent absolute value', () => {
  const missing = join(mediaRoot, 'does-not-exist');
  const config = loadConfig({ MEDIA_ROOT: missing }, { requireMediaRoot: false });
  assert.equal(config.mediaRoot, missing);
});

test('requireMediaRoot: false skips the DATA_DIR containment check too', () => {
  const config = loadConfig(
    { MEDIA_ROOT: mediaRoot, DATA_DIR: join(mediaRoot, 'data') },
    { requireMediaRoot: false },
  );
  assert.equal(config.mediaRoot, mediaRoot);
  assert.equal(config.dataDir, join(mediaRoot, 'data'));
});

test('requireMediaRoot: false still applies other defaults and validations', () => {
  const err = assertConfigError(() =>
    loadConfig({ PORT: '0' }, { requireMediaRoot: false }),
  );
  assert.deepEqual(err.problems, [
    'PORT: must be an integer between 1 and 65535',
  ]);
});
