// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConversion } from '../../src/db/conversions.js';
import { runCleanup, VANISHED_GRACE_MS } from '../../src/convert/cleanup.js';
import { WORK_AREA_NAME } from '../../src/convert/work-dir.js';
import { storageKey } from '../../src/convert/targets.js';
import {
  cleanupFixture, addItem, addConversion, addPlayableCopy, writeCopy, exists, itemFlags, NOW, DAY_MS,
} from '../helpers/cleanup-fixtures.js';

const HEX = 'a'.repeat(64);

/** @param {{ calls: { event: string, fields?: Record<string, unknown> }[] }} f @param {string} event */
const events = (f, event) => f.calls.filter((c) => c.event === event);

test('rule 1: marks a row whose item is gone, clears it when the item is back, logs missing', async (t) => {
  const f = await cleanupFixture(t);
  addConversion(f.db, 'Gone/a.mp3', { status: 'failed', outputRel: null });
  addConversion(f.db, 'Back/b.mp3', { status: 'failed', outputRel: null, missingSince: 5 });
  await addItem(f, 'Back/b.mp3');
  const stats = await runCleanup(f.ctx());
  assert.equal(stats.missing, 1);
  assert.equal(getConversion(f.db, 'Gone/a.mp3')?.missing_since, NOW);
  assert.equal(getConversion(f.db, 'Back/b.mp3')?.missing_since, null);
  assert.deepEqual(events(f, 'conversion_cleanup')[0].fields, { purged: 0, stripped: 0, reconciled: 0, orphans: 0, missing: 1 });
});

test('rule 2: deletes rows missing for more than 30 days (any status but converting) and their directory', async (t) => {
  const f = await cleanupFixture(t);
  const old = NOW - VANISHED_GRACE_MS - 1;
  const keep = await addPlayableCopy(f, 'Keep/k.mp3');
  const k1 = addConversion(f.db, 'Old/queued.mp3', { status: 'queued', outputRel: null, missingSince: old });
  const k2 = addConversion(f.db, 'Old/playable.mp3', { missingSince: old });
  const k3 = addConversion(f.db, 'Old/converting.mp3', { status: 'converting', outputRel: null, missingSince: old });
  const k4 = addConversion(f.db, 'Recent/r.mp3', { missingSince: NOW - 29 * DAY_MS });
  for (const k of [k1, k2, k3, k4]) await writeCopy(f.convertDirReal, k);
  const stats = await runCleanup(f.ctx());
  assert.equal(stats.purged, 2);
  assert.equal(getConversion(f.db, 'Old/queued.mp3'), undefined);
  assert.equal(getConversion(f.db, 'Old/playable.mp3'), undefined);
  assert.ok(getConversion(f.db, 'Old/converting.mp3'));
  assert.ok(getConversion(f.db, 'Recent/r.mp3'));
  assert.equal(await exists(path.join(f.convertDirReal, k1)), false);
  assert.equal(await exists(path.join(f.convertDirReal, k2)), false);
  assert.equal(await exists(path.join(f.convertDirReal, k3)), true);
  assert.equal(await exists(path.join(f.convertDirReal, k4)), true);
  assert.equal(await exists(path.join(f.convertDirReal, keep.key)), true);
});

test('rule 3: a changed on-disk source deletes the row, resets the item flags in the same step and removes the directory', async (t) => {
  const f = await cleanupFixture(t);
  const rel = 'Buch/stale.mp3';
  const { key } = await addPlayableCopy(f, rel);
  await addPlayableCopy(f, 'Buch/other.mp3'); // keeps the unmounted-disk guard quiet
  assert.equal(itemFlags(f.db, rel)?.playable, 1);
  await fs.writeFile(path.join(f.mediaRoot, rel), 'a longer source after the change');
  const stats = await runCleanup(f.ctx());
  assert.equal(stats.purged, 1);
  assert.equal(getConversion(f.db, rel), undefined);
  assert.deepEqual({ ...itemFlags(f.db, rel) }, { playable: 0, scan_version: 0 });
  assert.equal(await exists(path.join(f.convertDirReal, key)), false);
  assert.equal(itemFlags(f.db, 'Buch/other.mp3')?.playable, 1);
});

test('rule 3: keeps a copy whose on-disk source matches the row although library_items holds an older stat', async (t) => {
  const f = await cleanupFixture(t);
  const rel = 'Buch/fresh.mp3';
  const { key } = await addPlayableCopy(f, rel);
  f.db.prepare('UPDATE library_items SET size = 1, mtime_ms = 2 WHERE rel_path = ?').run(rel);
  const stats = await runCleanup(f.ctx());
  assert.equal(stats.purged, 0);
  assert.equal(getConversion(f.db, rel)?.status, 'playable');
  assert.equal(await exists(path.join(f.convertDirReal, key, 'audio.flac')), true);
});

test('rule 3: a source that is gone from disk (protected root) is left alone and nothing is marked missing', async (t) => {
  const f = await cleanupFixture(t);
  const rel = 'Buch/protected.mp3';
  const { key } = await addPlayableCopy(f, rel);
  await fs.rm(path.join(f.mediaRoot, 'Buch'), { recursive: true });
  const stats = await runCleanup(f.ctx());
  assert.deepEqual(stats, { purged: 0, stripped: 0, reconciled: 0, orphans: 0, missing: 0 });
  assert.equal(getConversion(f.db, rel)?.missing_since, null, 'the item row still exists, so nothing is marked missing');
  assert.equal(getConversion(f.db, rel)?.status, 'playable');
  assert.equal(await exists(path.join(f.convertDirReal, key)), true);
  assert.equal(events(f, 'conversion_cleanup').length, 0, 'nothing changed, nothing logged');
});

test('rule 4: a failed row with output_rel loses output_rel/output_size, resets sidecars to [] and its directory goes', async (t) => {
  const f = await cleanupFixture(t);
  await addPlayableCopy(f, 'Buch/ok.mp3');
  const key = addConversion(f.db, 'Buch/failed.mp3', { status: 'failed', sidecars: '[{"file":"sub-0.vtt","lang":"de"}]' });
  await addItem(f, 'Buch/failed.mp3');
  await writeCopy(f.convertDirReal, key);
  const stats = await runCleanup(f.ctx());
  assert.equal(stats.stripped, 1);
  const row = getConversion(f.db, 'Buch/failed.mp3');
  assert.equal(row?.output_rel, null);
  assert.equal(row?.output_size, null);
  assert.equal(row?.sidecars, '[]');
  assert.equal(row?.status, 'failed');
  assert.equal(await exists(path.join(f.convertDirReal, key)), false);
});

test('rule 5: a fresh playable row whose copy file is gone is deleted, the item flags reset, the directory removed', async (t) => {
  const f = await cleanupFixture(t);
  const rel = 'Buch/lost.mp3';
  const { key } = await addPlayableCopy(f, rel);
  await addPlayableCopy(f, 'Buch/other.mp3');
  await fs.rm(path.join(f.convertDirReal, key, 'audio.flac'));
  const stats = await runCleanup(f.ctx());
  assert.equal(stats.reconciled, 1);
  assert.equal(getConversion(f.db, rel), undefined);
  assert.deepEqual({ ...itemFlags(f.db, rel) }, { playable: 0, scan_version: 0 });
  assert.equal(await exists(path.join(f.convertDirReal, key)), false);
  assert.ok(getConversion(f.db, 'Buch/other.mp3'));
});

test('rule 6: removes only unreferenced real 64-hex directories; non-hex, .videothek-work, referenced and symlinked names survive', async (t) => {
  const f = await cleanupFixture(t);
  const { key } = await addPlayableCopy(f, 'Buch/ok.mp3');
  const queuedKey = addConversion(f.db, 'Buch/queued.mp3', { status: 'queued', outputRel: null });
  await writeCopy(f.convertDirReal, queuedKey);
  await writeCopy(f.convertDirReal, HEX);
  await fs.mkdir(path.join(f.convertDirReal, 'not-a-key'));
  await fs.mkdir(path.join(f.convertDirReal, WORK_AREA_NAME, 'job'), { recursive: true });
  await fs.mkdir(path.join(f.convertDirReal, 'D'.repeat(64)));
  const outside = path.join(f.mediaRoot, 'outside-target');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'precious.txt'), 'keep');
  const linkName = 'b'.repeat(64);
  await fs.symlink(outside, path.join(f.convertDirReal, linkName), process.platform === 'win32' ? 'junction' : 'dir');
  const stats = await runCleanup(f.ctx());
  assert.equal(stats.orphans, 1);
  assert.equal(await exists(path.join(f.convertDirReal, HEX)), false);
  for (const kept of [key, queuedKey, 'not-a-key', WORK_AREA_NAME, 'D'.repeat(64), linkName]) {
    assert.equal(await exists(path.join(f.convertDirReal, kept)), true, `${kept} survives`);
  }
  assert.equal(await exists(path.join(outside, 'precious.txt')), true, 'the link target is untouched');
  assert.ok(f.removed.every((p) => path.basename(p) === HEX), 'removeDir only saw the orphan');
});

test('guard: an empty CONVERT_DIR with rows that have output_rel skips rules 5/6 and logs conversion_cleanup_skipped', async (t) => {
  const f = await cleanupFixture(t);
  const rel = 'Buch/unmounted.mp3';
  const { key } = await addPlayableCopy(f, rel);
  await fs.rm(path.join(f.convertDirReal, key), { recursive: true });
  const stats = await runCleanup(f.ctx());
  assert.equal(stats.reconciled, 0);
  assert.equal(getConversion(f.db, rel)?.status, 'playable');
  assert.equal(itemFlags(f.db, rel)?.playable, 1);
  assert.deepEqual(events(f, 'conversion_cleanup_skipped')[0].fields, { reason: 'convert_dir_empty' });
});

test('guard: hex directories but not a single referenced copy file skips rules 5/6 and keeps the orphan', async (t) => {
  const f = await cleanupFixture(t);
  const { key } = await addPlayableCopy(f, 'Buch/a.mp3');
  await fs.rm(path.join(f.convertDirReal, key, 'audio.flac'));
  await writeCopy(f.convertDirReal, HEX);
  await runCleanup(f.ctx());
  assert.ok(getConversion(f.db, 'Buch/a.mp3'));
  assert.equal(await exists(path.join(f.convertDirReal, HEX)), true);
  assert.deepEqual(events(f, 'conversion_cleanup_skipped')[0].fields, { reason: 'no_copy_found' });
});

test('guard: with no row that has output_rel an empty CONVERT_DIR is fine (no skip)', async (t) => {
  const f = await cleanupFixture(t);
  await writeCopy(f.convertDirReal, HEX);
  const stats = await runCleanup(f.ctx());
  assert.equal(stats.orphans, 1);
  assert.equal(events(f, 'conversion_cleanup_skipped').length, 0);
});

test('a non-ENOENT stat error (ENOTDIR) aborts the pass, deletes nothing and logs conversion_cleanup_failed', { skip: process.platform === 'win32' }, async (t) => {
  const f = await cleanupFixture(t);
  await addPlayableCopy(f, 'Buch/good.mp3');
  const bad = addConversion(f.db, 'Buch/bad.mp3');
  await addItem(f, 'Buch/bad.mp3');
  await fs.writeFile(path.join(f.convertDirReal, bad), 'a file where the directory should be');
  await writeCopy(f.convertDirReal, HEX);
  const stats = await runCleanup(f.ctx());
  assert.equal(stats.reconciled, 0);
  assert.equal(stats.orphans, 0);
  assert.deepEqual(f.removed, []);
  assert.ok(getConversion(f.db, 'Buch/bad.mp3'));
  assert.equal(await exists(path.join(f.convertDirReal, HEX)), true);
  assert.deepEqual(events(f, 'conversion_cleanup_failed')[0].fields, { code: 'ENOTDIR' });
});

test('EACCES on a copy directory deletes nothing and logs conversion_cleanup_failed', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const f = await cleanupFixture(t);
  await addPlayableCopy(f, 'Buch/good.mp3');
  const { key } = await addPlayableCopy(f, 'Buch/locked.mp3');
  await writeCopy(f.convertDirReal, HEX);
  await fs.chmod(path.join(f.convertDirReal, key), 0o000);
  t.after(() => fs.chmod(path.join(f.convertDirReal, key), 0o755));
  await runCleanup(f.ctx());
  assert.deepEqual(f.removed, []);
  assert.ok(getConversion(f.db, 'Buch/locked.mp3'));
  assert.equal(await exists(path.join(f.convertDirReal, HEX)), true);
  assert.deepEqual(events(f, 'conversion_cleanup_failed')[0].fields, { code: 'EACCES' });
});

test('a removeDir rejection aborts the rest of the pass with conversion_cleanup_failed', async (t) => {
  const f = await cleanupFixture(t);
  await writeCopy(f.convertDirReal, HEX);
  await writeCopy(f.convertDirReal, 'c'.repeat(64));
  const removeDir = () => Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' }));
  await runCleanup(f.ctx({ removeDir }));
  assert.deepEqual(events(f, 'conversion_cleanup_failed')[0].fields, { code: 'EBUSY' });
  assert.equal(events(f, 'conversion_cleanup_failed').length, 1);
});

test('stopping: nothing runs when already stopping; a stop between directory removals ends the pass quietly', async (t) => {
  const f = await cleanupFixture(t);
  addConversion(f.db, 'Gone/a.mp3', { status: 'failed', outputRel: null });
  await writeCopy(f.convertDirReal, HEX);
  await writeCopy(f.convertDirReal, 'c'.repeat(64));
  f.state.stopping = true;
  await runCleanup(f.ctx());
  assert.equal(getConversion(f.db, 'Gone/a.mp3')?.missing_since, null);
  assert.deepEqual(f.removed, []);

  f.state.stopping = false;
  const removeDir = async (/** @type {string} */ target) => {
    await f.removeDir(target);
    f.state.stopping = true;
  };
  const stats = await runCleanup(f.ctx({ removeDir }));
  assert.equal(f.removed.length, 1, 'only one of two orphans is removed before the stop is noticed');
  assert.equal(stats.orphans, 1);
  assert.equal(events(f, 'conversion_cleanup_failed').length, 0);
});

test('storageKey sanity: a real key is 64 lowercase hex characters', () => {
  assert.match(storageKey('a/b.mp3'), /^[0-9a-f]{64}$/);
});
