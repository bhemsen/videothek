// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixtureTree, buildBulkFixtures } from './make-audio-fixtures.js';
import { readId3v2 } from '../../src/library/tags/id3v2.js';
import { makeReadAt } from './mp3-fixture.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const committedRoot = path.join(repoRoot, 'test', 'fixtures', 'media');

/**
 * Recursively lists a directory's files as '/'-separated paths relative to `base`.
 * @param {string} base @param {string} [dir] @returns {string[]}
 */
function listRelFiles(base, dir = base) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listRelFiles(base, full));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/** Makes a fresh temp dir removed after the test. @param {import('node:test').TestContext} t @returns {string} */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-audio-fixtures-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('regenerating the fixture tree reproduces the committed tree byte for byte', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-audio-fixtures-'));
  try {
    buildFixtureTree(tmp);
    const committed = ['Musik', 'Hörbücher'].flatMap((c) => listRelFiles(path.join(committedRoot, c)).map((f) => `${c}/${f}`));
    const generated = ['Musik', 'Hörbücher'].flatMap((c) => listRelFiles(path.join(tmp, c)).map((f) => `${c}/${f}`));
    /** @param {string[]} list @returns {string[]} */
    const normalise = (list) => list.map((p) => p.normalize('NFC')).sort();
    assert.deepEqual(normalise(generated), normalise(committed));
    for (const rel of committed) {
      const committedBuf = fs.readFileSync(path.join(committedRoot, ...rel.split('/')));
      const generatedBuf = fs.readFileSync(path.join(tmp, ...rel.split('/')));
      assert.ok(committedBuf.equals(generatedBuf), `byte mismatch for ${rel}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('every committed path under test/fixtures/media/Musik and Hörbücher is already NFC-normalised', () => {
  const relPaths = ['Musik', 'Hörbücher'].flatMap((c) => listRelFiles(path.join(committedRoot, c)).map((f) => `${c}/${f}`));
  assert.ok(relPaths.length > 0);
  for (const rel of relPaths) {
    assert.equal(rel, rel.normalize('NFC'), `${rel} is not in NFC form`);
  }
});

test('the committed tree stays within the 10 MiB budget', () => {
  const relPaths = ['Musik', 'Hörbücher'].flatMap((c) => listRelFiles(path.join(committedRoot, c)).map((f) => `${c}/${f}`));
  const total = relPaths.reduce((sum, rel) => sum + fs.statSync(path.join(committedRoot, ...rel.split('/'))).size, 0);
  assert.ok(total <= 10 * 1024 * 1024, `tree is ${total} bytes, over the 10 MiB budget`);
});

test('--bulk 20 writes 20 tracks in 2 albums, one with a 256 KiB APIC', async (t) => {
  const dir = tempDir(t);
  buildBulkFixtures(20, dir);
  const files = listRelFiles(path.join(dir, 'Musik'));
  assert.equal(files.length, 20);
  const albums = new Set(files.map((f) => f.split('/').slice(0, 2).join('/')));
  assert.equal(albums.size, 2);
  for (const album of albums) {
    assert.equal(files.filter((f) => f.startsWith(`${album}/`)).length, 10);
  }
  const firstTrack = fs.readFileSync(path.join(dir, 'Musik', 'Bulk Interpret 1', 'Album 1', '01 Titel 01.mp3'));
  const tag = await readId3v2(makeReadAt(firstTrack));
  assert.ok(tag?.picture);
  assert.equal(tag?.picture?.length, 256 * 1024);
});
