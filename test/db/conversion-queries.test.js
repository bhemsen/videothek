import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { upsertItem } from '../../src/db/library-repo.js';
import { enqueueConversion, publishConversion } from '../../src/db/conversions.js';
import { toItemJson } from '../../src/api/library-json.js';
import { listConversionRows, listConversionRowsForIds } from '../../src/db/conversion-queries.js';

/** @returns {import('node:sqlite').DatabaseSync} an in-memory DB with every migration applied */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

/** @param {import('node:sqlite').DatabaseSync} db @param {Partial<import('../../src/db/library-repo.js').LibraryItemInput>} overrides @returns {number} the item's id */
function makeItem(db, overrides = {}) {
  return upsertItem(
    db,
    {
      rel_path: 'Filme/Item.mkv',
      dir: 'Filme',
      category: 'movies',
      kind: 'video',
      ext: 'mkv',
      title: 'Item',
      sort_title: 'item',
      playable: false,
      size: 1000,
      mtime_ms: 1,
      scan_version: 1,
      ...overrides,
    },
    1000
  );
}

/** @param {import('node:sqlite').DatabaseSync} db @param {Partial<Parameters<typeof enqueueConversion>[1]>} overrides */
function enqueue(db, overrides) {
  enqueueConversion(db, {
    relPath: 'Filme/Item.mkv',
    storageKey: 'a'.repeat(64),
    target: 'web',
    sourceSize: 1000,
    sourceMtimeMs: 1,
    now: 1,
    ...overrides,
  });
}

test('listConversionRows: keeps li.* under plain names (works straight in toItemJson) and every conversions column under a c_ prefix; only rows present in library_items', () => {
  const db = makeDb();
  try {
    const id = makeItem(db);
    enqueue(db, { now: 5 });
    // A conversion row whose item has no library_items row at all: never listed.
    enqueueConversion(db, { relPath: 'hidden.mkv', storageKey: 'b'.repeat(64), target: 'web', sourceSize: 1, sourceMtimeMs: 1, now: 1 });

    const rows = listConversionRows(db);

    assert.equal(rows.length, 1, 'the hidden row (no library_items match) is omitted');
    const row = rows[0];
    assert.equal(row.id, id);
    assert.equal(row.rel_path, 'Filme/Item.mkv');
    assert.equal(row.category, 'movies');
    assert.equal(row.c_status, 'queued');
    assert.equal(row.c_target, 'web');
    assert.equal(row.c_rel_path, 'Filme/Item.mkv');
    assert.equal(row.c_queued_at, 5);
    assert.equal(row.c_error, null);
    assert.doesNotThrow(() => toItemJson(row));
    assert.equal(toItemJson(row).id, id);
  } finally {
    db.close();
  }
});

test('position: numbered over all visible queued rows before any ids filter, null for non-queued and for the running job, and unaffected by a hidden queued row', () => {
  const db = makeDb();
  try {
    const idA = makeItem(db, { rel_path: 'a.mkv' });
    const idB = makeItem(db, { rel_path: 'b.mkv' });
    const idC = makeItem(db, { rel_path: 'c.mkv' });
    const idRunning = makeItem(db, { rel_path: 'running.mkv' });
    enqueueConversion(db, { relPath: 'a.mkv', storageKey: '1'.repeat(64), target: 'web', sourceSize: 1, sourceMtimeMs: 1, now: 10 });
    enqueueConversion(db, { relPath: 'b.mkv', storageKey: '2'.repeat(64), target: 'web', sourceSize: 1, sourceMtimeMs: 1, now: 20 });
    enqueueConversion(db, { relPath: 'c.mkv', storageKey: '3'.repeat(64), target: 'web', sourceSize: 1, sourceMtimeMs: 1, now: 30 });
    // A queued row whose item is absent from library_items, queued before everything else:
    // must not be listed and must not shift the others' positions.
    enqueueConversion(db, { relPath: 'hidden.mkv', storageKey: '4'.repeat(64), target: 'web', sourceSize: 1, sourceMtimeMs: 1, now: 1 });
    // The one running job: never counted, position null.
    enqueueConversion(db, { relPath: 'running.mkv', storageKey: '5'.repeat(64), target: 'web', sourceSize: 1, sourceMtimeMs: 1, now: 5 });
    db.prepare("UPDATE conversions SET status = 'converting', started_at = 6 WHERE rel_path = 'running.mkv'").run();

    const rows = listConversionRows(db);
    const byId = new Map(rows.map((r) => [r.id, r]));

    assert.equal(rows.length, 4, 'the hidden row stays unlisted');
    assert.equal(byId.get(idA)?.position, 1);
    assert.equal(byId.get(idB)?.position, 2);
    assert.equal(byId.get(idC)?.position, 3);
    assert.equal(byId.get(idRunning)?.position, null, 'the running job is not counted');
    assert.equal(byId.get(idRunning)?.c_status, 'converting');

    // A subset via ids gets exactly the same positions as the full listing.
    const subset = listConversionRowsForIds(db, [idB, idC]);
    const subsetById = new Map(subset.map((r) => [r.id, r]));
    assert.equal(subsetById.get(idB)?.position, 2, 'numbered over all visible rows, not just the requested subset');
    assert.equal(subsetById.get(idC)?.position, 3);

    // A finished (non-queued) row: position null.
    publishConversion(db, { relPath: 'a.mkv', outputRel: 'x/web.mp4', outputSize: 1, notes: '[]', sidecars: '[]', now: 50 });
    assert.equal(listConversionRows(db).find((r) => r.id === idA)?.position, null);
  } finally {
    db.close();
  }
});

test('listConversionRowsForIds: one row per requested id present in library_items, NULL conversion columns with no conversion row, unknown ids omitted', () => {
  const db = makeDb();
  try {
    const idWithConversion = makeItem(db, { rel_path: 'a.mkv' });
    const idWithoutConversion = makeItem(db, { rel_path: 'b.mkv' });
    enqueueConversion(db, { relPath: 'a.mkv', storageKey: '1'.repeat(64), target: 'flac', sourceSize: 1, sourceMtimeMs: 1, now: 1 });
    const unknownId = idWithoutConversion + 1000;

    const rows = listConversionRowsForIds(db, [idWithConversion, idWithoutConversion, unknownId]);

    assert.equal(rows.length, 2, 'the unknown id is omitted');
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get(idWithConversion)?.c_status, 'queued');
    assert.equal(byId.get(idWithConversion)?.c_target, 'flac');
    const bare = byId.get(idWithoutConversion);
    assert.equal(bare?.c_status, null, 'no conversion row -> c_status is NULL');
    assert.equal(bare?.c_target, null);
    assert.equal(bare?.c_rel_path, null);
    assert.equal(bare?.position, null);
    assert.doesNotThrow(() => toItemJson(/** @type {any} */ (bare)));
  } finally {
    db.close();
  }
});

test('listConversionRowsForIds: an empty ids array yields no rows without a special case', () => {
  const db = makeDb();
  try {
    makeItem(db);
    assert.deepEqual(listConversionRowsForIds(db, []), []);
  } finally {
    db.close();
  }
});
