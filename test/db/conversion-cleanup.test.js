// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { upsertItem } from '../../src/db/library-repo.js';
import { getConversion, enqueueConversion } from '../../src/db/conversions.js';
import { storageKey } from '../../src/convert/targets.js';
import {
  syncMissingSince, listExpiredMissing, deleteExpiredMissing, listPlayableWithItem, deletePlayableAndResetItem,
  listFailedWithOutput, stripFailedOutput, listFreshPlayable, listWithOutput, isKeyReferenced,
} from '../../src/db/conversion-cleanup.js';

/** @returns {DatabaseSync} */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

/**
 * @param {DatabaseSync} db
 * @param {string} rel
 * @param {{ size?: number, mtime?: number }} [o]
 */
function item(db, rel, { size = 10, mtime = 20 } = {}) {
  upsertItem(
    db,
    {
      rel_path: rel, dir: 'd', category: 'audiobooks', kind: 'audio', ext: 'mp3', title: rel, sort_title: rel,
      playable: false, size, mtime_ms: mtime, scan_version: 7,
    },
    1
  );
}

/**
 * @param {DatabaseSync} db
 * @param {string} rel
 * @param {Record<string, unknown>} [set] - columns to override after insert
 */
function conv(db, rel, set = {}) {
  enqueueConversion(db, { relPath: rel, storageKey: storageKey(rel), target: 'flac', sourceSize: 10, sourceMtimeMs: 20, now: 1 });
  const cols = { status: 'playable', output_rel: `${storageKey(rel)}/audio.flac`, output_size: 4, ...set };
  for (const [col, value] of Object.entries(cols)) {
    db.prepare(`UPDATE conversions SET ${col} = ? WHERE rel_path = ?`).run(/** @type {any} */ (value), rel);
  }
}

test('syncMissingSince marks rows without an item once and clears rows whose item is back', () => {
  const db = makeDb();
  conv(db, 'gone.mp3');
  conv(db, 'back.mp3', { missing_since: 3 });
  conv(db, 'present.mp3');
  item(db, 'back.mp3');
  item(db, 'present.mp3');
  assert.deepEqual(syncMissingSince(db, 100), { marked: 1, cleared: 1 });
  assert.equal(getConversion(db, 'gone.mp3')?.missing_since, 100);
  assert.equal(getConversion(db, 'back.mp3')?.missing_since, null);
  assert.deepEqual(syncMissingSince(db, 200), { marked: 0, cleared: 0 }, 'an existing mark keeps its first timestamp');
  assert.equal(getConversion(db, 'gone.mp3')?.missing_since, 100);
});

test('listExpiredMissing / deleteExpiredMissing: strictly older than the cutoff, never a converting row', () => {
  const db = makeDb();
  conv(db, 'old.mp3', { missing_since: 10 });
  conv(db, 'queued.mp3', { status: 'queued', output_rel: null, missing_since: 10 });
  conv(db, 'converting.mp3', { status: 'converting', missing_since: 10 });
  conv(db, 'edge.mp3', { missing_since: 50 });
  conv(db, 'present.mp3');
  const rows = listExpiredMissing(db, 50).map((r) => r.rel_path);
  assert.deepEqual(rows, ['old.mp3', 'queued.mp3']);
  assert.equal(deleteExpiredMissing(db, 'converting.mp3', 50), false);
  assert.equal(deleteExpiredMissing(db, 'edge.mp3', 50), false);
  assert.equal(deleteExpiredMissing(db, 'old.mp3', 50), true);
  assert.equal(getConversion(db, 'old.mp3'), undefined);
});

test('deletePlayableAndResetItem deletes the row and resets playable/scan_version atomically', () => {
  const db = makeDb();
  conv(db, 'a.mp3');
  item(db, 'a.mp3');
  assert.equal(/** @type {any} */ (db.prepare('SELECT playable FROM library_items').get()).playable, 1);
  assert.deepEqual(listPlayableWithItem(db).map((r) => r.rel_path), ['a.mp3']);
  assert.equal(deletePlayableAndResetItem(db, 'a.mp3', storageKey('a.mp3')), true);
  assert.equal(getConversion(db, 'a.mp3'), undefined);
  assert.deepEqual({ ...db.prepare('SELECT playable, scan_version FROM library_items').get() }, { playable: 0, scan_version: 0 });
});

test('deletePlayableAndResetItem leaves a re-queued row and its item untouched', () => {
  const db = makeDb();
  conv(db, 'a.mp3');
  item(db, 'a.mp3');
  db.prepare("UPDATE conversions SET status = 'queued' WHERE rel_path = 'a.mp3'").run();
  assert.equal(deletePlayableAndResetItem(db, 'a.mp3', storageKey('a.mp3')), false);
  assert.ok(getConversion(db, 'a.mp3'));
  assert.equal(/** @type {any} */ (db.prepare('SELECT scan_version FROM library_items').get()).scan_version, 7);
});

test('deletePlayableAndResetItem rolls the row delete back when the item update fails', () => {
  const db = makeDb();
  conv(db, 'a.mp3');
  item(db, 'a.mp3');
  db.exec(
    "CREATE TRIGGER fail_reset BEFORE UPDATE ON library_items BEGIN SELECT RAISE(ABORT, 'boom'); END"
  );
  assert.throws(() => deletePlayableAndResetItem(db, 'a.mp3', storageKey('a.mp3')), /boom/);
  assert.ok(getConversion(db, 'a.mp3'), 'the DELETE was rolled back with the failed UPDATE');
});

test('stripFailedOutput nulls output_rel/output_size and resets sidecars to [] (not NULL)', () => {
  const db = makeDb();
  conv(db, 'f.mp3', { status: 'failed', sidecars: '[{"file":"sub-0.vtt","lang":"de"}]' });
  conv(db, 'p.mp3');
  assert.deepEqual(listFailedWithOutput(db).map((r) => r.rel_path), ['f.mp3']);
  assert.equal(stripFailedOutput(db, 'p.mp3'), false, 'a playable row is never stripped');
  assert.equal(stripFailedOutput(db, 'f.mp3'), true);
  const row = getConversion(db, 'f.mp3');
  assert.deepEqual([row?.output_rel, row?.output_size, row?.sidecars], [null, null, '[]']);
  assert.equal(stripFailedOutput(db, 'f.mp3'), false);
});

test('listFreshPlayable returns only playable rows whose recorded stat equals the item stat', () => {
  const db = makeDb();
  conv(db, 'fresh.mp3');
  item(db, 'fresh.mp3');
  conv(db, 'stale.mp3');
  item(db, 'stale.mp3', { size: 11 });
  conv(db, 'noitem.mp3');
  conv(db, 'failed.mp3', { status: 'failed' });
  item(db, 'failed.mp3');
  assert.deepEqual(listFreshPlayable(db).map((r) => r.rel_path), ['fresh.mp3']);
  assert.deepEqual(listWithOutput(db).map((r) => r.rel_path), ['failed.mp3', 'fresh.mp3', 'noitem.mp3', 'stale.mp3']);
});

test('isKeyReferenced: output_rel or queued/converting counts, a bare failed row does not', () => {
  const db = makeDb();
  conv(db, 'out.mp3');
  conv(db, 'queued.mp3', { status: 'queued', output_rel: null, output_size: null });
  conv(db, 'converting.mp3', { status: 'converting', output_rel: null, output_size: null });
  conv(db, 'failed.mp3', { status: 'failed', output_rel: null, output_size: null });
  for (const rel of ['out.mp3', 'queued.mp3', 'converting.mp3']) assert.equal(isKeyReferenced(db, storageKey(rel)), true, rel);
  assert.equal(isKeyReferenced(db, storageKey('failed.mp3')), false);
  assert.equal(isKeyReferenced(db, 'f'.repeat(64)), false);
});
