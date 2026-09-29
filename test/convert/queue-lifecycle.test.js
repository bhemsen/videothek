// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConversion } from '../../src/db/conversions.js';
import { getItemByRelPath } from '../../src/db/library-repo.js';
import { createConversionQueue } from '../../src/convert/queue.js';
import { WORK_AREA_NAME } from '../../src/convert/work-dir.js';
import { TARGETS } from '../../src/convert/targets.js';
import {
  REL_PATH, makeDb, makeTempDir, fakeConfig, fakeLogger, stubCmd, missingExecutablePath,
  enqueueSource, waitUntil, countEvent, makeSentinel, assertSentinelUnchanged, assertNoLeakedPaths,
} from '../helpers/queue-lifecycle-setup.js';

/**
 * The real queue/job/runner/verify chain against `test/helpers/converter-stub.js`
 * (docs/specs/spec-conversion-core.md, `test/convert/queue-lifecycle.test.js`):
 * one job outcome per test, no fake `run`. Cleanup-specific cases (an
 * injected `removeDir` rejection) live in `queue-lifecycle-cleanup.test.js`.
 */

/**
 * A fresh temp `MEDIA_ROOT`/`CONVERT_DIR` plus DB, logger and sentinel dir
 * for one job outcome case.
 * @param {import('node:test').TestContext} t
 */
async function fixture(t) {
  const db = makeDb();
  t.after(() => { if (db.isOpen) db.close(); });
  const mediaRoot = await makeTempDir(t, 'vt-lifecycle-media-');
  const convertDirReal = await makeTempDir(t, 'vt-lifecycle-convert-');
  const sentinel = await makeSentinel(t);
  const { log, calls: logCalls } = fakeLogger();
  return { db, mediaRoot, convertDirReal, sentinel, log, logCalls };
}

/**
 * Starts a queue against `converterCmd`, kicks it once, and waits for the
 * single enqueued job to finish.
 * @param {{ db: import('node:sqlite').DatabaseSync, mediaRoot: string, convertDirReal: string, log: any, logCalls: any[] }} f
 * @param {readonly string[]} converterCmd
 * @param {Partial<Parameters<typeof createConversionQueue>[0]>} [extra]
 */
async function runOneJob(f, converterCmd, extra = {}) {
  const queue = createConversionQueue({
    db: f.db, config: fakeConfig(f.mediaRoot, f.convertDirReal, converterCmd), log: f.log, now: () => 1, ...extra,
  });
  assert.equal(await queue.start(), true, 'queue.start() must succeed against a real temp CONVERT_DIR');
  queue.kick();
  await waitUntil(() => countEvent(f.logCalls, 'conversion_finished') === 1);
  return queue;
}

/** @param {string} convertDirReal */
async function workAreaEntries(convertDirReal) {
  return fs.readdir(path.join(convertDirReal, WORK_AREA_NAME));
}

test('ok publishes <key>/web.mp4 with the flag and output_size, and removes the work dir', async (t) => {
  const f = await fixture(t);
  const { key } = await enqueueSource(f.db, f.mediaRoot, {});

  await runOneJob(f, stubCmd('ok'));

  const row = getConversion(f.db, REL_PATH);
  assert.equal(row?.status, 'playable');
  assert.equal(row?.error, null);
  assert.equal(row?.output_rel, `${key}/${TARGETS.web.file}`);
  assert.ok((row?.output_size ?? 0) > 0);
  const outFile = path.join(f.convertDirReal, key, TARGETS.web.file);
  assert.equal((await fs.stat(outFile)).size, row?.output_size);
  assert.equal(getItemByRelPath(f.db, REL_PATH)?.playable, 1);
  assert.deepEqual(await workAreaEntries(f.convertDirReal), [], 'the per-job dir was removed');
  await assertSentinelUnchanged(f.sentinel);
});

test('not-browser-safe ends failed not_browser_safe, the flag stays 0, and no file exists under <key>/', async (t) => {
  const f = await fixture(t);
  await enqueueSource(f.db, f.mediaRoot, {});

  await runOneJob(f, stubCmd('not-browser-safe'));

  const row = getConversion(f.db, REL_PATH);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.error, 'not_browser_safe');
  assert.equal(row?.output_rel, null);
  assert.equal(getItemByRelPath(f.db, REL_PATH)?.playable, 0);
  const key = row?.storage_key ?? '';
  await assert.rejects(fs.access(path.join(f.convertDirReal, key)), 'no <key>/ directory was published');
  assert.deepEqual(await workAreaEntries(f.convertDirReal), []);
  assertNoLeakedPaths({ row, logCalls: f.logCalls, mediaRoot: f.mediaRoot, convertDirReal: f.convertDirReal });
  await assertSentinelUnchanged(f.sentinel);
});

test('crash ends converter_failed and leaves the work area empty', async (t) => {
  const f = await fixture(t);
  await enqueueSource(f.db, f.mediaRoot, {});

  await runOneJob(f, stubCmd('crash'));

  const row = getConversion(f.db, REL_PATH);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.error, 'converter_failed');
  assert.deepEqual(await workAreaEntries(f.convertDirReal), []);
  assertNoLeakedPaths({ row, logCalls: f.logCalls, mediaRoot: f.mediaRoot, convertDirReal: f.convertDirReal });
  await assertSentinelUnchanged(f.sentinel);
});

test('usage (exit 2, unrecognized arguments) ends converter_unavailable and leaves the work area empty; stderr text is never logged', async (t) => {
  const f = await fixture(t);
  await enqueueSource(f.db, f.mediaRoot, {});

  await runOneJob(f, stubCmd('usage'));

  const row = getConversion(f.db, REL_PATH);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.error, 'converter_unavailable');
  assert.deepEqual(await workAreaEntries(f.convertDirReal), []);
  assertNoLeakedPaths({ row, logCalls: f.logCalls, mediaRoot: f.mediaRoot, convertDirReal: f.convertDirReal });
  for (const call of f.logCalls) {
    assert.ok(!JSON.stringify(call.fields ?? {}).includes('unrecognized arguments'), 'stderr text must never be logged');
  }
  await assertSentinelUnchanged(f.sentinel);
});

test('escape (reported output outside out/) ends converter_output_invalid and leaves the work area empty', async (t) => {
  const f = await fixture(t);
  await enqueueSource(f.db, f.mediaRoot, {});

  await runOneJob(f, stubCmd('escape'));

  const row = getConversion(f.db, REL_PATH);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.error, 'converter_output_invalid');
  assert.deepEqual(await workAreaEntries(f.convertDirReal), [], 'the escaped file was inside the removed job dir');
  assertNoLeakedPaths({ row, logCalls: f.logCalls, mediaRoot: f.mediaRoot, convertDirReal: f.convertDirReal });
  await assertSentinelUnchanged(f.sentinel);
});

test('hang, killed by stop(), ends failed interrupted, leaves no stub process behind, and leaves the work area empty', async (t) => {
  const f = await fixture(t);
  const holdDir = await makeTempDir(t, 'vt-lifecycle-hold-');
  await enqueueSource(f.db, f.mediaRoot, {});

  const queue = createConversionQueue({
    db: f.db, config: fakeConfig(f.mediaRoot, f.convertDirReal, stubCmd('hang', ['--hold', holdDir])), log: f.log, now: () => 1,
  });
  assert.equal(await queue.start(), true);
  queue.kick();
  await waitUntil(() => existsSync(path.join(holdDir, 'pid')));
  const pid = Number(await fs.readFile(path.join(holdDir, 'pid'), 'utf8'));

  await queue.stop();

  assert.throws(() => process.kill(pid, 0), 'the stub process no longer exists');
  const row = getConversion(f.db, REL_PATH);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.error, 'interrupted');
  assert.deepEqual(await workAreaEntries(f.convertDirReal), []);
  await assertSentinelUnchanged(f.sentinel);
});

test('a source modified between --hold started and go ends source_changed', async (t) => {
  const f = await fixture(t);
  const holdDir = await makeTempDir(t, 'vt-lifecycle-hold-');
  const { abs } = await enqueueSource(f.db, f.mediaRoot, {});

  const queue = createConversionQueue({
    db: f.db, config: fakeConfig(f.mediaRoot, f.convertDirReal, stubCmd('ok', ['--hold', holdDir])), log: f.log, now: () => 1,
  });
  assert.equal(await queue.start(), true);
  queue.kick();
  await waitUntil(() => existsSync(path.join(holdDir, 'started')));

  await fs.writeFile(abs, 'source bytes changed while converting, different length');
  await fs.writeFile(path.join(holdDir, 'go'), '');
  await waitUntil(() => countEvent(f.logCalls, 'conversion_finished') === 1);

  const row = getConversion(f.db, REL_PATH);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.error, 'source_changed');
  assert.equal(getItemByRelPath(f.db, REL_PATH)?.playable, 0);
  assert.deepEqual(await workAreaEntries(f.convertDirReal), []);
  await assertSentinelUnchanged(f.sentinel);
});

test('a converterCmd whose absolute executable does not exist ends converter_unavailable with error_detail exactly ENOENT, no path', async (t) => {
  const f = await fixture(t);
  await enqueueSource(f.db, f.mediaRoot, {});

  await runOneJob(f, Object.freeze([missingExecutablePath()]));

  const row = getConversion(f.db, REL_PATH);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.error, 'converter_unavailable');
  assert.equal(row?.error_detail, 'ENOENT');
  assertNoLeakedPaths({ row, logCalls: f.logCalls, mediaRoot: f.mediaRoot, convertDirReal: f.convertDirReal });
  await assertSentinelUnchanged(f.sentinel);
});
