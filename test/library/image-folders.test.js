import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderKeyForDir, parseFolderKey } from '../../src/library/image-folders.js';

test('folderKeyForDir', async (t) => {
  await t.test('nested dir under an alias root', () => {
    assert.equal(folderKeyForDir('Bilder/Urlaub 2024/Italien'), 'Urlaub 2024/Italien');
  });

  await t.test('a file directly in the alias root yields the root key', () => {
    assert.equal(folderKeyForDir('Bilder'), '');
  });

  await t.test('a single subfolder', () => {
    assert.equal(folderKeyForDir('Bilder/Familie'), 'Familie');
  });

  await t.test('alias roots merge into the same virtual tree', () => {
    assert.equal(folderKeyForDir('Photos/Familie'), 'Familie');
    assert.equal(folderKeyForDir('Pictures/Familie'), 'Familie');
    assert.equal(folderKeyForDir('Bilder/Familie'), 'Familie');
  });

  await t.test('keys are case sensitive', () => {
    assert.equal(folderKeyForDir('Photos/familie'), 'familie');
    assert.notEqual(folderKeyForDir('Photos/familie'), folderKeyForDir('Bilder/Familie'));
  });

  await t.test('an empty dir yields the root key', () => {
    assert.equal(folderKeyForDir(''), '');
  });

  await t.test('a key never changes for deeper nesting under the same subtree', () => {
    assert.equal(
      folderKeyForDir('Bilder/Urlaub 2024/Italien/Tag 1 – Rom'),
      'Urlaub 2024/Italien/Tag 1 – Rom',
    );
  });
});

test('parseFolderKey', async (t) => {
  await t.test('an absent value is the root', () => {
    assert.equal(parseFolderKey(null), '');
  });

  await t.test('an empty value is the root', () => {
    assert.equal(parseFolderKey(''), '');
  });

  await t.test('a plain nested key is valid and returned unchanged', () => {
    assert.equal(parseFolderKey('Urlaub 2024/Italien'), 'Urlaub 2024/Italien');
  });

  await t.test('backslash is an ordinary, allowed character', () => {
    assert.equal(parseFolderKey('Fotos\\Urlaub'), 'Fotos\\Urlaub');
  });

  await t.test('rejects a "." segment', () => {
    assert.equal(parseFolderKey('Urlaub/./Italien'), null);
    assert.equal(parseFolderKey('.'), null);
  });

  await t.test('rejects a ".." segment', () => {
    assert.equal(parseFolderKey('Urlaub/../etc'), null);
    assert.equal(parseFolderKey('..'), null);
  });

  await t.test('rejects a doubled slash (empty segment)', () => {
    assert.equal(parseFolderKey('Urlaub//Italien'), null);
  });

  await t.test('rejects a leading slash', () => {
    assert.equal(parseFolderKey('/Urlaub'), null);
  });

  await t.test('rejects a trailing slash', () => {
    assert.equal(parseFolderKey('Urlaub/'), null);
  });

  await t.test('rejects a NUL byte anywhere in the value', () => {
    assert.equal(parseFolderKey('Urlaub\u0000'), null);
    assert.equal(parseFolderKey('\u0000'), null);
  });

  await t.test('accepts exactly 4096 UTF-16 units', () => {
    const key = 'a'.repeat(4096);
    assert.equal(parseFolderKey(key), key);
  });

  await t.test('rejects more than 4096 UTF-16 units', () => {
    const key = 'a'.repeat(4097);
    assert.equal(parseFolderKey(key), null);
  });
});
