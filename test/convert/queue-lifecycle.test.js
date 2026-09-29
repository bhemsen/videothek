// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConversion } from '../../src/db/conversions.js';
import { getItemByRelPath } from '../../src/db/library-repo.js';
import { WORK_AREA_NAME } from '../../src/convert/work-dir.js';
import { TARGETS } from '../../src/convert/targets.js';
import {
  REL_PATH, lifecycleFixture, makeTempDir, startQueue, stubCmd, missingExecutablePath, enqueueSource,
  waitUntil, countEvent, snapshotOutsideConvertDir, assertNothingOutsideConvertDir, assertNoLeakedPaths,
} from '../helpers/queue-lifecycle-setup.js';

/**
 * The real queue/job/runner/verify chain against `test/helpers/converter-stub.js`
 * (docs/specs/spec-conversion-core.md, `test/convert/queue-lifecycle.test.js`):
 * one job outcome per test, no fake `run`. Cleanup-specific cases (an
 * injected `removeDir` rejection) live in `queue-lifecycle-cleanup.test.js`.
 */

/**
 * Starts a queue against `converterCmd` and waits for the single enqueued
 * job to finish.
 * @param {import('node:test').TestContext} t
 * @param {import('../helpers/queue-lifecycle-setup.js').LifecycleFixture} f
 * @param {readonly string[]} converterCmd
 */
async function runOneJob(t, f, converterCmd) {
  await startQueue(t, f, converterCmd);
  await waitUntil(() => countEvent(f.logCalls, 'conversion_finished') === 1);
}

/** @param {string} convertDirReal */
async function workAreaEntries(convertDirReal) {
  return fs.readdir(path.join(convertDirReal, WORK_AREA_NAME));
}

/**
 * The common failure-case checks: `failed` with `error`, the flag still 0,
 * an empty work area, no leaked path, and nothing touched outside
 * `CONVERT_DIR`.
 * @param {import('../helpers/queue-lifecycle-setup.js').LifecycleFixture} f
 * @param {string[]} before
 * @param {string} error
 */
async function assertFailedClean(f, before, error) {
  const row = getConversion(f.db, REL_PATH);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.error, error);
  assert.equal(getItemByRelPath(f.db, REL_PATH)?.playable, 0);
  assert.deepEqual(await workAreaEntries(f.convertDirReal), [], 'the per-job dir was removed');
  assertNoLeakedPaths(f, row);
  await assertNothingOutsideConvertDir(f, before);
  return row;
}

test('ok publishes <key>/web.mp4 with the flag and output_size, and removes the work dir', async (t) => {
  const f = await lifecycleFixture(t);
  const { key } = await enqueueSource(f);
  const before = await snapshotOutsideConvertDir(f);

  await runOneJob(t, f, stubCmd('ok'));

  const row = getConversion(f.db, REL_PATH);
  assert.equal(row?.status, 'playable');
  assert.equal(row?.error, null);
  assert.equal(row?.output_rel, `${key}/${TARGETS.web.file}`);
  assert.ok((row?.output_size ?? 0) > 0);
  const outFile = path.join(f.convertDirReal, key, TARGETS.web.file);
  assert.equal((await fs.stat(outFile)).size, row?.output_size);
  assert.equal(getItemByRelPath(f.db, REL_PATH)?.playable, 1);
  assert.deepEqual(await workAreaEntries(f.convertDirReal), [], 'the per-job dir was removed');
  assertNoLeakedPaths(f, row);
  await assertNothingOutsideConvertDir(f, before);
});

test('not-browser-safe ends failed not_browser_safe, the flag stays 0, and no file exists under <key>/', async (t) => {
  const f = await lifecycleFixture(t);
  const { key } = await enqueueSource(f);
  const before = await snapshotOutsideConvertDir(f);

  await runOneJob(t, f, stubCmd('not-browser-safe'));

  const row = await assertFailedClean(f, before, 'not_browser_safe');
  assert.equal(row?.output_rel, null);
  await assert.rejects(fs.access(path.join(f.convertDirReal, key)), 'no <key>/ directory was published');
});

test('crash ends converter_failed and leaves the work area empty', async (t) => {
  const f = await lifecycleFixture(t);
  await enqueueSource(f);
  const before = await snapshotOutsideConvertDir(f);

  await runOneJob(t, f, stubCmd('crash'));

  await assertFailedClean(f, before, 'converter_failed');
});

test('usage (exit 2, unrecognized arguments) ends converter_unavailable and leaves the work area empty; stderr text is never logged', async (t) => {
  const f = await lifecycleFixture(t);
  await enqueueSource(f);
  const before = await snapshotOutsideConvertDir(f);

  await runOneJob(t, f, stubCmd('usage'));

  await assertFailedClean(f, before, 'converter_unavailable');
  // error_detail may keep the (redacted) stderr tail; log lines never may.
  for (const call of f.logCalls) {
    const serialized = JSON.stringify(call.fields ?? {});
    assert.ok(!serialized.includes('unrecognized arguments'), `stderr text must never be logged: ${serialized}`);
  }
});

test('escape (reported output outside out/) ends converter_output_invalid and leaves the work area empty', async (t) => {
  const f = await lifecycleFixture(t);
  await enqueueSource(f);
  const before = await snapshotOutsideConvertDir(f);

  await runOneJob(t, f, stubCmd('escape'));

  await assertFailedClean(f, before, 'converter_output_invalid');
});

test('hang, killed by stop(), ends failed interrupted, leaves no stub process behind, and leaves the work area empty', async (t) => {
  const f = await lifecycleFixture(t);
  const holdDir = await makeTempDir(t, 'vt-lifecycle-hold-');
  await enqueueSource(f);
  const before = await snapshotOutsideConvertDir(f);

  const queue = await startQueue(t, f, stubCmd('hang', ['--hold', holdDir]));
  await waitUntil(() => existsSync(path.join(holdDir, 'pid')));
  const pid = Number(await fs.readFile(path.join(holdDir, 'pid'), 'utf8'));

  await queue.stop();

  assert.throws(() => process.kill(pid, 0), 'the stub process no longer exists');
  await assertFailedClean(f, before, 'interrupted');
});

test('a source modified between --hold started and go ends source_changed', async (t) => {
  const f = await lifecycleFixture(t);
  const holdDir = await makeTempDir(t, 'vt-lifecycle-hold-');
  const { abs } = await enqueueSource(f);
  const before = await snapshotOutsideConvertDir(f, { namesOnly: true });

  await startQueue(t, f, stubCmd('ok', ['--hold', holdDir]));
  await waitUntil(() => existsSync(path.join(holdDir, 'started')));
  await fs.writeFile(abs, 'source bytes changed while converting, different length');
  await fs.writeFile(path.join(holdDir, 'go'), '');
  await waitUntil(() => countEvent(f.logCalls, 'conversion_finished') === 1);

  const row = getConversion(f.db, REL_PATH);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.error, 'source_changed');
  assert.equal(getItemByRelPath(f.db, REL_PATH)?.playable, 0);
  assert.deepEqual(await workAreaEntries(f.convertDirReal), []);
  assertNoLeakedPaths(f, row);
  // Names only: the test itself rewrote the source file.
  await assertNothingOutsideConvertDir(f, before, { namesOnly: true });
});

test('a converterCmd whose absolute executable does not exist ends converter_unavailable with error_detail exactly ENOENT, no path', async (t) => {
  const f = await lifecycleFixture(t);
  await enqueueSource(f);
  const before = await snapshotOutsideConvertDir(f);
  const missing = missingExecutablePath();

  await runOneJob(t, f, Object.freeze([missing]));

  const row = await assertFailedClean(f, before, 'converter_unavailable');
  assert.equal(row?.error_detail, 'ENOENT');
  assertNoLeakedPaths(f, row, [missing, path.basename(missing)]);
});
