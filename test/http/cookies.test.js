import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCookies, serializeCookie } from '../../src/http/cookies.js';

test('parseCookies returns {} for an absent header', () => {
  assert.deepEqual(parseCookies(undefined), {});
});

test('parseCookies parses multiple name=value pairs', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
});

test('parseCookies percent-decodes values', () => {
  assert.deepEqual(parseCookies('name=a%20b'), { name: 'a b' });
});

test('parseCookies falls back to the raw value on malformed encoding', () => {
  assert.deepEqual(parseCookies('x=%zz'), { x: '%zz' });
});

test('parseCookies ignores pairs without "="', () => {
  assert.deepEqual(parseCookies('flag; a=1'), { a: '1' });
});

test('serializeCookie applies the spec defaults', () => {
  const value = serializeCookie('vt_session', 'abc', { maxAge: 2592000, secure: false });
  assert.equal(value, 'vt_session=abc; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax');
});

test('serializeCookie adds Secure when requested', () => {
  const value = serializeCookie('vt_session', 'abc', { maxAge: 60, secure: true });
  assert.equal(value, 'vt_session=abc; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax');
});

test('serializeCookie omits HttpOnly when disabled', () => {
  const value = serializeCookie('a', 'b', { httpOnly: false });
  assert.equal(value, 'a=b; Path=/; SameSite=Lax');
});

test('serializeCookie supports Max-Age=0 to clear a cookie', () => {
  const value = serializeCookie('vt_session', '', { maxAge: 0, secure: false });
  assert.equal(value, 'vt_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
});

test('serializeCookie percent-encodes the value', () => {
  const value = serializeCookie('a', 'b c', {});
  assert.equal(value, 'a=b%20c; Path=/; HttpOnly; SameSite=Lax');
});

test('serializeCookie honours a custom path and sameSite', () => {
  const value = serializeCookie('a', 'b', { path: '/admin', sameSite: 'Strict' });
  assert.equal(value, 'a=b; Path=/admin; HttpOnly; SameSite=Strict');
});
