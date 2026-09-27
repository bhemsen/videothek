// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat as fsStat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScanner } from '../../src/library/scanner.js';
import { writeMediaFile } from '../helpers/media-tree.js';
import { NOW, fakeLog, testDb, setup, tick, loadRow } from '../helpers/scanner-fixtures.js';

// Split out of `scanner.test.js` purely to keep each file under the
// constitution's 300-line limit: run-kind lifecycle (a paths run's stats
// shape and its interleaving with a full scan, `stop()`, `onScanComplete`
// and its listener contract) and the fixture-tree smoke test. Basic
// full-scan CRUD/root-safety behaviour lives in `scanner.test.js`.

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

test('createScanner: a standalone paths subtree walk does not drain a nested reconcile into its own sweep', async (t) => {
  const { stat: realStat } = await import('node:fs/promises');
  let armed = false;
  let injected = false;
  /** @type {{ scanner?: ReturnType<typeof createScanner> }} */
  const holder = {};
  /** @param {string} absPath */
  const statFn = async (absPath) => {
    if (armed && !injected && absPath.endsWith('sub-trigger.webm')) {
      injected = true;
      await writeMediaFile(root, 'Filme/Coll/New/new.webm');
      holder.scanner?.requestPaths(['Filme/Coll/New']);
    }
    return realStat(absPath);
  };
  const { root, db, scanner } = await setup(t, { statFn });
  holder.scanner = scanner;
  await writeMediaFile(root, 'Filme/Coll/Sub/sub-trigger.webm');
  await writeMediaFile(root, 'Filme/Coll/Existing.webm');
  scanner.requestFull(); await scanner.idle(); // establish the baseline rows; the hook is not armed yet

  armed = true;
  scanner.requestPaths(['Filme/Coll']); // a standalone reconcile of a directory — not part of any full scan
  await scanner.idle();

  assert.equal(injected, true, 'the hook must have fired mid-walk');
  assert.ok(
    loadRow(db, 'Filme/Coll/New/new.webm'),
    "a directory discovered by a reconcile nested inside another reconcile's own subtree walk must not be swept away by the outer walk"
  );
});

test('createScanner: a reconcile nested inside another reconcile interleaved into a running full scan survives both sweeps', async (t) => {
  const { stat: realStat } = await import('node:fs/promises');
  let injectedOuter = false;
  let injectedInner = false;
  /** @type {{ scanner?: ReturnType<typeof createScanner> }} */
  const holder = {};
  /** @param {string} absPath */
  const statFn = async (absPath) => {
    if (!injectedOuter && absPath.endsWith('trigger.webm')) {
      injectedOuter = true;
      // A fresh directory the outer full walk's own listing of 'Filme'
      // never saw (it didn't exist yet) — same shape as the existing
      // "reconcile interleaved into a running full scan" test, except this
      // one's own subtree walk (run via drainPathsBetweenDirs, nested
      // inside the running full scan) contains a second trigger.
      await writeMediaFile(root, 'Filme/ZZZ_NEW/Sub/sub-trigger.webm');
      holder.scanner?.requestPaths(['Filme/ZZZ_NEW']);
    }
    if (!injectedInner && absPath.endsWith('sub-trigger.webm')) {
      injectedInner = true;
      // Discovered only once the outer reconcile's own subtree walk reaches
      // 'Filme/ZZZ_NEW/Sub' — never part of that walk's own directory
      // listing of 'Filme/ZZZ_NEW' (captured before 'New' existed).
      await writeMediaFile(root, 'Filme/ZZZ_NEW/New/new.webm');
      holder.scanner?.requestPaths(['Filme/ZZZ_NEW/New']);
    }
    return realStat(absPath);
  };
  const { root, db, scanner } = await setup(t, { statFn });
  holder.scanner = scanner;
  await writeMediaFile(root, 'Filme/AAA/trigger.webm');

  scanner.requestFull(); await scanner.idle();

  assert.equal(injectedOuter, true, 'the outer hook must have fired mid-walk');
  assert.equal(injectedInner, true, 'the inner (doubly-nested) hook must have fired mid-walk');
  assert.ok(
    loadRow(db, 'Filme/ZZZ_NEW/New/new.webm'),
    "a directory discovered by a reconcile nested inside another reconcile's own subtree walk, both during the same full scan, must survive every enclosing sweep"
  );
});

test('createScanner: a paths run that deletes the last episode also deletes the now-empty series row', async (t) => {
  const { root, db, scanner } = await setup(t);
  const episodePath = 'Serien/Dark (2017)/Staffel 1/Dark S01E01 - Geheimnisse.webm';
  await writeMediaFile(root, episodePath);
  scanner.requestFull(); await scanner.idle();
  assert.equal(db.prepare('SELECT * FROM library_series').all().length, 1);

  await rm(join(root, ...episodePath.split('/')));
  scanner.requestPaths([episodePath]);
  await scanner.idle();

  assert.equal(
    db.prepare('SELECT * FROM library_series').all().length,
    0,
    'the orphaned series row must not linger until the next full scan'
  );
});

test('createScanner: a paths run reports the full ScanStats shape, not just added/updated/removed/unchanged', async (t) => {
  const { root, scanner } = await setup(t);
  await writeMediaFile(root, 'Filme/Arrival (2016).webm');
  scanner.requestFull(); await scanner.idle();

  scanner.requestPaths(['Filme/Arrival (2016).webm']);
  await scanner.idle();

  const stats = scanner.status().lastStats;
  assert.equal(typeof stats?.durationMs, 'number');
  assert.equal(stats?.failedDirs, 0);
  assert.equal(stats?.skippedSymlinks, 0);
  assert.equal(stats?.skippedUndecodable, 0);
  assert.equal(stats?.protectedRoots, 0);
});

test('createScanner: stop() aborts a running full scan between directories and never fires onScanComplete', async (t) => {
  const { stat: realStat } = await import('node:fs/promises');
  let hookFired = false;
  /** @type {{ scanner?: ReturnType<typeof createScanner> }} */
  const holder = {};
  /** @param {string} absPath */
  const statFn = async (absPath) => {
    if (!hookFired && absPath.endsWith('trigger.webm')) {
      hookFired = true;
      holder.scanner?.stop();
    }
    return realStat(absPath);
  };
  const { root, calls, scanner } = await setup(t, { statFn });
  holder.scanner = scanner;
  await writeMediaFile(root, 'Filme/trigger.webm');
  for (let d = 0; d < 5; d += 1) {
    await writeMediaFile(root, `Filme/Dir${d}/movie.webm`);
  }
  /** @type {any[]} */
  const fired = [];
  scanner.onScanComplete((payload) => {
    fired.push(payload);
  });

  scanner.requestFull();
  await scanner.idle();
  await tick();

  assert.equal(hookFired, true, 'the hook must have fired mid-walk');
  assert.deepEqual(fired, [], 'a run cut short by stop() must never fire onScanComplete');
  assert.ok(!calls.error.some((c) => c.event === 'library_scan_run_failed'), 'a normal shutdown is not logged as a failure');
  assert.ok(calls.info.some((c) => c.event === 'library_scan_stopped'));
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

test('createScanner: a rejecting listener is logged and the next scan still runs', async (t) => {
  const { root, calls, scanner } = await setup(t);
  await writeMediaFile(root, 'Filme/Arrival (2016).webm');
  scanner.onScanComplete(() => Promise.reject(new Error('boom')));

  scanner.requestFull(); await scanner.idle();
  await tick();

  assert.ok(calls.error.some((c) => c.event === 'library_listener_failed'));

  scanner.requestFull(); await scanner.idle();
  assert.ok(scanner.status().lastCompletedAt);
});

test('createScanner: the QA fixture tree smoke test — 7 movies (3 not playable), 3 series', async () => {
  const fixtureRoot = fileURLToPath(new URL('../fixtures/media/', import.meta.url));
  await fsStat(fixtureRoot); // fails loudly if the fixture tree is missing
  const db = testDb();
  const { log } = fakeLog();
  const scanner = createScanner({ db, mediaRoot: fixtureRoot, log, now: NOW });

  scanner.requestFull('initial'); await scanner.idle();

  const movies = /** @type {any[]} */ (db.prepare("SELECT * FROM library_items WHERE category = 'movies'").all());
  assert.equal(movies.length, 7);
  const notPlayable = movies.filter((m) => m.playable === 0).map((m) => m.title).sort();
  assert.deepEqual(notPlayable, ['Das Boot', 'Heat', 'Paprika']);

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
  const darkNumberedStaffeln = new Set(darkEpisodes.map((e) => e.season).filter((s) => typeof s === 'number' && s > 0));
  assert.equal(darkNumberedStaffeln.size, 2, '2 numbered Staffeln (Specials is season 0, Extras is "Weitere Folgen")');

  const babylonEpisodes = /** @type {any[]} */ (
    db.prepare('SELECT * FROM library_items WHERE series_id = ?').all(byTitle['Babylon Berlin'].id)
  );
  assert.equal(babylonEpisodes.length, 1);

  const strombergEpisodes = /** @type {any[]} */ (
    db.prepare('SELECT * FROM library_items WHERE series_id = ?').all(byTitle['Stromberg'].id)
  );
  assert.equal(strombergEpisodes.length, 2);
});
