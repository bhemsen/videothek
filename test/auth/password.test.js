import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, DUMMY_HASH } from '../../src/auth/password.js';

const HASH_FORMAT = /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/;

test('hashPassword produces the documented scrypt$N$r$p$salt$hash format', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.match(hash, HASH_FORMAT);
});

test('hashPassword salts each call differently', async () => {
  const a = await hashPassword('same-password');
  const b = await hashPassword('same-password');
  assert.notEqual(a, b);
});

test('verifyPassword accepts the correct password', async () => {
  const hash = await hashPassword('s3cret-password');
  assert.equal(await verifyPassword('s3cret-password', hash), true);
});

test('verifyPassword rejects a wrong password', async () => {
  const hash = await hashPassword('s3cret-password');
  assert.equal(await verifyPassword('wrong-password', hash), false);
});

test('verifyPassword rejects a tampered hash', async () => {
  const hash = await hashPassword('s3cret-password');
  const [scheme, n, r, p, salt, digest] = hash.split('$');
  const tamperedChar = digest[0] === 'A' ? 'B' : 'A';
  const tampered = [scheme, n, r, p, salt, tamperedChar + digest.slice(1)].join('$');
  assert.equal(await verifyPassword('s3cret-password', tampered), false);
});

test('verifyPassword rejects a tampered salt', async () => {
  const hash = await hashPassword('s3cret-password');
  const [scheme, n, r, p, salt, digest] = hash.split('$');
  const tamperedChar = salt[0] === 'A' ? 'B' : 'A';
  const tampered = [scheme, n, r, p, tamperedChar + salt.slice(1), digest].join('$');
  assert.equal(await verifyPassword('s3cret-password', tampered), false);
});

test('verifyPassword never throws on malformed stored values', async () => {
  /** @type {Array<string | null | undefined>} */
  const malformed = [
    '',
    'not-a-hash-at-all',
    'scrypt$16384$8$1$onlysalt',
    'scrypt$16384$8$1$$hash',
    'bcrypt$16384$8$1$c2FsdA==$aGFzaA==',
    'scrypt$abc$8$1$c2FsdA==$aGFzaA==',
    'scrypt$0$8$1$c2FsdA==$aGFzaA==',
    'scrypt$16384$0$1$c2FsdA==$aGFzaA==',
    null,
    undefined,
  ];
  for (const stored of malformed) {
    // eslint-disable-next-line no-await-in-loop
    await assert.doesNotReject(async () => {
      const result = await verifyPassword('any-password', /** @type {string} */ (stored));
      assert.equal(result, false);
    });
  }
});

test('DUMMY_HASH is a valid-format hash that never verifies as correct', async () => {
  assert.match(DUMMY_HASH, HASH_FORMAT);
  assert.equal(await verifyPassword('anything', DUMMY_HASH), false);
});
