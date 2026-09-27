// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { reconcilePaths } from '../../src/library/reconcile.js';
import { upsertItem, getItemByRelPath } from '../../src/db/library-repo.js';
import { createMediaTree, removeMediaTree, writeMediaFile, makeMediaDir } from '../helpers/media-tree.js';

// Split out of `reconcile.test.js` purely to keep that file under the
// constitution's 300-line limit: `canIgnoreTopLevel`'s "only a directory can
// be a category root" refinement, so churn from OS metadata files sitting
// directly at MEDIA_ROOT (`Thumbs.db`, `.DS_Store`) never triggers a full
// rescan the way a genuine top-level folder change must — plus the
// scanner-facing contract: `markTouched`, U+FFFD segments and the shared
// root-health "empty" definition (`root-health.js`).

const NOW = () => Date.UTC(2026, 8, 26);

/** @returns {import('node:sqlite').DatabaseSync} */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** @returns {import('../../src/library/reconcile.js').ReconcileStats} */
function emptyStats() {
  return { added: 0, updated: 0, removed: 0, unchanged: 0, failedDirs: 0, skippedSymlinks: 0, skippedUndecodable: 0, protectedRoots: 0 };
}

/** @param {string} root @param {import('node:sqlite').DatabaseSync} db @param {(relDir: string) => void} [markTouched] */
function makeCtx(root, db, markTouched = () => {}) {
  return {
    db,
    mediaRoot: root,
    now: NOW,
    dirObserver: { seen() {}, gone() {}, sweep() {}, count: () => 0, closeAll() {} },
    scanSubtree: async () => ({ stats: emptyStats() }),
    markTouched,
  };
}

test('reconcilePaths: only an existing top-level directory escalates, not a plain file or hidden name', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await makeMediaDir(root, 'Filme');
  await writeMediaFile(root, 'Thumbs.db');
  await writeMediaFile(root, '.DS_Store');
  const db = makeDb();

  assert.equal((await reconcilePaths(makeCtx(root, db), ['Filme'])).escalate, true);
  const { stats, escalate } = await reconcilePaths(makeCtx(root, db), ['Thumbs.db', '.DS_Store']);
  assert.equal(escalate, false);
  assert.deepEqual(stats, emptyStats());
});

/** @param {import('node:sqlite').DatabaseSync} db @param {string} relPath */
function seedRow(db, relPath) {
  const dir = relPath.slice(0, relPath.lastIndexOf('/'));
  upsertItem(db, { rel_path: relPath, dir, category: 'movies', kind: 'video', ext: 'webm', title: 'T', sort_title: 't', playable: true, size: 1, mtime_ms: 1, scan_version: 1 }, 1);
}

test('reconcilePaths: markTouched gets the parent dir of every added or unchanged file, never of a deleted one', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/New/a.webm');
  await writeMediaFile(root, 'Filme/keep.webm');
  const db = makeDb();
  seedRow(db, 'Filme/Gone/b.webm');
  /** @type {string[]} */
  const touched = [];
  const ctx = makeCtx(root, db, (dir) => touched.push(dir));

  await reconcilePaths(ctx, ['Filme/New/a.webm', 'Filme/Gone/b.webm']);
  await reconcilePaths(ctx, ['Filme/New/a.webm']);

  assert.deepEqual(touched, ['Filme/New', 'Filme/New']);
  assert.equal(getItemByRelPath(db, 'Filme/Gone/b.webm'), undefined);
});

test('reconcilePaths: a path with a U+FFFD segment is never indexed, and its stale row is deleted', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const bad = 'Filme/Bad�Name/movie.webm';
  try {
    await writeMediaFile(root, bad);
  } catch {
    t.skip('the OS forbids creating a U+FFFD name');
    return;
  }
  const db = makeDb();
  seedRow(db, 'Filme/Bad�Name/old.webm');

  const { stats } = await reconcilePaths(makeCtx(root, db), [bad, 'Filme/Bad�Name/old.webm']);

  assert.equal(stats.added, 0);
  assert.equal(getItemByRelPath(db, bad), undefined, 'the walk skips U+FFFD names, so a reconcile must too');
  assert.equal(getItemByRelPath(db, 'Filme/Bad�Name/old.webm'), undefined);
});

test('reconcilePaths: ENOENT under a root holding only a non-media file deletes (the root is not empty)', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/info.nfo');
  const db = makeDb();
  seedRow(db, 'Filme/Arrival.webm');

  const { escalate, stats } = await reconcilePaths(makeCtx(root, db), ['Filme/Arrival.webm']);

  assert.equal(escalate, false);
  assert.equal(stats.removed, 1);
});

test('reconcilePaths: ENOENT under a root holding only skipped entries escalates (the root is empty)', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/.DS_Store');
  await makeMediaDir(root, 'Filme/@eaDir');
  const db = makeDb();
  seedRow(db, 'Filme/Arrival.webm');

  const { escalate } = await reconcilePaths(makeCtx(root, db), ['Filme/Arrival.webm']);

  assert.equal(escalate, true);
  assert.ok(getItemByRelPath(db, 'Filme/Arrival.webm'), 'nothing is deleted; the full scan applies root safety');
});
