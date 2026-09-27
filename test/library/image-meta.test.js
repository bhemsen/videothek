// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { open as fsOpen } from 'node:fs/promises';
import { createImageMetaSync, IMAGE_META_VERSION } from '../../src/library/image-meta.js';
import { makeDb, insertItem } from '../helpers/image-meta-seed.js';
import { createMediaTree, removeMediaTree, writeMediaFile } from '../helpers/media-tree.js';
import { buildExifJpeg } from '../helpers/exif-jpeg.js';

/** @returns {{ log: import('../../src/library/image-meta.js').Logger, calls: { info: any[], error: any[] } }} */
function fakeLog() {
  const calls = { info: /** @type {any[]} */ ([]), error: /** @type {any[]} */ ([]) };
  return {
    calls,
    log: {
      info: (event, fields) => calls.info.push({ event, fields }),
      warn: () => {},
      error: (event, fields) => calls.error.push({ event, fields }),
    },
  };
}

/** Wraps `fs.promises.open` to record every opened path and assert closure.
 * @returns {{ openFile: (p: string) => Promise<import('node:fs/promises').FileHandle>, opens: () => string[], allClosed: () => boolean }} */
function trackOpens() {
  /** @type {string[]} */
  const opens = [];
  /** @type {boolean[]} */
  const closedFlags = [];
  return {
    openFile: async (p) => {
      const handle = await fsOpen(p, 'r');
      const index = opens.push(p) - 1;
      closedFlags.push(false);
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === 'close') {
            return async () => {
              closedFlags[index] = true;
              return target.close();
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    opens: () => opens,
    allClosed: () => closedFlags.every(Boolean),
  };
}

/** @param {import('node:sqlite').DatabaseSync} db @param {number} itemId */
function metaRow(db, itemId) {
  const row = db.prepare('SELECT * FROM image_meta WHERE item_id = ?').get(itemId);
  assert.ok(row, `expected an image_meta row for item ${itemId}`);
  return row;
}

test('inserts stub rows keyed by folder for new and pre-existing items, backfilling in a later call', async () => {
  const db = makeDb();
  const idRoot = insertItem(db, { rel_path: 'Bilder/a.jpg', dir: 'Bilder' });
  const idSub = insertItem(db, { rel_path: 'Bilder/Urlaub/b.png', dir: 'Bilder/Urlaub', ext: 'png' });
  const { log } = fakeLog();
  const sync = createImageMetaSync({ db, mediaRoot: '/fake', log, resolvePath: async () => null });

  await sync.syncImageMeta();
  assert.equal(metaRow(db, idRoot).folder, '');
  assert.equal(metaRow(db, idSub).folder, 'Urlaub');

  const idLater = insertItem(db, { rel_path: 'Bilder/c.jpg', dir: 'Bilder' });
  await sync.syncImageMeta();
  assert.equal(metaRow(db, idLater).folder, '', 'a later pass backfills an item added after the first');
  assert.equal(db.prepare('SELECT count(*) AS n FROM image_meta').get()?.n, 3);
  db.close();
});

test('reads a JPEG header via one closed handle, marks PNG/video without I/O, and never touches the file', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const jpegPath = await writeMediaFile(root, 'Bilder/photo.jpg', {
    content: buildExifJpeg({ orientation: 6, dateTimeOriginal: '2024:07:14 10:28:00', thumbnail: { compression: 6 } }),
  });
  const pngPath = await writeMediaFile(root, 'Bilder/shot.png', { content: 'not-a-real-png' });
  const videoPath = await writeMediaFile(root, 'Bilder/clip.mp4', { content: 'not-a-real-mp4' });
  const [jpegStat, pngStat, videoStat] = [statSync(jpegPath), statSync(pngPath), statSync(videoPath)];
  const jpegHashBefore = createHash('sha256').update(readFileSync(jpegPath)).digest('hex');

  const db = makeDb();
  const idJpeg = insertItem(db, { rel_path: 'Bilder/photo.jpg', size: jpegStat.size, mtime_ms: Math.trunc(jpegStat.mtimeMs) });
  const idPng = insertItem(db, { rel_path: 'Bilder/shot.png', ext: 'png', size: pngStat.size, mtime_ms: Math.trunc(pngStat.mtimeMs) });
  const idVideo = insertItem(db, {
    rel_path: 'Bilder/clip.mp4', ext: 'mp4', kind: 'video', size: videoStat.size, mtime_ms: Math.trunc(videoStat.mtimeMs),
  });

  const tracker = trackOpens();
  const { log } = fakeLog();
  const sync = createImageMetaSync({ db, mediaRoot: root, log, openFile: tracker.openFile });
  await sync.syncImageMeta();

  const jpegMeta = metaRow(db, idJpeg);
  assert.equal(jpegMeta.orientation, 6);
  assert.equal(jpegMeta.taken_at, '2024-07-14T10:28:00');
  assert.ok(Number(jpegMeta.thumb_offset) > 0);
  assert.ok(Number(jpegMeta.thumb_length) > 0);
  assert.equal(jpegMeta.source_size, jpegStat.size);
  assert.equal(jpegMeta.meta_version, IMAGE_META_VERSION);

  for (const id of [idPng, idVideo]) {
    const row = metaRow(db, id);
    assert.equal(row.orientation, null);
    assert.equal(row.taken_at, null);
    assert.equal(row.thumb_offset, null);
    assert.equal(row.meta_version, IMAGE_META_VERSION);
  }

  assert.deepEqual(tracker.opens(), [jpegPath], 'only the JPEG row does file I/O');
  assert.equal(tracker.allClosed(), true);
  assert.equal(createHash('sha256').update(readFileSync(jpegPath)).digest('hex'), jpegHashBefore, 'bytes unchanged');
  assert.equal(Math.trunc(statSync(jpegPath).mtimeMs), Math.trunc(jpegStat.mtimeMs), 'mtime unchanged');
  db.close();
});

test('single-flight: 3 calls arriving during a pass coalesce into exactly one rerun', async () => {
  const db = makeDb();
  insertItem(db, { rel_path: 'Bilder/a.jpg' });
  const { log, calls } = fakeLog();
  /** @type {(value?: unknown) => void} */
  let release = () => {};
  const blocked = new Promise((resolve) => { release = resolve; });
  let blockedOnce = false;
  const resolvePath = async () => {
    if (!blockedOnce) {
      blockedOnce = true;
      await blocked;
    }
    return null;
  };
  const sync = createImageMetaSync({ db, mediaRoot: '/fake', log, resolvePath });

  const p1 = sync.syncImageMeta();
  assert.equal(sync.syncImageMeta(), p1, '2nd call while running returns the same promise');
  assert.equal(sync.syncImageMeta(), p1, '3rd call while running returns the same promise');
  assert.equal(sync.syncImageMeta(), p1, '4th call while running returns the same promise');
  release();
  await p1;
  const passes = calls.info.filter((c) => c.event === 'image_meta_synced');
  assert.equal(passes.length, 2, 'the original pass plus exactly one coalesced rerun');
  db.close();
});

test('a trigger mid-pass makes a new item stub visible before the pass ends', async () => {
  const db = makeDb();
  const idA = insertItem(db, { rel_path: 'Bilder/a.jpg' });
  const { log } = fakeLog();
  /** @type {(value?: unknown) => void} */
  let releaseA = () => {};
  const blockedA = new Promise((resolve) => { releaseA = resolve; });
  let idB = -1;
  let callCount = 0;
  let sawStubForB = false;
  const resolvePath = async (/** @type {string} */ _root, /** @type {string} */ relPath) => {
    callCount += 1;
    if (callCount === 1) {
      assert.equal(relPath, 'Bilder/a.jpg');
      await blockedA;
    } else if (relPath === 'Bilder/b.jpg') {
      sawStubForB = Boolean(db.prepare('SELECT 1 FROM image_meta WHERE item_id = ?').get(idB));
    }
    return null;
  };
  const sync = createImageMetaSync({ db, mediaRoot: '/fake', log, resolvePath });

  const pass = sync.syncImageMeta(); // synchronously blocked inside processRow(a) awaiting resolvePath
  idB = insertItem(db, { rel_path: 'Bilder/b.jpg' });
  sync.syncImageMeta(); // trigger: sets rerun while the pass is still on item a
  releaseA();
  await pass;

  assert.equal(callCount, 4, 'a then b, twice (original pass + its rerun)');
  assert.equal(sawStubForB, true, 'b already had a stub row when its header was read, within the same pass');
  db.close();
});

test('a guard null and an ENOENT open each leave their row stale and do not loop', async () => {
  const db = makeDb();
  const idGuard = insertItem(db, { rel_path: 'Bilder/guard.jpg' });
  const idMissing = insertItem(db, { rel_path: 'Bilder/missing.jpg' });
  const { log, calls } = fakeLog();
  const resolvePath = async (/** @type {string} */ _root, /** @type {string} */ relPath) =>
    (relPath === 'Bilder/guard.jpg' ? null : '/does/not/matter.jpg');
  const openFile = async () => {
    const err = /** @type {NodeJS.ErrnoException} */ (new Error('not found'));
    err.code = 'ENOENT';
    throw err;
  };
  const sync = createImageMetaSync({ db, mediaRoot: '/fake', log, resolvePath, openFile });

  await sync.syncImageMeta();

  assert.equal(metaRow(db, idGuard).source_size, null, 'left stale by the null-path guard');
  assert.equal(metaRow(db, idMissing).source_size, null, 'left stale by the ENOENT open');
  const synced = calls.info.find((c) => c.event === 'image_meta_synced');
  assert.equal(synced?.fields.failed, 2);
  assert.equal(synced?.fields.read, 0);
  db.close();
});

test('a closed DB ends the pass quietly, without any log line', async () => {
  const db = makeDb();
  insertItem(db);
  db.close();
  const { log, calls } = fakeLog();
  const sync = createImageMetaSync({ db, mediaRoot: '/fake', log });

  await sync.syncImageMeta();

  assert.deepEqual(calls.info, []);
  assert.deepEqual(calls.error, []);
});
