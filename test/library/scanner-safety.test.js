// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createScanner } from '../../src/library/scanner.js';
import { writeMediaFile, makeMediaDir } from '../helpers/media-tree.js';
import { setup, countItemsByDir, loadRow } from '../helpers/scanner-fixtures.js';

// Data-safety races of the full walk (spec: walk rule + D7, "unreadable
// directories protect their subtree"): a directory that vanishes or breaks
// between its parent's listing (or its root's health check) and its own
// `readdir`, and a reconcile interleaved into a full scan that indexes a file
// in a directory that scan never listed. Split from `scanner.test.js` /
// `scanner-runs.test.js` to keep each under the 300-line limit. Also: an
// empty category root keeps its watch, and stop() during a subtree walk.

/**
 * A `DirWatchSet` whose `seen(relDir)` runs `hook` synchronously — `walkDir`
 * calls `seen` right before that directory's own `readdir`, so the hook can
 * remove or replace it at exactly that moment.
 * @param {(relDir: string) => void} hook
 * @returns {import('../../src/library/dir-watch.js').DirWatchSet}
 */
function hookedObserver(hook) {
  return { seen: hook, gone() {}, sweep() {}, count: () => 0, closeAll() {} };
}

test('createScanner: a subdirectory vanishing (ENOENT) mid-walk keeps its rows and warns library_dir_failed', async (t) => {
  let armed = false;
  /** @type {string} */
  let mediaRoot = '';
  const dirObserver = hookedObserver((relDir) => {
    if (armed && relDir === 'Filme/BBB') rmSync(join(mediaRoot, 'Filme', 'BBB'), { recursive: true, force: true });
  });
  const { root, db, calls, scanner } = await setup(t, { dirObserver });
  mediaRoot = root;
  await writeMediaFile(root, 'Filme/AAA/a.webm');
  await writeMediaFile(root, 'Filme/BBB/b.webm');
  await writeMediaFile(root, 'Filme/BBB/Deep/c.webm');
  scanner.requestFull(); await scanner.idle();

  armed = true; // stands in for a lazily unmounted disk: listed a moment ago, ENOENT now
  scanner.requestFull(); await scanner.idle();

  assert.equal(countItemsByDir(db, 'Filme/BBB'), 1, 'the vanished directory is protected, not swept');
  assert.equal(countItemsByDir(db, 'Filme/BBB/Deep'), 1, 'its whole subtree is protected');
  assert.equal(countItemsByDir(db, 'Filme/AAA'), 1);
  assert.ok(calls.warn.some((c) => c.event === 'library_dir_failed' && c.fields.dir === 'Filme/BBB' && c.fields.code === 'ENOENT'));
  assert.equal(scanner.status().lastStats?.failedDirs, 1);
  assert.equal(scanner.status().lastError, 'dir_failed');

  armed = false;
  scanner.requestFull(); await scanner.idle();
  assert.equal(countItemsByDir(db, 'Filme/BBB'), 0, 'the next full scan (no longer listing it) sweeps it');
  assert.equal(scanner.status().lastError, null);
});

test('createScanner: a subdirectory replaced by a file mid-walk (non-ENOENT) keeps its rows', async (t) => {
  let armed = false;
  let mediaRoot = '';
  const dirObserver = hookedObserver((relDir) => {
    if (!armed || relDir !== 'Filme/BBB') return;
    rmSync(join(mediaRoot, 'Filme', 'BBB'), { recursive: true, force: true });
    writeFileSync(join(mediaRoot, 'Filme', 'BBB'), 'x'); // readdir -> ENOTDIR
  });
  const { root, db, calls, scanner } = await setup(t, { dirObserver });
  mediaRoot = root;
  await writeMediaFile(root, 'Filme/BBB/b.webm');
  await writeMediaFile(root, 'Filme/keep.webm');
  scanner.requestFull(); await scanner.idle();

  armed = true;
  scanner.requestFull(); await scanner.idle();

  assert.equal(countItemsByDir(db, 'Filme/BBB'), 1);
  assert.ok(calls.warn.some((c) => c.event === 'library_dir_failed' && c.fields.dir === 'Filme/BBB' && c.fields.code !== 'ENOENT'));
});

test('createScanner: a category root vanishing between its health check and its walk is a protected missing root', async (t) => {
  let armed = false;
  let mediaRoot = '';
  const dirObserver = hookedObserver((relDir) => {
    if (armed && relDir === 'Filme') rmSync(join(mediaRoot, 'Filme'), { recursive: true, force: true });
  });
  const { root, db, calls, scanner } = await setup(t, { dirObserver });
  mediaRoot = root;
  await writeMediaFile(root, 'Filme/Arrival (2016).webm');
  await writeMediaFile(root, 'Filme/Sub/Heat (1995).webm');
  scanner.requestFull(); await scanner.idle();

  armed = true;
  scanner.requestFull(); await scanner.idle();

  assert.ok(loadRow(db, 'Filme/Arrival (2016).webm'), 'nothing under the root is swept');
  assert.ok(loadRow(db, 'Filme/Sub/Heat (1995).webm'));
  assert.ok(calls.warn.some((c) => c.event === 'library_root_protected' && c.fields.root === 'Filme' && c.fields.reason === 'missing'));
  assert.equal(scanner.status().lastStats?.protectedRoots, 1);
  assert.equal(scanner.status().lastError, 'root_protected');
});

test('createScanner: a file reconciled mid-scan in a directory the walk never listed survives the sweep', async (t) => {
  let injected = false;
  /** @type {{ scanner?: ReturnType<typeof createScanner> }} */
  const holder = {};
  let mediaRoot = '';
  /** @param {string} absPath */
  const statFn = async (absPath) => {
    if (!injected && absPath.endsWith('trigger.webm')) {
      injected = true; // 'Filme' was already listed: its dirs never include 'New'
      await writeMediaFile(mediaRoot, 'Filme/New/a.webm');
      holder.scanner?.requestPaths(['Filme/New/a.webm']); // a file path, not a directory
    }
    return stat(absPath);
  };
  const { root, db, scanner } = await setup(t, { statFn });
  holder.scanner = scanner;
  mediaRoot = root;
  await writeMediaFile(root, 'Filme/trigger.webm');

  scanner.requestFull(); await scanner.idle();

  assert.equal(injected, true, 'the hook must have fired mid-walk');
  assert.ok(loadRow(db, 'Filme/New/a.webm'), "the reconciled file's directory counts as visited by the running full scan");
});

test('createScanner: an empty category root is still watched and kept in the sweep\'s visited set', async (t) => {
  /** @type {string[]} */
  const seen = [];
  /** @type {Set<string>[]} */
  const sweeps = [];
  /** @type {import('../../src/library/dir-watch.js').DirWatchSet} */
  const dirObserver = { seen: (d) => void seen.push(d), gone() {}, sweep: (v) => void sweeps.push(new Set(v)), count: () => 0, closeAll() {} };
  const { root, db, calls, scanner } = await setup(t, { dirObserver });
  await makeMediaDir(root, 'Filme'); // fresh install: pre-created, still empty
  await writeMediaFile(root, 'Serien/X/X S01E01.webm');

  scanner.requestFull('initial'); await scanner.idle();

  assert.ok(seen.includes('Filme'), 'the empty root gets a watch, so a first movie copied in is seen within seconds');
  assert.equal(sweeps.length, 1);
  assert.ok(sweeps[0].has('Filme'), 'the sweep keeps the empty root\'s watch open');
  assert.ok(sweeps[0].has('Serien/X'));
  assert.equal(scanner.status().lastError, null, 'an empty root without rows is not an error');
  assert.ok(!calls.warn.some((c) => c.event === 'library_root_protected'));

  await writeMediaFile(root, 'Filme/A.webm');
  scanner.requestFull(); await scanner.idle();
  await unlink(join(root, 'Filme', 'A.webm')); // last file gone: a protected empty root
  scanner.requestFull(); await scanner.idle();

  assert.ok(loadRow(db, 'Filme/A.webm'), 'root safety still protects its rows');
  assert.ok(sweeps[2].has('Filme'), 'a protected empty root keeps its watch too');
});

test('createScanner: a file landing in an empty root between its health check and its watch is indexed by the same scan', async (t) => {
  let mediaRoot = '';
  const dirObserver = hookedObserver((relDir) => {
    if (relDir === 'Filme') writeFileSync(join(mediaRoot, 'Filme', 'Arrival (2016).webm'), 'x');
  });
  const { root, db, scanner } = await setup(t, { dirObserver });
  mediaRoot = root;
  await makeMediaDir(root, 'Filme');

  scanner.requestFull('initial'); await scanner.idle();

  assert.ok(loadRow(db, 'Filme/Arrival (2016).webm'), 'the health re-check after seen() walks the root');
});

test('createScanner: stop() during a paths run\'s subtree walk reports no completion and logs no failure', async (t) => {
  /** @type {{ scanner?: ReturnType<typeof createScanner> }} */
  const holder = {};
  const dirObserver = hookedObserver((relDir) => {
    if (relDir === 'Filme/New') holder.scanner?.stop(); // its child 'Deep' then aborts
  });
  const { root, calls, scanner } = await setup(t, { dirObserver });
  holder.scanner = scanner;
  await writeMediaFile(root, 'Filme/keep.webm');
  scanner.requestFull(); await scanner.idle();
  await writeMediaFile(root, 'Filme/New/Deep/a.webm');
  /** @type {unknown[]} */
  const fired = [];
  scanner.onScanComplete((p) => void fired.push(p));

  scanner.requestPaths(['Filme/New']); await scanner.idle();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fired, []);
  assert.ok(!calls.error.some((c) => c.event === 'library_scan_run_failed'));
  assert.ok(calls.info.some((c) => c.event === 'library_scan_stopped'));
});
