// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { buildItem } from '../../src/library/item-builder.js';
import { SCAN_VERSION } from '../../src/library/parsers/compat.js';
import { sortKey } from '../../src/library/parsers/text.js';
import { createMediaTree, removeMediaTree, writeMediaFile } from '../helpers/media-tree.js';
import { moovBox } from '../helpers/mp4-boxes.js';

const NOW_2026 = () => Date.UTC(2026, 8, 26);

/**
 * A synthetic `fs.Stats`-shaped object carrying only the two fields
 * `buildItem` reads. Avoids real filesystem I/O for every test that does not
 * need the MP4 sniffer (a non-`sniff` extension is never opened).
 * @param {{ size?: number, mtimeMs?: number }} [overrides]
 * @returns {import('node:fs').Stats}
 */
function fakeStat({ size = 1000, mtimeMs = 1_700_000_000_000 } = {}) {
  return /** @type {import('node:fs').Stats} */ ({ size, mtimeMs });
}

test('buildItem: returns null for a kind not admitted by the category (.jpg under Filme/)', async () => {
  const row = await buildItem({
    mediaRoot: '/media',
    relPath: 'Filme/poster.jpg',
    category: 'movies',
    stat: fakeStat(),
    now: NOW_2026,
  });
  assert.equal(row, null);
});

test('buildItem: returns null for a kind not admitted by the category (.mp4 under Bilder/, pre-P6)', async () => {
  const row = await buildItem({
    mediaRoot: '/media',
    relPath: 'Bilder/clip.mp4',
    category: 'images',
    stat: fakeStat(),
    now: NOW_2026,
  });
  assert.equal(row, null);
});

for (const ext of ['nfo', 'srt', 'vtt']) {
  test(`buildItem: returns null for an unknown extension (.${ext})`, async () => {
    const row = await buildItem({
      mediaRoot: '/media',
      relPath: `Filme/Arrival (2016).${ext}`,
      category: 'movies',
      stat: fakeStat(),
      now: NOW_2026,
    });
    assert.equal(row, null);
  });
}

test('buildItem: returns null for a file with no extension at all', async () => {
  const row = await buildItem({
    mediaRoot: '/media',
    relPath: 'Filme/README',
    category: 'movies',
    stat: fakeStat(),
    now: NOW_2026,
  });
  assert.equal(row, null);
});

test('buildItem: a movie row carries the movie parser result and no series fields', async () => {
  const stat = fakeStat({ size: 1_503_238_553, mtimeMs: 1_700_000_000_000.7 });
  const row = await buildItem({
    mediaRoot: '/media',
    relPath: 'Filme/Arrival (2016).webm',
    category: 'movies',
    stat,
    now: NOW_2026,
  });

  assert.ok(row);
  assert.equal(row?.rel_path, 'Filme/Arrival (2016).webm');
  assert.equal(row?.dir, 'Filme');
  assert.equal(row?.category, 'movies');
  assert.equal(row?.kind, 'video');
  assert.equal(row?.ext, 'webm');
  assert.equal(row?.title, 'Arrival');
  assert.equal(row?.sort_title, sortKey('Arrival'));
  assert.equal(row?.year, 2016);
  assert.equal(row?.series_key, undefined);
  assert.equal(row?.series_title, undefined);
  assert.equal(row?.series_year, undefined);
  assert.equal(row?.season, null);
  assert.equal(row?.episode, null);
  assert.equal(row?.episode_end, null);
  assert.equal(row?.video_codec, null);
  assert.equal(row?.audio_codec, null);
  assert.equal(row?.playable, true);
  assert.equal(row?.size, 1_503_238_553);
  assert.equal(row?.mtime_ms, 1_700_000_000_000, 'mtime_ms = Math.trunc(stat.mtimeMs)');
  assert.equal(row?.scan_version, SCAN_VERSION);
});

test('buildItem: a movie folder fallback still resolves title/year from the ancestor folder', async () => {
  const row = await buildItem({
    mediaRoot: '/media',
    relPath: 'Filme/Inception (2010)/inception.webm',
    category: 'movies',
    stat: fakeStat(),
    now: NOW_2026,
  });
  assert.equal(row?.title, 'Inception');
  assert.equal(row?.year, 2010);
});

test('buildItem: an unplayable movie extension (mkv) is indexed but not playable', async () => {
  const row = await buildItem({
    mediaRoot: '/media',
    relPath: 'Filme/Das Boot (1981).mkv',
    category: 'movies',
    stat: fakeStat({ size: 5000 }),
    now: NOW_2026,
  });
  assert.equal(row?.playable, false);
  assert.equal(row?.video_codec, null);
});

test('buildItem: a series row carries the episode parser result plus series identity', async () => {
  const row = await buildItem({
    mediaRoot: '/media',
    relPath: 'Serien/Dark (2017)/Staffel 1/Dark S01E01 - Geheimnisse.mkv',
    category: 'series',
    stat: fakeStat({ size: 5000 }),
    now: NOW_2026,
  });

  assert.ok(row);
  assert.equal(row?.category, 'series');
  assert.equal(row?.kind, 'video');
  assert.equal(row?.title, 'Geheimnisse');
  assert.equal(row?.year, null, 'library_items.year is only used for movies');
  assert.equal(row?.series_key, 'Dark (2017)');
  assert.equal(row?.series_title, 'Dark');
  assert.equal(row?.series_year, 2017);
  assert.equal(row?.season, 1);
  assert.equal(row?.episode, 1);
  assert.equal(row?.episode_end, null);
  assert.equal(row?.playable, false, 'mkv is not playable');
});

test('buildItem: a series specials episode gets season 0', async () => {
  const row = await buildItem({
    mediaRoot: '/media',
    relPath: 'Serien/Dark (2017)/Specials/Dark S00E01 - Making-of.webm',
    category: 'series',
    stat: fakeStat(),
    now: NOW_2026,
  });
  assert.equal(row?.season, 0);
});

test('buildItem: a loose series file forms its own series key/title', async () => {
  const row = await buildItem({
    mediaRoot: '/media',
    relPath: 'Serien/Babylon.Berlin.S01E01.webm',
    category: 'series',
    stat: fakeStat(),
    now: NOW_2026,
  });
  assert.equal(row?.series_key, 'Babylon Berlin');
  assert.equal(row?.series_title, 'Babylon Berlin');
});

test('buildItem: music/audiobooks/images (P2 minimal) get only a cleaned title, no grouping', async () => {
  const row = await buildItem({
    mediaRoot: '/media',
    relPath: 'Musik/Track.01.mp3',
    category: 'music',
    stat: fakeStat(),
    now: NOW_2026,
  });
  assert.equal(row?.category, 'music');
  assert.equal(row?.kind, 'audio');
  assert.equal(row?.title, 'Track 01');
  assert.equal(row?.year, null);
  assert.equal(row?.series_key, undefined);
  assert.equal(row?.season, null);
});

test('buildItem: a zero-byte sniff-table file is not playable and is never sniffed', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  await writeMediaFile(root, 'Filme/Empty.mp4', { content: Buffer.alloc(0) });
  const stat = await fs.stat(`${root}/Filme/Empty.mp4`);

  const row = await buildItem({
    mediaRoot: root,
    relPath: 'Filme/Empty.mp4',
    category: 'movies',
    stat,
    now: NOW_2026,
  });

  assert.equal(row?.size, 0);
  assert.equal(row?.playable, false);
  assert.equal(row?.video_codec, null);
  assert.equal(row?.audio_codec, null);
});

test('buildItem: an MP4 sniffed as avc1+mp4a is playable and records both codecs', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const content = moovBox([
    { handlerType: 'vide', fourcc: 'avc1' },
    { handlerType: 'soun', fourcc: 'mp4a' },
  ]);
  await writeMediaFile(root, 'Filme/Heat (1995).mp4', { content });
  const stat = await fs.stat(`${root}/Filme/Heat (1995).mp4`);

  const row = await buildItem({
    mediaRoot: root,
    relPath: 'Filme/Heat (1995).mp4',
    category: 'movies',
    stat,
    now: NOW_2026,
  });

  assert.equal(row?.playable, true);
  assert.equal(row?.video_codec, 'avc1');
  assert.equal(row?.audio_codec, 'mp4a');
});

test('buildItem: an MP4 sniffed as hvc1 is indexed but not playable, codec still recorded', async (t) => {
  const root = await createMediaTree();
  t.after(() => removeMediaTree(root));
  const content = moovBox([
    { handlerType: 'vide', fourcc: 'hvc1' },
    { handlerType: 'soun', fourcc: 'mp4a' },
  ]);
  await writeMediaFile(root, 'Filme/Heat (1995).mp4', { content });
  const stat = await fs.stat(`${root}/Filme/Heat (1995).mp4`);

  const row = await buildItem({
    mediaRoot: root,
    relPath: 'Filme/Heat (1995).mp4',
    category: 'movies',
    stat,
    now: NOW_2026,
  });

  assert.equal(row?.playable, false);
  assert.equal(row?.video_codec, 'hvc1');
  assert.equal(row?.audio_codec, 'mp4a');
});
