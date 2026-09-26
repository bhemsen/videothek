// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, rm, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createScanner } from '../../src/library/scanner.js';
import { createMediaTree, removeMediaTree, writeMediaFile, makeMediaDir } from '../helpers/media-tree.js';
import { NOW, fakeLog, testDb, setup, fakeDirObserver, tick, countItemsByDir, loadRow } from '../helpers/scanner-fixtures.js';

// Run-kind lifecycle (paths-run stats shape, interleaving, `stop()`,
// `onScanComplete`/listeners) and the fixture-tree smoke test live in
// `scanner-runs.test.js` — split out purely to keep each file under the
// constitution's 300-line limit.

test('createScanner: a first full scan indexes a small tree', async (t) => {
  const { root, db, scanner } = await setup(t);
  await writeMediaFile(root, 'Filme/Arrival (2016).webm');
  await writeMediaFile(root, 'Serien/Dark (2017)/Staffel 1/Dark S01E01 - Geheimnisse.webm');

  scanner.requestFull('initial'); await scanner.idle();

  assert.equal(countItemsByDir(db, 'Filme'), 1);
  assert.ok(loadRow(db, 'Serien/Dark (2017)/Staffel 1/Dark S01E01 - Geheimnisse.webm'));
  assert.equal(scanner.status().lastError, null);
  assert.ok(scanner.status().lastStats);
});

test('createScanner: a second full scan of 2 000 unchanged files in 200 dirs performs zero writes', async (t) => {
  const { root, db, scanner } = await setup(t);
  for (let d = 0; d < 200; d += 1) {
    for (let f = 0; f < 10; f += 1) {
      await writeMediaFile(root, `Filme/Dir${d}/Movie${f}.webm`);
    }
  }
  scanner.requestFull(); await scanner.idle();

  const changesBefore = /** @type {any} */ (db.prepare('SELECT total_changes() AS n').get()).n;
  scanner.requestFull(); await scanner.idle();
  const changesAfter = /** @type {any} */ (db.prepare('SELECT total_changes() AS n').get()).n;

  const stats = scanner.status().lastStats;
  assert.equal(stats?.added, 0);
  assert.equal(stats?.updated, 0);
  assert.equal(stats?.removed, 0);
  assert.equal(stats?.unchanged, 2000);
  assert.equal(changesAfter, changesBefore, 'the second scan must not touch the DB at all, not just report zero in its stats');
});

test('createScanner: a changed file is re-parsed keeping its id; a removed file is deleted', async (t) => {
  const { root, db, scanner } = await setup(t);
  await writeMediaFile(root, 'Filme/Arrival (2016).webm', { mtime: 1_700_000_000_000 });
  await writeMediaFile(root, 'Filme/Metropolis 1927.webm');
  scanner.requestFull(); await scanner.idle();
  const id1 = loadRow(db, 'Filme/Arrival (2016).webm').id;

  await writeMediaFile(root, 'Filme/Arrival (2016).webm', { content: 'changed', mtime: 1_700_000_001_000 });
  await unlink(join(root, 'Filme', 'Metropolis 1927.webm'));
  scanner.requestFull(); await scanner.idle();

  const row = loadRow(db, 'Filme/Arrival (2016).webm');
  assert.equal(row.id, id1);
  assert.equal(row.mtime_ms, 1_700_000_001_000);
  assert.equal(loadRow(db, 'Filme/Metropolis 1927.webm'), undefined);
  assert.equal(scanner.status().lastStats?.updated, 1);
  assert.equal(scanner.status().lastStats?.removed, 1);
});

test('createScanner: removing a whole subdirectory sweeps its rows', async (t) => {
  const { root, db, scanner } = await setup(t);
  await writeMediaFile(root, 'Filme/Foo/movie.webm');
  await writeMediaFile(root, 'Filme/Bar/movie.webm');
  scanner.requestFull(); await scanner.idle();
  assert.equal(countItemsByDir(db, 'Filme/Foo'), 1);

  await rm(join(root, 'Filme', 'Foo'), { recursive: true, force: true });
  scanner.requestFull(); await scanner.idle();

  assert.equal(countItemsByDir(db, 'Filme/Foo'), 0);
  assert.equal(countItemsByDir(db, 'Filme/Bar'), 1, 'the surviving sibling directory is untouched');
});

test('createScanner: a completed full scan calls dirObserver.sweep with the full visited set', async (t) => {
  const { dirObserver, sweepCalls } = fakeDirObserver();
  const { root, scanner } = await setup(t, { dirObserver });
  await writeMediaFile(root, 'Filme/AAA/movie.webm');
  await writeMediaFile(root, 'Filme/BBB/movie.webm');
  await writeMediaFile(root, 'Serien/Show/Staffel 1/e01.webm');

  scanner.requestFull(); await scanner.idle();

  assert.equal(sweepCalls.length, 1, 'sweep must be called exactly once, after the DB sweep and orphan cleanup');
  const visited = sweepCalls[0];
  assert.ok(visited.has('Filme'));
  assert.ok(visited.has('Filme/AAA'));
  assert.ok(visited.has('Filme/BBB'));
  assert.ok(visited.has('Serien'));
  assert.ok(visited.has('Serien/Show'));
  assert.ok(visited.has('Serien/Show/Staffel 1'));
});

test('createScanner: an unreadable directory keeps its rows (POSIX only)', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX chmod semantics are not enforced on Windows');
    return;
  }
  const { root, db, calls, scanner } = await setup(t);
  const dir = await makeMediaDir(root, 'Filme/Locked');
  await writeMediaFile(root, 'Filme/Locked/movie.webm');
  scanner.requestFull(); await scanner.idle();

  await chmod(dir, 0o000);
  t.after(() => chmod(dir, 0o755));
  scanner.requestFull(); await scanner.idle();

  assert.equal(countItemsByDir(db, 'Filme/Locked'), 1, 'row survives an unreadable directory');
  assert.equal(scanner.status().lastError, 'dir_failed');
  assert.ok(calls.warn.some((c) => c.event === 'library_dir_failed'));
});

test("createScanner: a paths run carries a nested subtree scan's failedDirs into its own stats and lastError (POSIX only)", async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX chmod semantics are not enforced on Windows');
    return;
  }
  const { root, db, scanner } = await setup(t);
  const dir = await makeMediaDir(root, 'Filme/Coll/Locked');
  await writeMediaFile(root, 'Filme/Coll/Locked/movie.webm');
  await writeMediaFile(root, 'Filme/Coll/Other.webm');
  scanner.requestFull(); await scanner.idle();
  assert.equal(scanner.status().lastError, null);

  await chmod(dir, 0o000);
  t.after(() => chmod(dir, 0o755));

  scanner.requestPaths(['Filme/Coll']);
  await scanner.idle();

  assert.equal(countItemsByDir(db, 'Filme/Coll/Locked'), 1, 'row survives an unreadable directory reached via a paths reconcile');
  const stats = scanner.status().lastStats;
  assert.equal(stats?.failedDirs, 1, "the subtree scan's failedDirs count must reach the top-level paths run stats");
  assert.equal(scanner.status().lastError, 'dir_failed', 'a paths run must update lastError like every other run kind');
});

test('createScanner: an unreadable MEDIA_ROOT aborts without changes and never fires onScanComplete', async (t) => {
  const { calls, scanner } = await setup(t, { mediaRootFor: (root) => join(root, 'does-not-exist') });
  /** @type {any[]} */
  const fired = [];
  scanner.onScanComplete((payload) => {
    fired.push(payload);
  });

  scanner.requestFull(); await scanner.idle();
  await tick();

  assert.equal(scanner.status().lastError, 'media_root_unreadable');
  assert.ok(calls.warn.some((c) => c.event === 'library_scan_failed'));
  assert.deepEqual(fired, []);
});

test('createScanner: an emptied then a removed category root protect rows across scans', async (t) => {
  const { root, db, calls, scanner } = await setup(t);
  await writeMediaFile(root, 'Filme/A.webm');
  await writeMediaFile(root, 'Filme/B.webm');
  scanner.requestFull(); await scanner.idle();
  assert.equal(countItemsByDir(db, 'Filme'), 2);

  await unlink(join(root, 'Filme', 'A.webm'));
  await unlink(join(root, 'Filme', 'B.webm'));
  scanner.requestFull(); await scanner.idle();

  assert.equal(countItemsByDir(db, 'Filme'), 2, 'an emptied root deletes nothing');
  assert.equal(scanner.status().lastError, 'root_protected');
  assert.ok(calls.warn.some((c) => c.event === 'library_root_protected' && c.fields.reason === 'empty'));

  await rmdir(join(root, 'Filme'));
  scanner.requestFull(); await scanner.idle();

  assert.equal(countItemsByDir(db, 'Filme'), 2, 'a removed root deletes nothing');
  assert.equal(scanner.status().lastError, 'root_protected');
  assert.ok(calls.warn.some((c) => c.event === 'library_root_protected' && c.fields.reason === 'missing'));
});

test('createScanner: a fresh scanner (process restart) still protects a root that is already missing from its very first scan', async (t) => {
  // Simulates D7's "disk unmounted before the process (re)started" case: the
  // scanner has no prior in-process state at all, only what a previous
  // process already wrote to the DB — MEDIA_ROOT itself is present (an
  // empty temp dir, standing in for a readable, empty mount point), but the
  // 'Filme' category folder is entirely absent from it.
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const db = testDb();
  db
    .prepare(
      `INSERT INTO library_items (
        rel_path, dir, category, kind, ext, title, sort_title, playable,
        size, mtime_ms, scan_version, added_at, scanned_at
      ) VALUES (?, ?, 'movies', 'video', 'webm', 'Arrival', 'arrival', 1, 100, 1, 1, 0, 0)`
    )
    .run('Filme/Arrival (2016).webm', 'Filme');
  const { log, calls } = fakeLog();
  const scanner = createScanner({ db, mediaRoot: root, log, now: NOW });

  scanner.requestFull('initial'); await scanner.idle();

  assert.ok(loadRow(db, 'Filme/Arrival (2016).webm'), 'the row from before the restart is protected, not deleted');
  assert.equal(scanner.status().lastError, 'root_protected');
  assert.ok(calls.warn.some((c) => c.event === 'library_root_protected' && c.fields.root === 'Filme' && c.fields.reason === 'missing'));
});
