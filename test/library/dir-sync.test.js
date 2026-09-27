// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { syncDirectory, upsertBuiltRow } from '../../src/library/dir-sync.js';
import { SCAN_VERSION } from '../../src/library/parsers/compat.js';
import { createMediaTree, removeMediaTree, writeMediaFile } from '../helpers/media-tree.js';

const NOW = () => Date.UTC(2026, 8, 26);

/** @returns {import('node:sqlite').DatabaseSync} an in-memory DB with all migrations applied */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} relPath */
function loadRow(db, relPath) {
  return /** @type {any} */ (db.prepare('SELECT * FROM library_items WHERE rel_path = ?').get(relPath));
}

test('syncDirectory: first scan indexes new files and returns subdirectory names', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/Arrival (2016).webm');
  await writeMediaFile(root, 'Filme/Metropolis 1927.webm');
  const { promises: fs } = await import('node:fs');
  await fs.mkdir(`${root}/Filme/Inception (2010)`, { recursive: true });
  const db = makeDb();

  const { stats, dirs } = await syncDirectory({ db, mediaRoot: root, now: NOW }, 'Filme');

  assert.equal(stats.added, 2);
  assert.equal(stats.updated, 0);
  assert.equal(stats.removed, 0);
  assert.equal(stats.unchanged, 0);
  assert.deepEqual(dirs.sort(), ['Inception (2010)']);
  assert.ok(loadRow(db, 'Filme/Arrival (2016).webm'));
  assert.ok(loadRow(db, 'Filme/Metropolis 1927.webm'));
});

test('syncDirectory: a second scan of unchanged files performs zero writes', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/Arrival (2016).webm');
  const db = makeDb();
  const ctx = { db, mediaRoot: root, now: NOW };

  await syncDirectory(ctx, 'Filme');
  const { stats } = await syncDirectory(ctx, 'Filme');

  assert.deepEqual(stats, {
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 1,
    skippedSymlinks: 0,
    skippedUndecodable: 0,
  });
});

test('syncDirectory: an unchanged sniff-table file is never re-sniffed', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const { moovBox } = await import('../helpers/mp4-boxes.js');
  const content = moovBox([{ handlerType: 'vide', fourcc: 'avc1' }]);
  const mtime = 1_700_000_000_000;
  await writeMediaFile(root, 'Filme/Heat (1995).mp4', { content, mtime });
  const db = makeDb();
  const ctx = { db, mediaRoot: root, now: NOW };
  await syncDirectory(ctx, 'Filme');
  assert.equal(loadRow(db, 'Filme/Heat (1995).mp4').video_codec, 'avc1');

  // Same size, same mtime, but different bytes (hvc1 instead of avc1) — if
  // the file were re-sniffed, video_codec would flip to hvc1.
  const sameLength = moovBox([{ handlerType: 'vide', fourcc: 'hvc1' }]);
  assert.equal(sameLength.length, content.length, 'test fixture must keep the same byte length');
  await writeMediaFile(root, 'Filme/Heat (1995).mp4', { content: sameLength, mtime });

  const { stats } = await syncDirectory(ctx, 'Filme');
  assert.equal(stats.unchanged, 1);
  assert.equal(loadRow(db, 'Filme/Heat (1995).mp4').video_codec, 'avc1', 'not re-sniffed');
});

test('syncDirectory: a changed file is re-parsed but keeps its id', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/Arrival (2016).webm', { mtime: 1_700_000_000_000 });
  const db = makeDb();
  const ctx = { db, mediaRoot: root, now: NOW };
  await syncDirectory(ctx, 'Filme');
  const id1 = loadRow(db, 'Filme/Arrival (2016).webm').id;

  await writeMediaFile(root, 'Filme/Arrival (2016).webm', {
    content: 'longer content now',
    mtime: 1_700_000_001_000,
  });
  const { stats } = await syncDirectory(ctx, 'Filme');

  assert.equal(stats.updated, 1);
  const row = loadRow(db, 'Filme/Arrival (2016).webm');
  assert.equal(row.id, id1);
  assert.equal(row.mtime_ms, 1_700_000_001_000);
});

test('syncDirectory: a stale scan_version forces a re-parse even without a file change', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/Arrival (2016).webm');
  const db = makeDb();
  const ctx = { db, mediaRoot: root, now: NOW };
  await syncDirectory(ctx, 'Filme');
  const id1 = loadRow(db, 'Filme/Arrival (2016).webm').id;
  db.prepare('UPDATE library_items SET scan_version = ? WHERE rel_path = ?').run(SCAN_VERSION - 1, 'Filme/Arrival (2016).webm');

  const { stats } = await syncDirectory(ctx, 'Filme');

  assert.equal(stats.updated, 1);
  assert.equal(loadRow(db, 'Filme/Arrival (2016).webm').scan_version, SCAN_VERSION);
  assert.equal(loadRow(db, 'Filme/Arrival (2016).webm').id, id1, 'the re-parse keeps the id');
});

test('syncDirectory: a removed file is deleted', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const path = await writeMediaFile(root, 'Filme/Arrival (2016).webm');
  const db = makeDb();
  const ctx = { db, mediaRoot: root, now: NOW };
  await syncDirectory(ctx, 'Filme');
  const { unlink } = await import('node:fs/promises');
  await unlink(path);

  const { stats } = await syncDirectory(ctx, 'Filme');

  assert.equal(stats.removed, 1);
  assert.equal(loadRow(db, 'Filme/Arrival (2016).webm'), undefined);
});

test('syncDirectory: a file whose stat fails with a non-ENOENT error keeps its existing row', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/Arrival (2016).webm');
  const db = makeDb();
  const ctx = { db, mediaRoot: root, now: NOW };
  await syncDirectory(ctx, 'Filme');
  const before = loadRow(db, 'Filme/Arrival (2016).webm');

  const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const fs = await import('node:fs/promises');
  const statFn = (/** @type {string} */ absPath) =>
    absPath.endsWith('Arrival (2016).webm') ? Promise.reject(eacces) : fs.stat(absPath);

  const { stats } = await syncDirectory({ ...ctx, statFn }, 'Filme');

  assert.equal(stats.added, 0);
  assert.equal(stats.updated, 0);
  assert.equal(stats.removed, 0);
  assert.deepEqual(loadRow(db, 'Filme/Arrival (2016).webm'), before);
});

test('syncDirectory: a known extension whose kind is not admitted by the category is ignored', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/soundtrack.mp3'); // audio, not admitted under movies
  const db = makeDb();

  const { stats } = await syncDirectory({ db, mediaRoot: root, now: NOW }, 'Filme');

  assert.equal(stats.added, 0);
  assert.equal(loadRow(db, 'Filme/soundtrack.mp3'), undefined);
});

test('syncDirectory + upsertBuiltRow: a series episode resolves and stores its series_id', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Serien/Dark (2017)/Staffel 1/Dark S01E01 - Geheimnisse.webm');
  const db = makeDb();

  await syncDirectory({ db, mediaRoot: root, now: NOW }, 'Serien/Dark (2017)/Staffel 1');

  const item = loadRow(db, 'Serien/Dark (2017)/Staffel 1/Dark S01E01 - Geheimnisse.webm');
  assert.ok(item.series_id);
  const series = /** @type {any} */ (db.prepare('SELECT * FROM library_series WHERE id = ?').get(item.series_id));
  assert.equal(series.title, 'Dark');
  assert.equal(series.year, 2017);
});

test('upsertBuiltRow: exported for reuse by reconcile.js, resolves series_id the same way', async () => {
  const db = makeDb();
  const row = /** @type {any} */ ({
    rel_path: 'Serien/Dark/S01E01.mp4',
    dir: 'Serien/Dark',
    category: 'series',
    kind: 'video',
    ext: 'mp4',
    title: 'Geheimnisse',
    sort_title: 'geheimnisse',
    playable: true,
    size: 1,
    mtime_ms: 1,
    scan_version: SCAN_VERSION,
    series_key: 'Dark',
    series_title: 'Dark',
    series_year: 2017,
  });

  const id = upsertBuiltRow(db, row, 1);

  assert.ok(row.series_id);
  const stored = /** @type {any} */ (db.prepare('SELECT * FROM library_items WHERE id = ?').get(id));
  assert.equal(stored.series_id, row.series_id);
});
