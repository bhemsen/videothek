/**
 * Folder-key validation and scale checks for `GET /api/gallery`, split out of
 * `gallery.test.js` to stay under the constitution's 300-line-per-file limit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertItem } from '../helpers/image-meta-seed.js';
import { insertMetaStubs } from '../../src/db/image-meta.js';
import { startTestApp } from '../helpers/app.js';
import { get } from './gallery-test-helpers.js';

test('a 5,000-item folder returns all items in one response (no server-side pagination)', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('julia', 'ein-sicheres-passwort');
    const cookie = await app.login('julia', 'ein-sicheres-passwort');
    const { db } = app;
    const total = 5000;
    db.exec('BEGIN');
    for (let i = 0; i < total; i++) {
      insertItem(db, { rel_path: `Bilder/Bulk/item-${i}.jpg`, dir: 'Bilder/Bulk' });
    }
    db.exec('COMMIT');
    const ids = /** @type {{ id: number }[]} */ (
      db.prepare("SELECT id FROM library_items WHERE dir = 'Bilder/Bulk'").all()
    );
    assert.equal(ids.length, total, 'sanity check: every row was actually inserted under Bilder/Bulk');
    insertMetaStubs(db, ids.map((row) => ({ itemId: row.id, folder: 'Bulk' })));

    const res = await get(app.baseUrl, `/api/gallery?folder=${encodeURIComponent('Bulk')}`, { Cookie: cookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, total);
  } finally {
    await app.close();
  }
});

test('invalid or unknown folder keys answer 404 {"error":"not_found"}', async (t) => {
  const app = await startTestApp();
  try {
    await app.createUser('julia', 'ein-sicheres-passwort');
    const cookie = await app.login('julia', 'ein-sicheres-passwort');

    /** @type {[string, string][]} */
    const cases = [
      ['..', '..'],
      ['.', '.'],
      ['//', '//'],
      ['leading slash', '/A'],
      ['trailing slash', 'A/'],
      ['NUL byte', 'A\u0000B'],
      ['over 4096 chars', 'a'.repeat(4097)],
      ['unknown existing-looking key', 'Does/Not/Exist'],
    ];
    for (const [label, value] of cases) {
      await t.test(label, async () => {
        const res = await get(app.baseUrl, `/api/gallery?folder=${encodeURIComponent(value)}`, { Cookie: cookie });
        assert.equal(res.status, 404, label);
        assert.deepEqual(res.body, { error: 'not_found' }, label);
      });
    }
  } finally {
    await app.close();
  }
});
