// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertItem } from '../../src/db/library-repo.js';
import { createAudioMetaPass } from '../../src/library/audio-meta.js';
import { makeDb, makeItem, makeLog, resolvePath, tagsStub, tick } from '../helpers/audio-meta-seed.js';

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

test('an item whose path no longer resolves gets no row and counts as failed', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const goneId = upsertItem(db, makeItem({ rel_path: 'Musik/Gone.mp3' }), 1000);
  upsertItem(db, makeItem({ rel_path: 'Musik/Here.mp3' }), 1000);
  const { log, calls } = makeLog();
  const resolveSome = async (/** @type {string} */ root, /** @type {string} */ relPath) =>
    (relPath.endsWith('Gone.mp3') ? null : `${root}/${relPath}`);
  const pass = createAudioMetaPass({ db, mediaRoot: '/media', log, readTags: async () => tagsStub(), resolvePath: resolveSome });
  await pass.refreshAudioMeta();

  assert.equal(db.prepare('SELECT * FROM audio_meta WHERE item_id = ?').get(goneId), undefined);
  const line = calls.find((c) => c.event === 'audio_meta_pass');
  assert.equal(line?.fields?.processed, 1);
  assert.equal(line?.fields?.failed, 1);
});

test('a non-FK DB error ends the run with one audio_meta_pass_failed line and no rerun', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  upsertItem(db, makeItem({ rel_path: 'Musik/A.mp3' }), 1000);
  const { log, calls } = makeLog();
  const readTags = async () => {
    db.exec('DROP TABLE audio_meta'); // every later upsert fails with a non-FK error
    return tagsStub();
  };
  const pass = createAudioMetaPass({ db, mediaRoot: '/media', log, readTags, resolvePath });
  await pass.refreshAudioMeta();

  const failures = calls.filter((c) => c.event === 'audio_meta_pass_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].level, 'error');
  assert.match(String(failures[0].fields?.error), /audio_meta/);
  assert.equal(calls.some((c) => c.event === 'audio_meta_pass'), false);
});

test('a readTags rejection while the DB is closing logs nothing', async () => {
  const db = makeDb();
  upsertItem(db, makeItem({ rel_path: 'Musik/A.mp3' }), 1000);
  const { log, calls } = makeLog();
  const readTags = async () => {
    db.close();
    throw new Error('handle closed');
  };
  const pass = createAudioMetaPass({ db, mediaRoot: '/media', log, readTags, resolvePath });
  await pass.refreshAudioMeta();

  assert.deepEqual(calls, []);
});

test('idle() resolves at once when no run is active, and only after the active run (incl. its coalesced rerun) otherwise', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  upsertItem(db, makeItem({ rel_path: 'Musik/A.mp3' }), 1000);
  const { log } = makeLog();
  const readTags = async () => {
    await tick();
    return tagsStub();
  };
  const pass = createAudioMetaPass({ db, mediaRoot: '/media', log, readTags, resolvePath });
  await pass.idle(); // nothing running: must not hang

  const countRows = () => /** @type {any} */ (db.prepare('SELECT COUNT(*) AS n FROM audio_meta').get()).n;
  const run = pass.refreshAudioMeta();
  upsertItem(db, makeItem({ rel_path: 'Musik/B.mp3' }), 2000);
  pass.refreshAudioMeta(); // coalesced rerun picks up B
  let rowsAtIdle = -1;
  await pass.idle().then(() => { rowsAtIdle = countRows(); });
  assert.equal(rowsAtIdle, 2, 'idle() waits for the first pass and its rerun');
  await run;
});
