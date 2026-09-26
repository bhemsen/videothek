import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/log.js';

/**
 * @returns {{ write(chunk: string): void, lines: unknown[] }}
 */
function fakeStream() {
  const stream = {
    lines: /** @type {unknown[]} */ ([]),
    /** @param {string} chunk */
    write(chunk) {
      assert.equal(chunk.endsWith('\n'), true);
      stream.lines.push(JSON.parse(chunk));
    },
  };
  return stream;
}

test('info and warn write one JSON line to out, error to err', () => {
  const out = fakeStream();
  const err = fakeStream();
  const log = createLogger({ out, err, now: () => 0 });

  log.info('startup');
  log.warn('slow_scan');
  log.error('request_error');

  assert.equal(out.lines.length, 2);
  assert.equal(err.lines.length, 1);
  assert.deepEqual(
    out.lines.map((l) => /** @type {{level:string}} */ (l).level),
    ['info', 'warn'],
  );
  assert.equal(/** @type {{level:string}} */ (err.lines[0]).level, 'error');
});

test('line carries t (ISO of now()), level and event plus fields', () => {
  const out = fakeStream();
  const log = createLogger({ out, err: fakeStream(), now: () => 1700000000000 });

  log.info('listening', { host: '0.0.0.0', port: 8080 });

  assert.deepEqual(out.lines[0], {
    t: new Date(1700000000000).toISOString(),
    level: 'info',
    event: 'listening',
    host: '0.0.0.0',
    port: 8080,
  });
});

test('a call without fields logs only t, level and event', () => {
  const out = fakeStream();
  const log = createLogger({ out, err: fakeStream(), now: () => 0 });

  log.info('shutdown');

  assert.deepEqual(Object.keys(out.lines[0] ?? {}).sort(), ['event', 'level', 't']);
});

test('redacts top-level keys matching the pattern, case-insensitively', () => {
  const out = fakeStream();
  const log = createLogger({ out, err: fakeStream(), now: () => 0 });

  log.info('login_ok', {
    user: 'julia',
    password: 'hunter2',
    Token: 'abc',
    apiSecret: 'xyz',
    Authorization: 'Bearer abc',
    passwordHash: 'scrypt$...',
    sessionCookie: 'vt_session=abc',
  });

  const line = /** @type {Record<string, unknown>} */ (out.lines[0]);
  assert.equal(line.user, 'julia');
  assert.equal(line.password, '[redacted]');
  assert.equal(line.Token, '[redacted]');
  assert.equal(line.apiSecret, '[redacted]');
  assert.equal(line.Authorization, '[redacted]');
  assert.equal(line.passwordHash, '[redacted]');
  assert.equal(line.sessionCookie, '[redacted]');
});

test('redacts nested keys inside objects and arrays without recursing into a matched value', () => {
  const out = fakeStream();
  const log = createLogger({ out, err: fakeStream(), now: () => 0 });

  log.info('user_created', {
    user: {
      username: 'julia',
      credentials: { password: 'hunter2', nested: { token: 'still-redacted' } },
    },
    sessions: [{ id: 1, cookie: 'a' }, { id: 2, cookie: 'b' }],
  });

  const line = /** @type {any} */ (out.lines[0]);
  assert.equal(line.user.username, 'julia');
  assert.equal(line.user.credentials.password, '[redacted]');
  assert.equal(line.sessions[0].id, 1);
  assert.equal(line.sessions[0].cookie, '[redacted]');
  assert.equal(line.sessions[1].cookie, '[redacted]');
});

test('serializes an Error field to { message, stack }', () => {
  const out = fakeStream();
  const log = createLogger({ out, err: fakeStream(), now: () => 0 });
  const boom = new Error('boom');

  log.info('request_error', { err: boom });

  const line = /** @type {any} */ (out.lines[0]);
  assert.equal(line.err.message, 'boom');
  assert.equal(typeof line.err.stack, 'string');
  assert.equal(line.err.stack.includes('boom'), true);
});

test('serializes a nested Error the same way', () => {
  const out = fakeStream();
  const log = createLogger({ out, err: fakeStream(), now: () => 0 });
  const boom = new Error('nested boom');

  log.info('migration_failed', { detail: { cause: boom } });

  const line = /** @type {any} */ (out.lines[0]);
  assert.equal(line.detail.cause.message, 'nested boom');
  assert.equal(typeof line.detail.cause.stack, 'string');
});

test('defaults to process.stdout/process.stderr and Date.now when no options are given', () => {
  const log = createLogger();
  assert.equal(typeof log.info, 'function');
  assert.equal(typeof log.warn, 'function');
  assert.equal(typeof log.error, 'function');
});
