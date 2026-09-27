// @ts-check
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { createScanner } from '../../src/library/scanner.js';
import { createMediaTree, removeMediaTree } from './media-tree.js';

/**
 * Shared `createScanner` test fixtures: split out of
 * `test/library/scanner.test.js` (and reused by
 * `test/library/scanner-runs.test.js`) purely to keep each test file under
 * the constitution's 300-line limit — no behavioural difference from having
 * them inline.
 */

export const NOW = () => Date.UTC(2026, 8, 26);

/** @returns {{ log: import('../../src/library/dir-watch.js').Logger, calls: { info: any[], warn: any[], error: any[] } }} */
export function fakeLog() {
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
export function testDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** Builds a fresh temp media tree, in-memory DB and scanner for one test.
 * @param {import('node:test').TestContext} t
 * @param {{ mediaRootFor?: (root: string) => string, statFn?: import('../../src/library/walk.js').StatFn, dirObserver?: import('../../src/library/dir-watch.js').DirWatchSet }} [opts]
 * @returns {Promise<{ root: string, db: import('node:sqlite').DatabaseSync, calls: ReturnType<typeof fakeLog>['calls'], scanner: ReturnType<typeof createScanner> }>} */
export async function setup(t, { mediaRootFor, statFn, dirObserver } = {}) {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const db = testDb();
  const { log, calls } = fakeLog();
  const scanner = createScanner({ db, mediaRoot: mediaRootFor ? mediaRootFor(root) : root, log, now: NOW, statFn, dirObserver });
  return { root, db, calls, scanner };
}

/** A fake `DirWatchSet` that just records `sweep()` calls (a copy of the visited set each time).
 * @returns {{ dirObserver: import('../../src/library/dir-watch.js').DirWatchSet, sweepCalls: Set<string>[] }} */
export function fakeDirObserver() {
  /** @type {Set<string>[]} */
  const sweepCalls = [];
  return {
    sweepCalls,
    dirObserver: {
      seen() {},
      gone() {},
      sweep: (visited) => sweepCalls.push(new Set(visited)),
      count: () => 0,
      closeAll() {},
    },
  };
}

/** @returns {Promise<void>} lets a pending `setImmediate` (the onScanComplete dispatch) run */
export function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} dir */
export function countItemsByDir(db, dir) {
  return /** @type {any} */ (db.prepare('SELECT count(*) AS n FROM library_items WHERE dir = ?').get(dir)).n;
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} relPath */
export function loadRow(db, relPath) {
  return /** @type {any} */ (db.prepare('SELECT * FROM library_items WHERE rel_path = ?').get(relPath));
}
