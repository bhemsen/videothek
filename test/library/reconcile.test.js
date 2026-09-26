// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { unlink } from 'node:fs/promises';
import { migrate } from '../../src/db/migrate.js';
import { reconcilePaths } from '../../src/library/reconcile.js';
import { upsertItem } from '../../src/db/library-repo.js';
import { createMediaTree, removeMediaTree, writeMediaFile, makeMediaDir } from '../helpers/media-tree.js';

const NOW = () => Date.UTC(2026, 8, 26);

/** @returns {import('node:sqlite').DatabaseSync} */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** @returns {{ goneCalls: string[], dirObserver: import('../../src/library/dir-watch.js').DirWatchSet }} */
function fakeDirObserver() {
  /** @type {string[]} */
  const goneCalls = [];
  return {
    goneCalls,
    dirObserver: {
      seen() {},
      gone: (relDir) => goneCalls.push(relDir),
      sweep() {},
      count: () => 0,
      closeAll() {},
    },
  };
}

/** @returns {import('../../src/library/reconcile.js').ReconcileStats} */
function emptyStats() {
  return { added: 0, updated: 0, removed: 0, unchanged: 0, failedDirs: 0, skippedSymlinks: 0, skippedUndecodable: 0, protectedRoots: 0 };
}

/**
 * @param {string} root
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Partial<import('../../src/library/reconcile.js').ReconcileCtx>} [overrides]
 */
function makeCtx(root, db, overrides = {}) {
  const { dirObserver } = fakeDirObserver();
  return {
    db,
    mediaRoot: root,
    now: NOW,
    dirObserver,
    scanSubtree: async () => ({ stats: emptyStats() }),
    ...overrides,
  };
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} relPath */
function loadRow(db, relPath) {
  return /** @type {any} */ (db.prepare('SELECT * FROM library_items WHERE rel_path = ?').get(relPath));
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} relPath @param {string} title */
function seedRow(db, relPath, title) {
  upsertItem(
    db,
    { rel_path: relPath, dir: 'Filme', category: 'movies', kind: 'video', ext: 'webm', title, sort_title: title.toLowerCase(), playable: true, size: 1, mtime_ms: 1, scan_version: 1 },
    1
  );
}

test('reconcilePaths: MEDIA_ROOT itself ("") escalates', async () => {
  const db = makeDb();
  const { stats, escalate } = await reconcilePaths(makeCtx('/media', db), ['']);
  assert.equal(escalate, true);
  assert.deepEqual(stats, emptyStats());
});

test('reconcilePaths: a top-level folder escalates', async () => {
  const db = makeDb();
  const { escalate } = await reconcilePaths(makeCtx('/media', db), ['Filme']);
  assert.equal(escalate, true);
});

test('reconcilePaths: a path outside every category root is ignored', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const db = makeDb();

  const { stats, escalate } = await reconcilePaths(makeCtx(root, db), ['Downloads/file.mp4']);

  assert.equal(escalate, false);
  assert.deepEqual(stats, emptyStats());
});

test('reconcilePaths: a new regular file is added', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/Arrival (2016).webm');
  const db = makeDb();

  const { stats, escalate } = await reconcilePaths(makeCtx(root, db), ['Filme/Arrival (2016).webm']);

  assert.equal(escalate, false);
  assert.equal(stats.added, 1);
  assert.ok(loadRow(db, 'Filme/Arrival (2016).webm'));
});

test('reconcilePaths: an unchanged regular file is left alone', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/Arrival (2016).webm');
  const db = makeDb();
  const ctx = makeCtx(root, db);
  await reconcilePaths(ctx, ['Filme/Arrival (2016).webm']);

  const { stats } = await reconcilePaths(ctx, ['Filme/Arrival (2016).webm']);

  assert.deepEqual(stats, { ...emptyStats(), unchanged: 1 });
});

test('reconcilePaths: a changed regular file is re-parsed and keeps its id', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/Arrival (2016).webm', { mtime: 1_700_000_000_000 });
  const db = makeDb();
  const ctx = makeCtx(root, db);
  await reconcilePaths(ctx, ['Filme/Arrival (2016).webm']);
  const id1 = loadRow(db, 'Filme/Arrival (2016).webm').id;

  await writeMediaFile(root, 'Filme/Arrival (2016).webm', { content: 'new bytes', mtime: 1_700_000_001_000 });
  const { stats } = await reconcilePaths(ctx, ['Filme/Arrival (2016).webm']);

  assert.equal(stats.updated, 1);
  assert.equal(loadRow(db, 'Filme/Arrival (2016).webm').id, id1);
});

test('reconcilePaths: ENOENT under a healthy root deletes the row and calls dirObserver.gone', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const path = await writeMediaFile(root, 'Filme/Arrival (2016).webm');
  await writeMediaFile(root, 'Filme/Other.webm'); // keeps the root non-empty
  const db = makeDb();
  const { dirObserver, goneCalls } = fakeDirObserver();
  const ctx = makeCtx(root, db, { dirObserver });
  await reconcilePaths(ctx, ['Filme/Arrival (2016).webm']);
  await unlink(path);

  const { stats, escalate } = await reconcilePaths(ctx, ['Filme/Arrival (2016).webm']);

  assert.equal(escalate, false);
  assert.equal(stats.removed, 1);
  assert.equal(loadRow(db, 'Filme/Arrival (2016).webm'), undefined);
  assert.deepEqual(goneCalls, ['Filme/Arrival (2016).webm']);
});

test('reconcilePaths: ENOENT under a missing category root escalates instead of deleting', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const db = makeDb();
  seedRow(db, 'Filme/Arrival (2016).webm', 'Arrival');
  // "Filme" was never created on disk at all -> root is missing.

  const { escalate } = await reconcilePaths(makeCtx(root, db), ['Filme/Arrival (2016).webm']);

  assert.equal(escalate, true);
  assert.ok(loadRow(db, 'Filme/Arrival (2016).webm'), 'row must survive, the full scan applies root safety');
});

test('reconcilePaths: any other lstat error keeps the row', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/Arrival (2016).webm');
  const db = makeDb();
  const ctx = makeCtx(root, db);
  await reconcilePaths(ctx, ['Filme/Arrival (2016).webm']);
  const before = loadRow(db, 'Filme/Arrival (2016).webm');

  // A path segment that is itself a file makes ENOTDIR bubble out of lstat,
  // a stand-in for "any other lstat error" without needing OS permissions.
  const { stats, escalate } = await reconcilePaths(ctx, ['Filme/Arrival (2016).webm/impossible.webm']);

  assert.equal(escalate, false);
  assert.deepEqual(stats, emptyStats());
  assert.deepEqual(loadRow(db, 'Filme/Arrival (2016).webm'), before);
});

test('reconcilePaths: a directory delegates to ctx.scanSubtree and aggregates its stats', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await makeMediaDir(root, 'Filme/Inception (2010)');
  const db = makeDb();
  /** @type {string[]} */
  const calls = [];
  const ctx = makeCtx(root, db, {
    scanSubtree: async (relDir) => {
      calls.push(relDir);
      return { stats: { ...emptyStats(), added: 2, updated: 1, unchanged: 3, failedDirs: 1 } };
    },
  });

  const { stats, escalate } = await reconcilePaths(ctx, ['Filme/Inception (2010)']);

  assert.equal(escalate, false);
  assert.deepEqual(calls, ['Filme/Inception (2010)']);
  assert.deepEqual(stats, { ...emptyStats(), added: 2, updated: 1, unchanged: 3, failedDirs: 1 });
});

test('reconcilePaths: a symlink deletes existing rows and calls dirObserver.gone', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const db = makeDb();
  seedRow(db, 'Filme/Link.webm', 'Link');
  await makeMediaDir(root, 'Filme');
  const target = await writeMediaFile(root, 'Filme/Real.webm');
  const { symlink } = await import('node:fs/promises');
  try {
    await symlink(target, `${root}/Filme/Link.webm`);
  } catch {
    t.skip('symlink creation requires elevated privileges on this platform');
    return;
  }
  const { dirObserver, goneCalls } = fakeDirObserver();

  const { stats } = await reconcilePaths(makeCtx(root, db, { dirObserver }), ['Filme/Link.webm']);

  assert.equal(stats.removed, 1);
  assert.equal(loadRow(db, 'Filme/Link.webm'), undefined);
  assert.deepEqual(goneCalls, ['Filme/Link.webm']);
});

test('reconcilePaths: a hidden (skipped) name deletes any existing row', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/.hidden.webm');
  const db = makeDb();
  seedRow(db, 'Filme/.hidden.webm', 'Hidden');

  const { stats } = await reconcilePaths(makeCtx(root, db), ['Filme/.hidden.webm']);

  assert.equal(stats.removed, 1);
  assert.equal(loadRow(db, 'Filme/.hidden.webm'), undefined);
});

test('reconcilePaths: a path under a skipped ancestor directory is never lstat\'d, indexed or descended into', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/.hidden/movie.webm');
  const db = makeDb();
  seedRow(db, 'Filme/.hidden/movie.webm', 'Movie');
  let scanSubtreeCalled = false;
  const ctx = makeCtx(root, db, { scanSubtree: async () => { scanSubtreeCalled = true; return { stats: emptyStats() }; } });

  const { stats, escalate } = await reconcilePaths(ctx, ['Filme/.hidden/movie.webm']);

  assert.equal(escalate, false);
  assert.equal(stats.removed, 1, 'a row under a skipped ancestor is removed, matching "never indexed"');
  assert.equal(loadRow(db, 'Filme/.hidden/movie.webm'), undefined);
  assert.equal(scanSubtreeCalled, false, 'the ancestor is skipped before any stat/scanSubtree call, not descended into');
});

test('reconcilePaths: a path segment of ".." is treated as unsafe/skipped, never lstat\'d', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const db = makeDb();
  let scanSubtreeCalled = false;
  const ctx = makeCtx(root, db, { scanSubtree: async () => { scanSubtreeCalled = true; return { stats: emptyStats() }; } });

  const { stats, escalate } = await reconcilePaths(ctx, ['Filme/../../../etc/passwd']);

  assert.equal(escalate, false);
  assert.deepEqual(stats, emptyStats());
  assert.equal(scanSubtreeCalled, false);
});

test('reconcilePaths: a series episode resolves its series_id', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Serien/Dark (2017)/Staffel 1/Dark S01E01 - Geheimnisse.webm');
  const db = makeDb();

  await reconcilePaths(makeCtx(root, db), ['Serien/Dark (2017)/Staffel 1/Dark S01E01 - Geheimnisse.webm']);

  const item = loadRow(db, 'Serien/Dark (2017)/Staffel 1/Dark S01E01 - Geheimnisse.webm');
  assert.ok(item.series_id);
});

test('reconcilePaths: processes every path in a batch even when one escalates', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/Arrival (2016).webm');
  const db = makeDb();

  const { stats, escalate } = await reconcilePaths(makeCtx(root, db), ['Filme', 'Filme/Arrival (2016).webm']);

  assert.equal(escalate, true);
  assert.equal(stats.added, 1);
});
