// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { upsertItem } from '../../src/db/library-repo.js';
import { upsertAudioMeta } from '../../src/db/audio-meta-repo.js';
import { AUDIO_META_VERSION, createAudioMetaPass } from '../../src/library/audio-meta.js';

/** @returns {import('node:sqlite').DatabaseSync} an in-memory DB with migrations applied and FKs on */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** @param {Partial<import('../../src/db/library-repo.js').LibraryItemInput>} overrides
 * @returns {import('../../src/db/library-repo.js').LibraryItemInput} */
function makeItem(overrides = {}) {
  return {
    rel_path: 'Musik/Die Beispiele/Unterwegs/01 Titel.mp3',
    dir: 'Musik/Die Beispiele/Unterwegs',
    category: 'music',
    kind: 'audio',
    ext: 'mp3',
    title: 'Titel',
    sort_title: 'titel',
    playable: true,
    size: 1000,
    mtime_ms: 1_700_000_000_000,
    scan_version: 1,
    ...overrides,
  };
}

/** @param {Partial<import('../../src/library/tags/index.js').AudioTags>} [overrides]
 * @returns {import('../../src/library/tags/index.js').AudioTags} */
function tagsStub(overrides = {}) {
  return {
    title: null, artist: null, albumArtist: null, album: null,
    trackNo: null, discNo: null, year: null, durationMs: null, format: null,
    ...overrides,
  };
}

/** @typedef {{ level: string, event: string, fields?: Record<string, unknown> }} LogCall */
/** @returns {{ log: import('../../src/log.js').Logger, calls: LogCall[] }} */
function makeLog() {
  /** @type {LogCall[]} */
  const calls = [];
  /** @param {'info'|'warn'|'error'} level @returns {import('../../src/log.js').LogFn} */
  const at = (level) => (event, fields) => calls.push({ level, event, fields });
  return { log: { info: at('info'), warn: at('warn'), error: at('error') }, calls };
}

/** Fake `resolveMediaPath` — every rel path "resolves" without touching the filesystem. */
const resolvePath = async (/** @type {string} */ root, /** @type {string} */ relPath) => `${root}/${relPath}`;

/** Resolves on the next macrotask, so a pass can be pre-empted mid-flight. */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('a new item with no audio_meta row gets one created — tags win for title/track, folder wins for grouping', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const id = upsertItem(db, makeItem(), 1000);
  const { log } = makeLog();
  const readTags = async () => tagsStub({ title: 'Tag-Titel', trackNo: 3, format: 'id3v2' });
  const pass = createAudioMetaPass({ db, mediaRoot: '/media', log, readTags, resolvePath });
  await pass.refreshAudioMeta();

  const row = /** @type {any} */ (db.prepare('SELECT * FROM audio_meta WHERE item_id = ?').get(id));
  assert.equal(row?.title, 'Tag-Titel');
  assert.equal(row?.track_no, 3);
  assert.equal(row?.group_key, 'Musik/Die Beispiele/Unterwegs');
  assert.equal(row?.group_title, 'Unterwegs');
  assert.equal(row?.group_artist, 'Die Beispiele');
  assert.equal(row?.meta_version, AUDIO_META_VERSION);
  assert.equal(row?.tag_format, 'id3v2');
});

test('an item whose size/mtime changed since its last read is re-read and its row updated', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const id = upsertItem(db, makeItem({ size: 1000, mtime_ms: 1_700_000_000_000 }), 1000);
  const { log } = makeLog();
  let call = 0;
  const readTags = async () => {
    call += 1;
    return tagsStub({ title: `Version ${call}` });
  };
  const pass = createAudioMetaPass({ db, mediaRoot: '/media', log, readTags, resolvePath });
  await pass.refreshAudioMeta();
  assert.equal(/** @type {any} */ (db.prepare('SELECT title FROM audio_meta WHERE item_id = ?').get(id))?.title, 'Version 1');

  // The file changed on disk; the scanner upserts the new size/mtime onto the same row (same rel_path -> same id).
  upsertItem(db, makeItem({ size: 2000, mtime_ms: 1_700_000_005_000 }), 2000);
  await pass.refreshAudioMeta();

  const row = /** @type {any} */ (db.prepare('SELECT * FROM audio_meta WHERE item_id = ?').get(id));
  assert.equal(row?.title, 'Version 2');
  assert.equal(row?.source_size, 2000);
  assert.equal(row?.source_mtime_ms, 1_700_000_005_000);
  assert.equal(call, 2);
});

test('a row whose meta_version is behind AUDIO_META_VERSION is re-derived', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const id = upsertItem(db, makeItem(), 1000);
  upsertAudioMeta(db, {
    item_id: id, meta_version: AUDIO_META_VERSION - 1, source_mtime_ms: 1_700_000_000_000,
    source_size: 1000, group_key: 'Musik/Die Beispiele/Unterwegs', title: 'Alte Version', disc_no: 1,
  });
  const { log } = makeLog();
  const readTags = async () => tagsStub({ title: 'Neue Version' });
  const pass = createAudioMetaPass({ db, mediaRoot: '/media', log, readTags, resolvePath });
  await pass.refreshAudioMeta();

  const row = /** @type {any} */ (db.prepare('SELECT * FROM audio_meta WHERE item_id = ?').get(id));
  assert.equal(row?.meta_version, AUDIO_META_VERSION);
  assert.equal(row?.title, 'Neue Version');
});

test('an unchanged, up-to-date row is not re-read', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const freshId = upsertItem(db, makeItem({ rel_path: 'Musik/Fresh.mp3' }), 1000);
  upsertAudioMeta(db, {
    item_id: freshId, meta_version: AUDIO_META_VERSION, source_mtime_ms: 1_700_000_000_000,
    source_size: 1000, group_key: 'Musik', title: 'Bereits aktuell', disc_no: 1,
  });
  upsertItem(db, makeItem({ rel_path: 'Musik/Stale.mp3' }), 1000);

  const { log } = makeLog();
  /** @type {string[]} */
  const read = [];
  const readTags = async (/** @type {string} */ absPath) => { read.push(absPath); return tagsStub(); };
  const pass = createAudioMetaPass({ db, mediaRoot: '/media', log, readTags, resolvePath });
  await pass.refreshAudioMeta();

  assert.deepEqual(read, ['/media/Musik/Stale.mp3']);
  assert.equal(/** @type {any} */ (db.prepare('SELECT title FROM audio_meta WHERE item_id = ?').get(freshId))?.title, 'Bereits aktuell');
});

test('a non-mp3/flac item gets a path-only row (null tag fields; title/track from the filename) — playability is never re-decided here', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const item = makeItem({
    rel_path: 'Musik/Klangwerk/Flac Album/04 Bonus (Live).wma',
    dir: 'Musik/Klangwerk/Flac Album', ext: 'wma', playable: false,
  });
  const id = upsertItem(db, item, 1000);
  const { log } = makeLog();
  // The real readAudioTags returns exactly this all-null shape for a
  // non-mp3/flac extension, without opening the file.
  const readTags = async () => tagsStub();
  const pass = createAudioMetaPass({ db, mediaRoot: '/media', log, readTags, resolvePath });
  await pass.refreshAudioMeta();

  const row = /** @type {any} */ (db.prepare('SELECT * FROM audio_meta WHERE item_id = ?').get(id));
  assert.equal(row?.tag_format, null);
  assert.equal(row?.duration_ms, null);
  assert.equal(row?.title, 'Bonus (Live)');
  assert.equal(row?.track_no, 4);
  assert.equal(/** @type {any} */ (db.prepare('SELECT playable FROM library_items WHERE id = ?').get(id))?.playable, 0);
});

test('a rejecting readTags call still gets a fallback row, and logs exactly one audio_meta_read_failed line with no tag content', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const id = upsertItem(db, makeItem(), 1000);
  const { log, calls } = makeLog();
  const readTags = async () => {
    throw new Error('corrupt frame');
  };
  const pass = createAudioMetaPass({ db, mediaRoot: '/media', log, readTags, resolvePath });
  await pass.refreshAudioMeta();

  const row = /** @type {any} */ (db.prepare('SELECT * FROM audio_meta WHERE item_id = ?').get(id));
  assert.equal(row?.title, 'Titel', 'falls back to the cleaned filename');
  assert.equal(row?.tag_format, null);
  assert.equal(row?.tag_artist, null);

  const readFailures = calls.filter((c) => c.event === 'audio_meta_read_failed');
  assert.equal(readFailures.length, 1);
  assert.equal(readFailures[0].level, 'warn');
  assert.deepEqual(readFailures[0].fields, { relPath: 'Musik/Die Beispiele/Unterwegs/01 Titel.mp3' });
});

test('an item deleted mid-pass (FK violation on its own upsert) is skipped without failing the run', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const deletedId = upsertItem(db, makeItem({ rel_path: 'Musik/Deleted.mp3' }), 1000);
  const otherId = upsertItem(db, makeItem({ rel_path: 'Musik/Other.mp3' }), 1000);
  const { log, calls } = makeLog();
  const readTags = async (/** @type {string} */ absPath) => {
    // Simulates a concurrent scan removing this item between its selection and its upsert.
    if (absPath.endsWith('Deleted.mp3')) db.prepare('DELETE FROM library_items WHERE id = ?').run(deletedId);
    return tagsStub();
  };
  const pass = createAudioMetaPass({ db, mediaRoot: '/media', log, readTags, resolvePath });
  await pass.refreshAudioMeta();

  assert.equal(db.prepare('SELECT * FROM audio_meta WHERE item_id = ?').get(deletedId), undefined);
  assert.ok(db.prepare('SELECT * FROM audio_meta WHERE item_id = ?').get(otherId));
  assert.equal(calls.some((c) => c.level === 'error'), false, 'a deleted-mid-pass item is a skip, not a run failure');
});

test('a refreshAudioMeta call while a run is active returns the active promise and coalesces into exactly one rerun, never running in parallel', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  upsertItem(db, makeItem({ rel_path: 'Musik/A.mp3' }), 1000);

  let active = 0;
  let maxActive = 0;
  /** @type {string[]} */
  const seen = [];
  let addedSecondItem = false;
  /** @type {ReturnType<typeof createAudioMetaPass>} */
  let pass;
  /** @type {Promise<void> | undefined} */
  let capturedRerunPromise;
  const readTags = async (/** @type {string} */ absPath) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    seen.push(absPath);
    if (!addedSecondItem) {
      addedSecondItem = true;
      upsertItem(db, makeItem({ rel_path: 'Musik/B.mp3' }), 2000);
      capturedRerunPromise = pass.refreshAudioMeta();
    }
    await tick();
    active -= 1;
    return tagsStub();
  };
  const { log } = makeLog();
  pass = createAudioMetaPass({ db, mediaRoot: '/media', log, readTags, resolvePath });
  const p1 = pass.refreshAudioMeta();
  await p1;

  assert.equal(capturedRerunPromise, p1, 'the coalesced call returns the same, already-active promise');
  assert.deepEqual(seen, ['/media/Musik/A.mp3', '/media/Musik/B.mp3'], 'exactly one rerun picked up the item added mid-pass');
  assert.equal(maxActive, 1, 'never runs in parallel');
});

test('db.isOpen going false mid-pass ends the run quietly: no log line, no coalesced rerun', async () => {
  const db = makeDb();
  upsertItem(db, makeItem({ rel_path: 'Musik/A.mp3' }), 1000);
  upsertItem(db, makeItem({ rel_path: 'Musik/B.mp3' }), 1000);
  const { log, calls } = makeLog();
  let readTagsCalls = 0;
  /** @type {ReturnType<typeof createAudioMetaPass>} */
  let pass;
  const readTags = async () => {
    readTagsCalls += 1;
    db.close();
    pass.refreshAudioMeta(); // arriving right as the DB closes must not schedule a rerun
    return tagsStub();
  };
  pass = createAudioMetaPass({ db, mediaRoot: '/media', log, readTags, resolvePath });
  await pass.refreshAudioMeta();

  assert.equal(readTagsCalls, 1, 'the run stops at the first item once the DB is closed');
  assert.deepEqual(calls, [], 'no audio_meta_pass / audio_meta_pass_failed / audio_meta_read_failed line is logged');
});

test('a run that processes at least one item logs audio_meta_pass with processed/failed/durationMs', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  upsertItem(db, makeItem({ rel_path: 'Musik/A.mp3' }), 1000);
  upsertItem(db, makeItem({ rel_path: 'Musik/B.mp3' }), 1000);
  const { log, calls } = makeLog();
  const readTags = async () => tagsStub();
  const pass = createAudioMetaPass({ db, mediaRoot: '/media', log, readTags, resolvePath, now: () => 42 });
  await pass.refreshAudioMeta();

  const line = calls.find((c) => c.event === 'audio_meta_pass');
  assert.ok(line);
  assert.equal(line.level, 'info');
  assert.equal(line.fields?.processed, 2);
  assert.equal(line.fields?.failed, 0);
  assert.equal(line.fields?.durationMs, 0);
});
