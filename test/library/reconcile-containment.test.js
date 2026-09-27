// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { migrate } from '../../src/db/migrate.js';
import { reconcilePaths } from '../../src/library/reconcile.js';
import { upsertItem, getItemByRelPath } from '../../src/db/library-repo.js';
import { createMediaTree, removeMediaTree, writeMediaFile, makeMediaDir } from '../helpers/media-tree.js';

// Split out of `reconcile.test.js` (300-line limit): a path reported through
// a symlinked ancestor (native recursive watchers follow links the walk never
// descends into) and the row-count unit of `stats.removed` for a subtree.

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

/** @param {string} root @param {import('node:sqlite').DatabaseSync} db @param {string[]} goneCalls */
function makeCtx(root, db, goneCalls) {
  return {
    db,
    mediaRoot: root,
    now: NOW,
    dirObserver: { seen() {}, gone: (/** @type {string} */ d) => void goneCalls.push(d), sweep() {}, count: () => 0, closeAll() {} },
    scanSubtree: async () => ({ stats: emptyStats() }),
    markTouched() {},
  };
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} relPath */
function seedRow(db, relPath) {
  const dir = relPath.slice(0, relPath.lastIndexOf('/'));
  upsertItem(
    db,
    { rel_path: relPath, dir, category: 'movies', kind: 'video', ext: 'webm', title: 'T', sort_title: 't', playable: true, size: 1, mtime_ms: 1, scan_version: 1 },
    1
  );
}

/**
 * Creates a directory link (a junction on Windows, which needs no elevated
 * privileges and which `lstat` reports as a symlink).
 * @param {string} target @param {string} linkPath @returns {Promise<boolean>} false when unsupported
 */
async function linkDir(target, linkPath) {
  try {
    await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

test('reconcilePaths: a file under a symlinked intermediate directory is never indexed', async (t) => {
  const root = await createMediaTree();
  const outside = await createMediaTree();
  t.after(() => Promise.all([removeMediaTree(root), removeMediaTree(outside)]));
  await writeMediaFile(outside, 'Arrival (2016).webm');
  await makeMediaDir(root, 'Filme');
  if (!(await linkDir(outside, join(root, 'Filme', 'Linked')))) return t.skip('directory links unsupported here');
  const db = makeDb();
  /** @type {string[]} */
  const goneCalls = [];

  const { stats, escalate } = await reconcilePaths(makeCtx(root, db, goneCalls), ['Filme/Linked/Arrival (2016).webm']);

  assert.equal(escalate, false);
  assert.equal(stats.added, 0, 'lstat on the last segment alone would have indexed a file outside MEDIA_ROOT');
  assert.equal(getItemByRelPath(db, 'Filme/Linked/Arrival (2016).webm'), undefined);
  assert.deepEqual(goneCalls, ['Filme/Linked/Arrival (2016).webm']);
});

test('reconcilePaths: a file under a symlinked category root is never indexed', async (t) => {
  const root = await createMediaTree();
  const outside = await createMediaTree();
  t.after(() => Promise.all([removeMediaTree(root), removeMediaTree(outside)]));
  await writeMediaFile(outside, 'x.webm');
  if (!(await linkDir(outside, join(root, 'Filme')))) return t.skip('directory links unsupported here');
  const db = makeDb();

  const { stats } = await reconcilePaths(makeCtx(root, db, []), ['Filme/x.webm']);

  assert.equal(stats.added, 0);
  assert.equal(getItemByRelPath(db, 'Filme/x.webm'), undefined);
});

test('reconcilePaths: a regular (non-linked) nested file is still indexed', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/Sub/Deep/Heat (1995).webm');
  const db = makeDb();

  const { stats } = await reconcilePaths(makeCtx(root, db, []), ['Filme/Sub/Deep/Heat (1995).webm']);

  assert.equal(stats.added, 1, 'the ancestor check must not reject ordinary directories');
});

test('reconcilePaths: a deleted directory counts every removed row, the same unit as the full-scan sweep', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/keep.webm'); // keeps the root healthy
  await makeMediaDir(root, 'Filme/Box');
  const db = makeDb();
  seedRow(db, 'Filme/Box/a.webm');
  seedRow(db, 'Filme/Box/b.webm');
  seedRow(db, 'Filme/Box/Deep/c.webm');
  await rm(join(root, 'Filme', 'Box'), { recursive: true });

  const { stats } = await reconcilePaths(makeCtx(root, db, []), ['Filme/Box']);

  assert.equal(stats.removed, 3);
  assert.equal(getItemByRelPath(db, 'Filme/Box/Deep/c.webm'), undefined);
});
