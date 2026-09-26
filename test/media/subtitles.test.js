import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listSubtitles, SUBTITLE_CONTENT_TYPE } from '../../src/media/subtitles.js';

/** @param {string} prefix */
async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * @param {string} dir
 * @param {string} name
 */
async function writeFile(dir, name) {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, 'x');
  return filePath;
}

/** @param {string} dir */
async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/** @param {Array<{ index: number, lang: string | null, label: string | null, path: string }>} tracks */
function stripPaths(tracks) {
  return tracks.map(({ index, lang, label }) => ({ index, lang, label }));
}

/**
 * @param {unknown} err
 * @returns {err is NodeJS.ErrnoException}
 */
function isErrnoException(err) {
  return err instanceof Error && 'code' in err;
}

test('listSubtitles: finds sidecars with the decided lang/label, sorted by code-unit order', async (t) => {
  const root = await makeTempDir('vt-subs-');
  t.after(() => cleanup(root));
  await writeFile(root, 'movie.mp4');
  const names = ['movie.vtt', 'movie.de.vtt', 'movie.Deutsch.vtt', 'MOVIE.EN.VTT'];
  for (const name of names) await writeFile(root, name);

  const result = await listSubtitles(root, { kind: 'video', rel_path: 'movie.mp4' });

  assert.deepEqual(stripPaths(result), [
    { index: 0, lang: 'en', label: 'EN' },
    { index: 1, lang: null, label: 'Deutsch' },
    { index: 2, lang: 'de', label: 'de' },
    { index: 3, lang: null, label: null },
  ]);
  const expectedOrder = ['MOVIE.EN.VTT', 'movie.Deutsch.vtt', 'movie.de.vtt', 'movie.vtt'];
  assert.deepEqual(
    result.map((r) => r.path),
    await Promise.all(expectedOrder.map((name) => fs.realpath(path.join(root, name)))),
  );
});

test('listSubtitles: ignores files that are not this video\'s sidecars', async (t) => {
  const root = await makeTempDir('vt-subs-');
  t.after(() => cleanup(root));
  await writeFile(root, 'clip.mp4');
  await writeFile(root, 'other.mp4');
  await writeFile(root, 'other.vtt'); // another video's sidecar
  await writeFile(root, 'clip.srt'); // wrong extension
  await fs.mkdir(path.join(root, 'clip.vtt')); // a directory, not a file
  await writeFile(root, `clip.${'a'.repeat(65)}.vtt`); // middle > 64 chars
  await writeFile(root, 'clip.de.vtt'); // the only real sidecar

  const result = await listSubtitles(root, { kind: 'video', rel_path: 'clip.mp4' });

  assert.deepEqual(stripPaths(result), [{ index: 0, lang: 'de', label: 'de' }]);
  assert.equal(result[0].path, await fs.realpath(path.join(root, 'clip.de.vtt')));
});

test('listSubtitles: a symlinked .vtt sidecar is ignored', async (t) => {
  const root = await makeTempDir('vt-subs-');
  t.after(() => cleanup(root));
  await writeFile(root, 'clip2.mp4');
  const target = await writeFile(root, 'real-target.vtt');
  const link = path.join(root, 'clip2.de.vtt');

  try {
    await fs.symlink(target, link, 'file');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'EPERM') {
      t.skip('file symlinks require elevated privileges on this platform');
      return;
    }
    throw err;
  }

  const result = await listSubtitles(root, { kind: 'video', rel_path: 'clip2.mp4' });
  assert.deepEqual(result, []);
});

test('listSubtitles: an unrecognised suffix keeps the whole suffix as the label with no lang', async (t) => {
  const root = await makeTempDir('vt-subs-');
  t.after(() => cleanup(root));
  await writeFile(root, 'item3.mp4');
  await writeFile(root, 'item3.de.forced.vtt');

  const result = await listSubtitles(root, { kind: 'video', rel_path: 'item3.mp4' });

  assert.deepEqual(stripPaths(result), [{ index: 0, lang: null, label: 'de.forced' }]);
});

test('listSubtitles: matches across NFC/NFD-normalised names, case-insensitively', async (t) => {
  const root = await makeTempDir('vt-subs-');
  t.after(() => cleanup(root));
  const nfd = 'café'; // "café" as e + combining acute accent
  await writeFile(root, `${nfd}.mp4`);
  await writeFile(root, 'CAFÉ.de.vtt'); // NFC precomposed, upper-cased

  const result = await listSubtitles(root, { kind: 'video', rel_path: `${nfd}.mp4` });

  assert.deepEqual(stripPaths(result), [{ index: 0, lang: 'de', label: 'de' }]);
});

test('listSubtitles: a non-video row returns []', async (t) => {
  const root = await makeTempDir('vt-subs-');
  t.after(() => cleanup(root));
  await writeFile(root, 'song.mp3');
  await writeFile(root, 'song.vtt');
  await writeFile(root, 'photo.jpg');
  await writeFile(root, 'photo.vtt');

  assert.deepEqual(await listSubtitles(root, { kind: 'audio', rel_path: 'song.mp3' }), []);
  assert.deepEqual(await listSubtitles(root, { kind: 'image', rel_path: 'photo.jpg' }), []);
});

test('listSubtitles: a missing directory returns []', async (t) => {
  const root = await makeTempDir('vt-subs-');
  t.after(() => cleanup(root));

  const result = await listSubtitles(root, { kind: 'video', rel_path: 'no-such-dir/movie.mp4' });
  assert.deepEqual(result, []);
});

test('listSubtitles: an item outside the media root returns []', async (t) => {
  const root = await makeTempDir('vt-subs-');
  t.after(() => cleanup(root));

  const result = await listSubtitles(root, { kind: 'video', rel_path: '../escape.mp4' });
  assert.deepEqual(result, []);
});

test('SUBTITLE_CONTENT_TYPE is the WebVTT content type with a UTF-8 charset', () => {
  assert.equal(SUBTITLE_CONTENT_TYPE, 'text/vtt; charset=utf-8');
});
