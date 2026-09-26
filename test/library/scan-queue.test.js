import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScanQueue } from '../../src/library/scan-queue.js';

/** Resolves on the next macrotask, so a run can be pre-empted mid-flight. */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('concurrent requestFull/requestPaths coalesce without overlapping runs', async () => {
  let active = 0;
  let maxActive = 0;
  /** @type {string[]} */
  const fullCalls = [];
  /** @type {string[][]} */
  const pathsCalls = [];
  const queue = createScanQueue({
    async runFull(kind) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      fullCalls.push(kind);
      await tick();
      active -= 1;
      return { kind };
    },
    async runPaths(paths) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      pathsCalls.push(paths);
      await tick();
      active -= 1;
      return { paths };
    },
  });

  queue.requestFull('initial');
  queue.requestFull();
  queue.requestFull();
  queue.requestPaths(['a/b.mp4']);
  queue.requestPaths(['c/d.mp4']);

  assert.equal(queue.running(), true);
  await queue.idle();

  assert.deepEqual(fullCalls, ['initial', 'full']);
  assert.deepEqual(pathsCalls, []);
  assert.equal(maxActive, 1);
  assert.equal(queue.running(), false);
});

test('a running full scan drains pending paths inline via drainPathsBetweenDirs()', async () => {
  /** @type {ReturnType<typeof createScanQueue>} */
  let queue;
  /** @type {string[][]} */
  const pathsCalls = [];
  /** @type {{ kind: string }[]} */
  const completes = [];
  const dirs = ['a', 'b', 'c'];

  queue = createScanQueue({
    async runFull(kind) {
      for (const dir of dirs) {
        if (dir === 'b') queue.requestPaths(['new/file.mp4']);
        await queue.drainPathsBetweenDirs();
      }
      return { kind, dirs: dirs.length };
    },
    async runPaths(paths) {
      pathsCalls.push(paths);
      return { paths };
    },
    onComplete(payload) {
      completes.push({ kind: payload.kind });
    },
  });

  queue.requestFull('full');
  await queue.idle();

  assert.deepEqual(pathsCalls, [['new/file.mp4']]);
  assert.deepEqual(
    completes.map((c) => c.kind),
    ['paths', 'full'],
  );
});

test('idle() resolves immediately when nothing is running or pending', async () => {
  const queue = createScanQueue({
    runFull: async () => ({}),
    runPaths: async () => ({}),
  });
  assert.equal(queue.running(), false);
  await queue.idle();
});

test('stop() prevents further runs, but lets an in-flight one finish', async () => {
  /** @type {string[]} */
  const fullCalls = [];
  const queue = createScanQueue({
    async runFull(kind) {
      fullCalls.push(kind);
      await tick();
      return {};
    },
    async runPaths() {
      fullCalls.push('paths');
      return {};
    },
  });

  queue.requestFull('initial');
  queue.requestFull();
  queue.stop();
  queue.requestFull('full');
  queue.requestPaths(['x']);
  await queue.idle();

  assert.deepEqual(fullCalls, ['initial']);
  assert.equal(queue.running(), false);
});

test('onComplete fires exactly once per finished run with its kind and stats', async () => {
  /** @type {{ kind: string, stats: unknown }[]} */
  const completes = [];
  const queue = createScanQueue({
    async runFull(kind) {
      return { added: kind === 'initial' ? 5 : 0 };
    },
    async runPaths(paths) {
      return { updated: paths.length };
    },
    onComplete(payload) {
      completes.push(payload);
    },
  });

  queue.requestFull('initial');
  await queue.idle();
  queue.requestPaths(['a', 'b']);
  await queue.idle();
  queue.requestFull();
  await queue.idle();

  assert.deepEqual(completes, [
    { kind: 'initial', stats: { added: 5 } },
    { kind: 'paths', stats: { updated: 2 } },
    { kind: 'full', stats: { added: 0 } },
  ]);
});

test('a paths run that escalates schedules one follow-up full run', async () => {
  /** @type {string[]} */
  const runs = [];
  const queue = createScanQueue({
    async runFull(kind) {
      runs.push(`full:${kind}`);
      return { kind };
    },
    async runPaths(paths) {
      runs.push(`paths:${paths.join(',')}`);
      return { stats: { updated: paths.length }, escalate: true };
    },
  });

  queue.requestPaths(['Filme']);
  await queue.idle();

  assert.deepEqual(runs, ['paths:Filme', 'full:full']);
});

test('requestFull keeps a pending "initial" even if a later requestFull() arrives', async () => {
  /** @type {string[]} */
  const fullCalls = [];
  const queue = createScanQueue({
    async runFull(kind) {
      fullCalls.push(kind);
      await tick();
      return {};
    },
    async runPaths() {
      return {};
    },
  });

  queue.requestFull('initial'); // starts running immediately
  queue.requestFull('initial'); // queued behind the in-flight run
  queue.requestFull(); // a concurrent timer/watcher call must not downgrade it
  await queue.idle();

  assert.deepEqual(fullCalls, ['initial', 'initial']);
});

test('requestPaths union-coalesces several calls into one follow-up run', async () => {
  /** @type {string[][]} */
  const pathsCalls = [];
  const queue = createScanQueue({
    runFull: async () => ({}),
    async runPaths(paths) {
      pathsCalls.push(paths);
      await tick();
      return { paths };
    },
  });

  queue.requestPaths(['a']); // starts running immediately
  queue.requestPaths(['a']); // arrives while in flight -> queued
  queue.requestPaths(['b', 'a']); // unions into the same pending set
  await queue.idle();

  assert.deepEqual(pathsCalls, [['a'], ['a', 'b']]);
});

test('a rejecting onComplete is caught and logged like a synchronous throw', async () => {
  /** @type {{ event: string }[]} */
  const errors = [];
  const queue = createScanQueue({
    runFull: async () => ({}),
    runPaths: async () => ({}),
    onComplete: () => Promise.reject(new Error('async listener boom')),
    log: { error: (event) => errors.push({ event }) },
  });

  queue.requestFull('initial');
  await queue.idle();
  await tick(); // flush the rejection's `.then` handler

  assert.deepEqual(
    errors.map((e) => e.event),
    ['library_scan_queue_oncomplete_failed'],
  );
});

test('a thrown run is logged and does not block later runs; a throwing onComplete is tolerated', async () => {
  /** @type {string[]} */
  const fullCalls = [];
  /** @type {{ event: string }[]} */
  const errors = [];
  const queue = createScanQueue({
    async runFull(kind) {
      fullCalls.push(kind);
      if (kind === 'initial') throw new Error('boom');
      return { ok: true };
    },
    async runPaths() {
      return {};
    },
    onComplete: () => {
      throw new Error('listener boom');
    },
    log: { error: (event) => errors.push({ event }) },
  });

  queue.requestFull('initial');
  await queue.idle();
  assert.deepEqual(fullCalls, ['initial']);
  assert.deepEqual(
    errors.map((e) => e.event),
    ['library_scan_run_failed'],
  );

  queue.requestFull('full');
  await queue.idle();
  assert.deepEqual(fullCalls, ['initial', 'full']);
  assert.deepEqual(
    errors.map((e) => e.event),
    ['library_scan_run_failed', 'library_scan_queue_oncomplete_failed'],
  );
});
