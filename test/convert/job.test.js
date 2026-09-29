// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { upsertItem, getItemByRelPath } from '../../src/db/library-repo.js';
import { getConversion } from '../../src/db/conversions.js';
import { TARGETS } from '../../src/convert/targets.js';
import { runConversionJob } from '../../src/convert/job.js';
import {
  REL_PATH, FLAC_BYTES, fakeConfig, makeDb, makeTempDir, fakeLogger, fakeRun, convertedFlac, claim, setup,
} from '../helpers/conversion-job-fixtures.js';

test('steps 1-2: no library_items row, or an unresolvable source, end source_missing without spawning', async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const convertDirReal = await makeTempDir(t, 'vt-job-convert-');
  const mediaRoot = await makeTempDir(t, 'vt-job-media-');
  for (const withItemRow of [false, true]) {
    if (withItemRow) {
      upsertItem(
        db,
        {
          rel_path: REL_PATH, dir: path.dirname(REL_PATH), category: 'audiobooks', kind: 'audio', ext: 'mp3',
          title: 't', sort_title: 't', playable: false, size: 1, mtime_ms: 1, scan_version: 1,
        },
        1000
      );
    }
    const row = claim(db);
    const { run, calls } = fakeRun(() => assert.fail('run must not be called'));
    const { log, calls: logCalls } = fakeLogger();
    await runConversionJob({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, convertDirReal, row, isStopping: () => false });
    assert.equal(calls.length, 0);
    const stored = getConversion(db, REL_PATH);
    assert.equal(stored?.error, 'source_missing');
    assert.equal(stored?.error_detail, null);
    assert.deepEqual(logCalls.map((c) => c.event), ['conversion_started', 'conversion_finished']);
  }
});

test('full success: records the source stat, spawns with the right env/cwd, redacts+truncates notes, publishes, cleans up', async (t) => {
  const { db, convertDirReal, mediaRoot, row, source } = await setup(t);
  const secretPath = `${mediaRoot}${path.sep}secret.txt`;
  const notes = [`error near ${secretPath}`.padEnd(250, '.'), 'short note'];
  const { run, calls } = fakeRun((args) => convertedFlac(args, notes));
  const { log, calls: logCalls } = fakeLogger();
  let handled = /** @type {any} */ (null);
  await runConversionJob({
    db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 5000, run, convertDirReal, row,
    isStopping: () => false, onHandle: (h) => { handled = h; },
  });

  assert.equal(calls.length, 1);
  const args = calls[0];
  assert.deepEqual(args.cmd, ['/usr/bin/fake-converter']);
  assert.equal(args.source, await fs.realpath(source.abs));
  assert.equal(args.cwd, path.dirname(args.outDir));
  assert.equal(args.env.TMPDIR, path.join(args.cwd, 'tmp'));
  assert.equal(args.env.TEMP, args.env.TMPDIR);
  assert.equal(args.env.TMP, args.env.TMPDIR);
  assert.equal(args.env.PATH, '/usr/bin');
  assert.ok(handled, 'the run handle was exposed to the caller');

  const stored = getConversion(db, REL_PATH);
  assert.equal(stored?.status, 'playable');
  assert.equal(stored?.output_rel, `${row.storage_key}/${TARGETS.flac.file}`);
  assert.equal(stored?.output_size, FLAC_BYTES.length);
  assert.equal(stored?.source_size, source.size);
  assert.equal(stored?.source_mtime_ms, source.mtimeMs);
  const storedNotes = JSON.parse(stored?.notes ?? '[]');
  assert.equal(storedNotes.length, 2);
  assert.ok(storedNotes[0].includes('<MEDIA_ROOT>') && !storedNotes[0].includes(mediaRoot));
  assert.equal(storedNotes[0].length, 200, 'a redacted note longer than 200 chars keeps exactly its first 200');
  assert.equal(storedNotes[1], 'short note');
  assert.equal(getItemByRelPath(db, REL_PATH)?.playable, 1);
  await assert.rejects(fs.stat(args.cwd), 'the per-job work dir was removed');
  assert.deepEqual(logCalls.map((c) => c.event), ['conversion_started', 'conversion_finished']);
  assert.deepEqual(logCalls[0].fields, { key: row.storage_key, target: 'flac', status: 'converting', error: null, ms: 0 });
  const finished = logCalls[1].fields ?? {};
  assert.equal(finished.status, 'playable');
  assert.equal(finished.error, null);
  assert.equal(typeof finished.ms, 'number');
  const logged = JSON.stringify(logCalls);
  for (const secret of [mediaRoot, convertDirReal, 'fake-converter']) assert.ok(!logged.includes(JSON.stringify(secret).slice(1, -1)));
});

test('step 4: stopping before spawn ends interrupted without calling run, work dir still cleaned up', async (t) => {
  const { db, convertDirReal, mediaRoot, row } = await setup(t);
  const { run, calls } = fakeRun(() => assert.fail('run must not be called'));
  const { log } = fakeLogger();
  await runConversionJob({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, convertDirReal, row, isStopping: () => true });
  assert.equal(calls.length, 0);
  assert.equal(getConversion(db, REL_PATH)?.error, 'interrupted');
  const leftovers = await fs.readdir(path.join(convertDirReal, '.videothek-work')).catch(() => []);
  assert.deepEqual(leftovers, []);
});

test('step 5: stopping after the run settles ends interrupted without interpretation, even for a valid record', async (t) => {
  const { db, convertDirReal, mediaRoot, row } = await setup(t);
  let checks = 0;
  const isStopping = () => { checks += 1; return checks > 1; };
  const { run, calls } = fakeRun((args) => convertedFlac(args));
  const { log } = fakeLogger();
  let handled = null;
  await runConversionJob({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, convertDirReal, row, isStopping, onHandle: (h) => { handled = h; } });
  assert.equal(calls.length, 1, 'run was called since stopping was still false before the spawn');
  assert.ok(handled);
  assert.equal(getConversion(db, REL_PATH)?.error, 'interrupted');
  assert.equal(getItemByRelPath(db, REL_PATH)?.playable, 0);
});

test('step 5: an interpretation failure is stored with its detail redacted', async (t) => {
  const { db, convertDirReal, mediaRoot, row } = await setup(t);
  const stderrTail = `ffmpeg: cannot read ${mediaRoot}${path.sep}secret.mp3`;
  const { run } = fakeRun(async () => ({
    spawnError: null, exitCode: 1, signal: null, killedBy: null, records: [], stdoutInvalid: false, stdioTimedOut: false, stderrTail,
  }));
  const { log } = fakeLogger();
  await runConversionJob({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, convertDirReal, row, isStopping: () => false });
  const stored = getConversion(db, REL_PATH);
  assert.equal(stored?.error, 'converter_failed');
  assert.ok(stored?.error_detail?.includes('<MEDIA_ROOT>'));
  assert.ok(!stored?.error_detail?.includes(mediaRoot));
});

test('step 5: a verification failure (bad magic) ends not_browser_safe with no detail, unpublished', async (t) => {
  const { db, convertDirReal, mediaRoot, row } = await setup(t);
  const { run } = fakeRun(async ({ outDir }) => {
    const output = path.join(outDir, TARGETS.flac.file);
    await fs.writeFile(output, 'not a flac file at all');
    return { spawnError: null, exitCode: 0, signal: null, killedBy: null, records: [{ outcome: 'converted', output, error: null, notes: [] }], stdoutInvalid: false, stdioTimedOut: false, stderrTail: '' };
  });
  const { log } = fakeLogger();
  await runConversionJob({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, convertDirReal, row, isStopping: () => false });
  const stored = getConversion(db, REL_PATH);
  assert.equal(stored?.error, 'not_browser_safe');
  assert.equal(stored?.error_detail, null);
  assert.equal(getItemByRelPath(db, REL_PATH)?.playable, 0);
});

test('step 5: the source changing during the run ends source_changed without publishing', async (t) => {
  const { db, convertDirReal, mediaRoot, row, source } = await setup(t);
  const { run } = fakeRun(async (args) => {
    await fs.writeFile(source.abs, 'source bytes, but now a different length');
    return convertedFlac(args);
  });
  const { log } = fakeLogger();
  await runConversionJob({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, convertDirReal, row, isStopping: () => false });
  const stored = getConversion(db, REL_PATH);
  assert.equal(stored?.error, 'source_changed');
  assert.equal(getItemByRelPath(db, REL_PATH)?.playable, 0);
});

test('step 6: a blocked publish directory ends storage_failed without publishing', async (t) => {
  const { db, convertDirReal, mediaRoot, row } = await setup(t);
  await fs.mkdir(convertDirReal, { recursive: true });
  await fs.writeFile(path.join(convertDirReal, row.storage_key), 'occupied');
  const { run } = fakeRun((args) => convertedFlac(args));
  const { log } = fakeLogger();
  await runConversionJob({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, convertDirReal, row, isStopping: () => false });
  const stored = getConversion(db, REL_PATH);
  assert.equal(stored?.error, 'storage_failed');
  assert.ok(stored?.error_detail);
  assert.equal(getItemByRelPath(db, REL_PATH)?.playable, 0);
});

test('step 7: a cleanup removal failure only logs conversion_cleanup_failed; the recorded end state is unchanged', async (t) => {
  const { db, convertDirReal, mediaRoot, row } = await setup(t);
  const { run } = fakeRun((args) => convertedFlac(args));
  const { log, calls: logCalls } = fakeLogger();
  const removeDir = async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  await runConversionJob({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, removeDir, convertDirReal, row, isStopping: () => false });
  assert.equal(getConversion(db, REL_PATH)?.status, 'playable');
  const cleanupLog = logCalls.find((c) => c.event === 'conversion_cleanup_failed');
  assert.equal(cleanupLog?.fields?.code, 'EBUSY');
  assert.equal(cleanupLog?.fields?.key, row.storage_key);
});

test('an unexpected throw ends the row failed internal and logs conversion_error with the error name only', async (t) => {
  const { db, convertDirReal, mediaRoot, row } = await setup(t);
  const run = () => { throw new TypeError('boom'); };
  const { log, calls: logCalls } = fakeLogger();
  await runConversionJob({ db, config: fakeConfig(mediaRoot, convertDirReal), log, now: () => 1, run, convertDirReal, row, isStopping: () => false });
  const stored = getConversion(db, REL_PATH);
  assert.equal(stored?.error, 'internal');
  assert.equal(stored?.error_detail, 'TypeError');
  const errLog = logCalls.find((c) => c.event === 'conversion_error');
  assert.equal(errLog?.fields?.code, 'TypeError');
  assert.deepEqual(await fs.readdir(path.join(convertDirReal, '.videothek-work')), [], 'the job dir is still removed');
});
