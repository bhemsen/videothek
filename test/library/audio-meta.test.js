// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertItem } from '../../src/db/library-repo.js';
import { upsertAudioMeta } from '../../src/db/audio-meta-repo.js';
import { AUDIO_META_VERSION, createAudioMetaPass } from '../../src/library/audio-meta.js';
import { makeDb, makeItem, makeLog, resolvePath, tagsStub } from '../helpers/audio-meta-seed.js';

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

test('an audiobooks item is resolved by the audiobook parser — folder disc number as fallback, author/book as grouping', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const id = upsertItem(db, makeItem({
    rel_path: 'Hörbücher/Anna Autorin/Langes Buch/CD 2/03 Teil.mp3',
    dir: 'Hörbücher/Anna Autorin/Langes Buch/CD 2', category: 'audiobooks',
  }), 1000);
  const { log } = makeLog();
  const pass = createAudioMetaPass({ db, mediaRoot: '/media', log, readTags: async () => tagsStub(), resolvePath });
  await pass.refreshAudioMeta();

  const row = /** @type {any} */ (db.prepare('SELECT * FROM audio_meta WHERE item_id = ?').get(id));
  assert.equal(row?.group_key, 'Hörbücher/Anna Autorin/Langes Buch');
  assert.equal(row?.group_title, 'Langes Buch');
  assert.equal(row?.group_artist, 'Anna Autorin');
  assert.equal(row?.disc_no, 2);
  assert.equal(row?.track_no, 3);
  assert.equal(row?.title, 'Teil');
});

test('with the default readAudioTags, a non-mp3/flac item gets its path-only row without opening the file', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const id = upsertItem(db, makeItem({ rel_path: 'Musik/Klangwerk/Album/02 Stück.ogg', dir: 'Musik/Klangwerk/Album', ext: 'ogg' }), 1000);
  const { log, calls } = makeLog();
  // resolvePath points at a non-existent file: any open attempt would reject and log audio_meta_read_failed.
  const pass = createAudioMetaPass({ db, mediaRoot: '/does-not-exist', log, resolvePath });
  await pass.refreshAudioMeta();

  const row = /** @type {any} */ (db.prepare('SELECT * FROM audio_meta WHERE item_id = ?').get(id));
  assert.equal(row?.title, 'Stück');
  assert.equal(row?.tag_format, null);
  assert.equal(calls.some((c) => c.event === 'audio_meta_read_failed'), false);
});
