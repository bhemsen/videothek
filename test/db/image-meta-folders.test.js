import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  insertMetaStubs,
  folderExists,
  listFolderItems,
  listSubtreeFolderCounts,
  findFolderCover,
  saveMeta,
} from '../../src/db/image-meta.js';
import { makeDb, insertItem } from '../helpers/image-meta-seed.js';

test('folderExists: root always exists, exact and subtree matches use exact ranges even with _ and % in names', () => {
  const db = makeDb();
  try {
    assert.equal(folderExists(db, ''), true, 'root exists even in an empty library');
    assert.equal(folderExists(db, 'Urlaub'), false);
    const italien = insertItem(db, { rel_path: 'Bilder/Urlaub/Italien/a.jpg', dir: 'Bilder/Urlaub/Italien' });
    insertMetaStubs(db, [{ itemId: italien, folder: 'Urlaub/Italien' }]);
    assert.equal(folderExists(db, 'Urlaub/Italien'), true, 'exact match');
    assert.equal(folderExists(db, 'Urlaub'), true, 'ancestor exists via the subtree range');
    assert.equal(folderExists(db, 'Urlaub/Ital'), false, 'a prefix that is not a real segment does not match');
    const extra = insertItem(db, { rel_path: 'Bilder/Urlaub Extra/b.jpg', dir: 'Bilder/Urlaub Extra' });
    insertMetaStubs(db, [{ itemId: extra, folder: 'Urlaub Extra' }]);
    assert.equal(folderExists(db, 'Urlaub Extra'), true);
    const weird = insertItem(db, { rel_path: 'Bilder/A_B%C/c.jpg', dir: 'Bilder/A_B%C' });
    insertMetaStubs(db, [{ itemId: weird, folder: 'A_B%C' }]);
    assert.equal(folderExists(db, 'A_B%C'), true, 'literal _ and % are matched exactly, not as LIKE wildcards');
    assert.equal(folderExists(db, 'A'), false, 'A_B%C does not start with A/, so A itself does not exist');
  } finally {
    db.close();
  }
});

test('listFolderItems loads only direct children, unsorted, with the full ItemRow shape', () => {
  const db = makeDb();
  try {
    const a1 = insertItem(db, { rel_path: 'Bilder/A/a1.jpg', dir: 'Bilder/A' });
    const a2 = insertItem(db, { rel_path: 'Bilder/A/a2.jpg', dir: 'Bilder/A', kind: 'video', ext: 'mp4', playable: 0 });
    const nested = insertItem(db, { rel_path: 'Bilder/A/Sub/n.jpg', dir: 'Bilder/A/Sub' });
    insertMetaStubs(db, [{ itemId: a1, folder: 'A' }, { itemId: a2, folder: 'A' }, { itemId: nested, folder: 'A/Sub' }]);
    const items = listFolderItems(db, 'A');
    assert.deepEqual(items.map((r) => r.id).sort(), [a1, a2].sort());
    const video = items.find((r) => r.id === a2);
    assert.equal(video?.kind, 'video');
    assert.equal(video?.playable, false, 'playable is boolean, not 0/1');
    const image = items.find((r) => r.id === a1);
    assert.equal(image?.takenAt, null);
    assert.equal(image?.thumbOffset, null);
    saveMeta(db, a1, { takenAt: '2024-07-14T09:14:00', orientation: 6, thumbOffset: 512, thumbLength: 4096, sourceSize: 1000, sourceMtimeMs: 1_700_000_000_000, metaVersion: 1 });
    assert.deepEqual(listFolderItems(db, 'A').find((r) => r.id === a1), {
      id: a1, relPath: 'Bilder/A/a1.jpg', kind: 'image', playable: true, size: 1000, mtimeMs: 1_700_000_000_000,
      takenAt: '2024-07-14T09:14:00', orientation: 6, thumbOffset: 512, thumbLength: 4096,
      sourceSize: 1000, sourceMtimeMs: 1_700_000_000_000,
    }, 'exactly the spec ItemRow keys, meta fields as stored');
    assert.deepEqual(listFolderItems(db, ''), [], 'root has no direct items here');
  } finally {
    db.close();
  }
});

test('listSubtreeFolderCounts aggregates per exact folder below key, root treated as prefix ""', () => {
  const db = makeDb();
  try {
    const y1 = insertItem(db, { rel_path: 'Bilder/X/Y/1.jpg', dir: 'Bilder/X/Y' });
    const y2 = insertItem(db, { rel_path: 'Bilder/X/Y/2.jpg', dir: 'Bilder/X/Y' });
    const z1 = insertItem(db, { rel_path: 'Bilder/X/Z/1.jpg', dir: 'Bilder/X/Z' });
    const direct = insertItem(db, { rel_path: 'Bilder/X/1.jpg', dir: 'Bilder/X' });
    insertMetaStubs(db, [
      { itemId: y1, folder: 'X/Y' },
      { itemId: y2, folder: 'X/Y' },
      { itemId: z1, folder: 'X/Z' },
      { itemId: direct, folder: 'X' },
    ]);
    /** @param {{ folder: string }} a @param {{ folder: string }} b */
    const byFolder = (a, b) => a.folder.localeCompare(b.folder);
    assert.deepEqual(listSubtreeFolderCounts(db, 'X').map((r) => ({ ...r })).sort(byFolder), [
      { folder: 'X/Y', count: 2 },
      { folder: 'X/Z', count: 1 },
    ]);
    assert.deepEqual(listSubtreeFolderCounts(db, '').map((r) => ({ ...r })).sort(byFolder), [
      { folder: 'X', count: 1 },
      { folder: 'X/Y', count: 2 },
      { folder: 'X/Z', count: 1 },
    ]);
  } finally {
    db.close();
  }
});

test('listSubtreeFolderCounts uses exact range bounds: a LIKE "_" wildcard would over-match, the range must not', () => {
  const db = makeDb();
  try {
    const wild = insertItem(db, { rel_path: 'Bilder/A_B/x/1.jpg', dir: 'Bilder/A_B/x' });
    const decoy = insertItem(db, { rel_path: 'Bilder/AxB/y/1.jpg', dir: 'Bilder/AxB/y' });
    insertMetaStubs(db, [
      { itemId: wild, folder: 'A_B/x' },
      { itemId: decoy, folder: 'AxB/y' },
    ]);
    // LIKE 'A\_B/%' would treat '_' as "any one character" and also match
    // folder 'AxB/y'; the range bounds must exclude it.
    assert.deepEqual(
      listSubtreeFolderCounts(db, 'A_B').map((r) => ({ ...r })),
      [{ folder: 'A_B/x', count: 1 }],
      'only the literal A_B subtree matches, not AxB'
    );
    db.prepare("DELETE FROM image_meta WHERE folder = 'A_B/x'").run();
    assert.equal(folderExists(db, 'A_B'), false, 'only AxB/y exists: A_B must not match it as a wildcard');
    assert.equal(findFolderCover(db, 'A_B'), null, 'no cover leaks in from AxB/y');
    assert.equal(findFolderCover(db, 'AxB')?.id, decoy);
  } finally {
    db.close();
  }
});

test('listSubtreeFolderCounts uses exact range bounds: a LIKE "%" wildcard would over-match, the range must not', () => {
  const db = makeDb();
  try {
    const wild = insertItem(db, { rel_path: 'Bilder/A%B/x/1.jpg', dir: 'Bilder/A%B/x' });
    const decoy = insertItem(db, { rel_path: 'Bilder/AxB/y/1.jpg', dir: 'Bilder/AxB/y' });
    insertMetaStubs(db, [
      { itemId: wild, folder: 'A%B/x' },
      { itemId: decoy, folder: 'AxB/y' },
    ]);
    // LIKE 'A\%B/%' would treat '%' as "any sequence of characters" and also
    // match folder 'AxB/y'; the range bounds must exclude it.
    assert.deepEqual(
      listSubtreeFolderCounts(db, 'A%B').map((r) => ({ ...r })),
      [{ folder: 'A%B/x', count: 1 }],
      'only the literal A%B subtree matches, not AxB'
    );
    db.prepare("DELETE FROM image_meta WHERE folder = 'A%B/x'").run();
    assert.equal(folderExists(db, 'A%B'), false, 'only AxB/y exists: A%B must not match it as a wildcard');
    assert.equal(findFolderCover(db, 'A%B'), null, 'no cover leaks in from AxB/y');
  } finally {
    db.close();
  }
});

test('findFolderCover picks the first playable image in (folder, rel_path) binary order across the whole subtree', () => {
  const db = makeDb();
  try {
    const b = insertItem(db, { rel_path: 'Bilder/A/b.jpg', dir: 'Bilder/A' });
    const a = insertItem(db, { rel_path: 'Bilder/A/a.jpg', dir: 'Bilder/A' });
    const nonPlayable = insertItem(db, { rel_path: 'Bilder/A/000.heic', dir: 'Bilder/A', playable: 0 });
    const video = insertItem(db, { rel_path: 'Bilder/A/001.mp4', dir: 'Bilder/A', kind: 'video', ext: 'mp4' });
    const deeper = insertItem(db, { rel_path: 'Bilder/A/Sub/c.jpg', dir: 'Bilder/A/Sub' });
    const sibling = insertItem(db, { rel_path: 'Bilder/A Extra/000.jpg', dir: 'Bilder/A Extra' });
    insertMetaStubs(db, [
      { itemId: b, folder: 'A' },
      { itemId: a, folder: 'A' },
      { itemId: nonPlayable, folder: 'A' },
      { itemId: video, folder: 'A' },
      { itemId: deeper, folder: 'A/Sub' },
      { itemId: sibling, folder: 'A Extra' },
    ]);
    assert.equal(findFolderCover(db, 'A')?.id, a, 'lowest rel_path among playable images in folder A itself wins');
    assert.equal(findFolderCover(db, 'A/Sub')?.id, deeper);
    assert.equal(findFolderCover(db, 'Nope'), null);
  } finally {
    db.close();
  }
});

test('findFolderCover orders by folder before rel_path: a shallower folder wins even when its rel_path sorts later', () => {
  const db = makeDb();
  try {
    const z = insertItem(db, { rel_path: 'Bilder/A/z.jpg', dir: 'Bilder/A' });
    const subA = insertItem(db, { rel_path: 'Bilder/A/Sub/a.jpg', dir: 'Bilder/A/Sub' });
    insertMetaStubs(db, [
      { itemId: z, folder: 'A' },
      { itemId: subA, folder: 'A/Sub' },
    ]);
    // By rel_path alone, 'Bilder/A/Sub/a.jpg' < 'Bilder/A/z.jpg' ('S' < 'z'),
    // but ORDER BY folder first must still pick folder 'A' before 'A/Sub'.
    assert.equal(findFolderCover(db, 'A')?.id, z, 'folder order wins over rel_path order');
  } finally {
    db.close();
  }
});

test('findFolderCover sorts rel_path in BINARY order, not NOCASE', () => {
  const db = makeDb();
  try {
    const upper = insertItem(db, { rel_path: 'Bilder/A/B.jpg', dir: 'Bilder/A' });
    const lower = insertItem(db, { rel_path: 'Bilder/A/a.jpg', dir: 'Bilder/A' });
    insertMetaStubs(db, [
      { itemId: upper, folder: 'A' },
      { itemId: lower, folder: 'A' },
    ]);
    // Under NOCASE, 'a.jpg' would compare as 'A.jpg' and sort before 'B.jpg'.
    // Default BINARY collation sorts 'B' (0x42) before 'a' (0x61).
    assert.equal(findFolderCover(db, 'A')?.id, upper, 'binary collation: uppercase sorts before lowercase');
    const inUpperFolder = insertItem(db, { rel_path: 'Bilder/P/B/x.jpg', dir: 'Bilder/P/B' });
    const inLowerFolder = insertItem(db, { rel_path: 'Bilder/P/a/x.jpg', dir: 'Bilder/P/a' });
    insertMetaStubs(db, [{ itemId: inLowerFolder, folder: 'P/a' }, { itemId: inUpperFolder, folder: 'P/B' }]);
    // Under NOCASE, folder 'P/a' would sort before 'P/B'; BINARY puts 'B' first.
    assert.equal(findFolderCover(db, 'P')?.id, inUpperFolder, 'folder is compared in binary order too');
  } finally {
    db.close();
  }
});

test('findFolderCover with the root key covers the whole library, not just root-level items', () => {
  const db = makeDb();
  try {
    const nested = insertItem(db, { rel_path: 'Bilder/A/a.jpg', dir: 'Bilder/A' });
    insertMetaStubs(db, [{ itemId: nested, folder: 'A' }]);
    assert.equal(findFolderCover(db, '')?.id, nested, 'root has no direct items, but the subtree still has one');
  } finally {
    db.close();
  }
});
