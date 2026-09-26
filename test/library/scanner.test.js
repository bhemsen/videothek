// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmod, rm, rmdir, stat as fsStat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { migrate } from '../../src/db/migrate.js';
import { createScanner } from '../../src/library/scanner.js';
import { createMediaTree, removeMediaTree, writeMediaFile, makeMediaDir } from '../helpers/media-tree.js';

const NOW = () => Date.UTC(2026, 8, 26);

/** @returns {{ log: import('../../src/library/dir-watch.js').Logger, calls: { info: any[], warn: any[], error: any[] } }} */
function fakeLog() {
  const calls = { info: /** @type {any[]} */ ([]), warn: /** @type {any[]} */ ([]), error: /** @type {any[]} */ ([]) };
  return {
    calls,
    log: {
      info: (event, fields) => calls.info.push({ event, fields }),
      warn: (event, fields) => calls.warn.push({ event, fields }),
      error: (event, fields) => calls.error.push({ event, fields }),
    },
  };
}

/** @returns {import('node:sqlite').DatabaseSync} */
function testDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** Builds a fresh temp media tree, in-memory DB and scanner for one test.
 * @param {import('node:test').TestContext} t
 * @param {{ mediaRootFor?: (root: string) => string, statFn?: import('../../src/library/walk.js').StatFn }} [opts]
 * @returns {Promise<{ root: string, db: import('node:sqlite').DatabaseSync, calls: ReturnType<typeof fakeLog>['calls'], scanner: ReturnType<typeof createScanner> }>} */
async function setup(t, { mediaRootFor, statFn } = {}) {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const db = testDb();
  const { log, calls } = fakeLog();
  const scanner = createScanner({ db, mediaRoot: mediaRootFor ? mediaRootFor(root) : root, log, now: NOW, statFn });
  return { root, db, calls, scanner };
}

/** @returns {Promise<void>} lets a pending `setImmediate` (the onScanComplete dispatch) run */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} dir */
function countItemsByDir(db, dir) {
  return /** @type {any} */ (db.prepare('SELECT count(*) AS n FROM library_items WHERE dir = ?').get(dir)).n;
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} relPath */
function loadRow(db, relPath) {
  return /** @type {any} */ (db.prepare('SELECT * FROM library_items WHERE rel_path = ?').get(relPath));
}

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

test('createScanner: a second full scan of unchanged files performs zero writes', async (t) => {
  const { root, scanner } = await setup(t);
  for (let d = 0; d < 20; d += 1) {
    for (let f = 0; f < 10; f += 1) {
      await writeMediaFile(root, `Filme/Dir${d}/Movie${f}.webm`);
    }
  }
  scanner.requestFull(); await scanner.idle();

  scanner.requestFull(); await scanner.idle();

  const stats = scanner.status().lastStats;
  assert.equal(stats?.added, 0);
  assert.equal(stats?.updated, 0);
  assert.equal(stats?.removed, 0);
  assert.equal(stats?.unchanged, 200);
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

test('createScanner: reconciling a path under a removed root escalates to a full scan', async (t) => {
  const { root, db, calls, scanner } = await setup(t);
  await writeMediaFile(root, 'Filme/Arrival (2016).webm');
  scanner.requestFull(); await scanner.idle();
  await rm(join(root, 'Filme'), { recursive: true, force: true });

  scanner.requestPaths(['Filme/Arrival (2016).webm']);
  await scanner.idle();

  assert.ok(
    calls.info.some((c) => c.event === 'library_scan_complete' && c.fields.kind === 'full'),
    'the escalation produced a follow-up full run'
  );
  assert.ok(loadRow(db, 'Filme/Arrival (2016).webm'), 'root safety protects the row');
  assert.equal(scanner.status().lastError, 'root_protected');
});

test('createScanner: a reconcile interleaved into a running full scan survives its sweep', async (t) => {
  const { stat: realStat } = await import('node:fs/promises');
  let injected = false;
  /** @type {{ scanner?: ReturnType<typeof createScanner> }} */
  const holder = {};
  /** @param {string} absPath */
  const statFn = async (absPath) => {
    if (!injected && absPath.endsWith('trigger.webm')) {
      injected = true;
      await writeMediaFile(root, 'Filme/ZZZ_NEW/new.webm');
      holder.scanner?.requestPaths(['Filme/ZZZ_NEW']);
    }
    return realStat(absPath);
  };
  const { root, db, scanner } = await setup(t, { statFn });
  holder.scanner = scanner;
  await writeMediaFile(root, 'Filme/AAA/trigger.webm');

  scanner.requestFull(); await scanner.idle();

  assert.equal(injected, true, 'the hook must have fired mid-walk');
  assert.ok(loadRow(db, 'Filme/ZZZ_NEW/new.webm'), "the new directory must survive the full scan's own sweep");
});

test('createScanner: onScanComplete fires once per run with the right kind, unsubscribe works', async (t) => {
  const { root, scanner } = await setup(t);
  await writeMediaFile(root, 'Filme/Arrival (2016).webm');
  /** @type {any[]} */
  const fired = [];
  const unsubscribe = scanner.onScanComplete((payload) => {
    fired.push(payload);
  });

  scanner.requestFull('initial'); await scanner.idle();
  await tick();
  scanner.requestPaths(['Filme/Arrival (2016).webm']);
  await scanner.idle();
  await tick();

  assert.equal(fired.length, 2);
  assert.equal(fired[0].kind, 'initial');
  assert.ok(fired[0].stats);
  assert.equal(typeof fired[0].completedAt, 'number');
  assert.equal(fired[1].kind, 'paths');

  unsubscribe();
  scanner.requestFull(); await scanner.idle();
  await tick();
  assert.equal(fired.length, 2, 'unsubscribe stops further calls');
});

test('createScanner: a throwing listener is logged and the next scan still runs', async (t) => {
  const { root, calls, scanner } = await setup(t);
  await writeMediaFile(root, 'Filme/Arrival (2016).webm');
  scanner.onScanComplete(() => {
    throw new Error('boom');
  });

  scanner.requestFull(); await scanner.idle();
  await tick();

  assert.ok(calls.error.some((c) => c.event === 'library_listener_failed'));

  scanner.requestFull(); await scanner.idle();
  assert.ok(scanner.status().lastCompletedAt);
});

test('createScanner: the QA fixture tree smoke test — 7 movies (3 not playable), 3 series', async () => {
  const fixtureRoot = new URL('../fixtures/media/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  await fsStat(fixtureRoot); // fails loudly if the fixture tree is missing
  const db = testDb();
  const { log } = fakeLog();
  const scanner = createScanner({ db, mediaRoot: fixtureRoot, log, now: NOW });

  scanner.requestFull('initial'); await scanner.idle();

  const movies = /** @type {any[]} */ (db.prepare("SELECT * FROM library_items WHERE category = 'movies'").all());
  assert.equal(movies.length, 7);
  assert.equal(movies.filter((m) => m.playable === 0).length, 3);

  const series = /** @type {any[]} */ (db.prepare('SELECT * FROM library_series').all());
  assert.equal(series.length, 3);
  const byTitle = Object.fromEntries(series.map((s) => [s.title, s]));
  assert.ok(byTitle['Babylon Berlin']);
  assert.ok(byTitle['Dark']);
  assert.ok(byTitle['Stromberg']);

  const darkEpisodes = /** @type {any[]} */ (
    db.prepare('SELECT * FROM library_items WHERE series_id = ?').all(byTitle['Dark'].id)
  );
  assert.equal(darkEpisodes.length, 7);
  assert.equal(new Set(darkEpisodes.map((e) => e.season)).size, 4, 'seasons 1, 2, 0 (specials) and null (Weitere Folgen)');
});
