// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConversion } from '../../src/db/conversions.js';
import { getItemByRelPath } from '../../src/db/library-repo.js';
import { createConversionQueue } from '../../src/convert/queue.js';
import { TARGETS } from '../../src/convert/targets.js';
import {
  REL_PATH, makeDb, makeTempDir, fakeConfig, fakeLogger, stubCmd,
  enqueueSource, waitUntil, countEvent, makeSentinel, assertSentinelUnchanged,
} from '../helpers/queue-lifecycle-setup.js';

/**
 * Step-7 cleanup failures against the real stub
 * (docs/specs/spec-conversion-core.md, `test/convert/queue-lifecycle-cleanup.test.js`):
 * an injected `removeDir` rejection must never change a job's already
 * recorded end state, only log `conversion_cleanup_failed`. The rejection is
 * scoped to paths whose basename starts with `<storage_key>-` (the job dir),
 * so `start()`'s own `.videothek-work` wipe still runs normally.
 */

/**
 * A `removeDir` that rejects with `EBUSY` only for the given job's own
 * per-attempt directory, and otherwise removes for real (used by `start()`'s
 * work-area wipe, whose target is `.videothek-work` itself).
 * @param {string} key
 * @returns {(target: string) => Promise<void>}
 */
function busyForJobDir(key) {
  return (target) => {
    if (path.basename(target).startsWith(`${key}-`)) {
      return Promise.reject(Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' }));
    }
    return fs.rm(target, { recursive: true, force: true, maxRetries: 3 });
  };
}

/**
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

test('an EBUSY removeDir rejection after a successful ok publish leaves the row playable, the flag set and the copy in place, and logs conversion_cleanup_failed', async (t) => {
  const f = await fixture(t);
  const { key } = await enqueueSource(f.db, f.mediaRoot, {});

  const queue = createConversionQueue({
    db: f.db, config: fakeConfig(f.mediaRoot, f.convertDirReal, stubCmd('ok')), log: f.log, now: () => 1,
    removeDir: busyForJobDir(key),
  });
  assert.equal(await queue.start(), true);
  queue.kick();
  await waitUntil(() => countEvent(f.logCalls, 'conversion_finished') === 1);

  const row = getConversion(f.db, REL_PATH);
  assert.equal(row?.status, 'playable');
  assert.equal(row?.error, null);
  assert.equal(getItemByRelPath(f.db, REL_PATH)?.playable, 1);
  const outFile = path.join(f.convertDirReal, key, TARGETS.web.file);
  assert.equal((await fs.stat(outFile)).size, row?.output_size, 'the published copy is still in place');

  const cleanup = f.logCalls.find((c) => c.event === 'conversion_cleanup_failed');
  assert.ok(cleanup, 'conversion_cleanup_failed was logged');
  assert.deepEqual(cleanup?.fields, { key, code: 'EBUSY' }, 'no path is logged, only the key and errno code');
  await assertSentinelUnchanged(f.sentinel);
});

test('the same EBUSY removeDir rejection after a not-browser-safe run keeps error not_browser_safe and logs conversion_cleanup_failed', async (t) => {
  const f = await fixture(t);
  const { key } = await enqueueSource(f.db, f.mediaRoot, {});

  const queue = createConversionQueue({
    db: f.db, config: fakeConfig(f.mediaRoot, f.convertDirReal, stubCmd('not-browser-safe')), log: f.log, now: () => 1,
    removeDir: busyForJobDir(key),
  });
  assert.equal(await queue.start(), true);
  queue.kick();
  await waitUntil(() => countEvent(f.logCalls, 'conversion_finished') === 1);

  const row = getConversion(f.db, REL_PATH);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.error, 'not_browser_safe', 'the cleanup failure never overwrites the real reason');
  assert.equal(getItemByRelPath(f.db, REL_PATH)?.playable, 0);
  await assert.rejects(fs.access(path.join(f.convertDirReal, key)), 'no <key>/ directory was published');

  const cleanup = f.logCalls.find((c) => c.event === 'conversion_cleanup_failed');
  assert.ok(cleanup, 'conversion_cleanup_failed was logged');
  assert.deepEqual(cleanup?.fields, { key, code: 'EBUSY' });
  await assertSentinelUnchanged(f.sentinel);
});
