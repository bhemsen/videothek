// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { reconcilePaths } from '../../src/library/reconcile.js';
import { createMediaTree, removeMediaTree, writeMediaFile, makeMediaDir } from '../helpers/media-tree.js';

// Split out of `reconcile.test.js` purely to keep that file under the
// constitution's 300-line limit: `canIgnoreTopLevel`'s "only a directory can
// be a category root" refinement, so churn from OS metadata files sitting
// directly at MEDIA_ROOT (`Thumbs.db`, `.DS_Store`) never triggers a full
// rescan the way a genuine top-level folder change must.

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

/** @param {string} root @param {import('node:sqlite').DatabaseSync} db */
function makeCtx(root, db) {
  return {
    db,
    mediaRoot: root,
    now: NOW,
    dirObserver: { seen() {}, gone() {}, sweep() {}, count: () => 0, closeAll() {} },
    scanSubtree: async () => ({ stats: emptyStats() }),
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
