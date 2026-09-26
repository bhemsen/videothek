import { test } from 'node:test';
import assert from 'node:assert/strict';

test('runs on Node.js 24 or newer', () => {
  const major = Number(process.versions.node.split('.')[0]);
  assert.ok(major >= 24, `Node.js ${process.versions.node} is below 24`);
});

test('node:sqlite is available without flags', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const row = db.prepare('select 1 as one').get();
  assert.equal(row?.one, 1);
  db.close();
});
