// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDirWatchSet } from '../../src/library/dir-watch.js';

const CATEGORY_DIR_COUNT = 400;
const FILES_PER_DIR = 50; // 400 * 50 = 20 000 files
const EXPECTED_WATCH_COUNT = CATEGORY_DIR_COUNT + 2; // root + one category root + 400 dirs
const HEAP_GROWTH_LIMIT_BYTES = 8 * 1024 * 1024;

/** @param {string} mediaRoot */
function buildTree(mediaRoot) {
  const categoryRoot = path.join(mediaRoot, 'Filme');
  fs.mkdirSync(categoryRoot, { recursive: true });
  for (let dirIndex = 0; dirIndex < CATEGORY_DIR_COUNT; dirIndex += 1) {
    const dir = path.join(categoryRoot, `dir${String(dirIndex).padStart(4, '0')}`);
    fs.mkdirSync(dir);
    for (let fileIndex = 0; fileIndex < FILES_PER_DIR; fileIndex += 1) {
      fs.writeFileSync(path.join(dir, `f${fileIndex}.mp4`), '');
    }
  }
}

/**
 * Simulates the scanner's walk registering every directory it visits, the
 * same way `scanner.js` (a later issue) will drive `dirObserver`.
 *
 * @param {import('../../src/library/dir-watch.js').DirWatchSet} dirObserver
 */
function simulateWalk(dirObserver) {
  dirObserver.seen(''); // MEDIA_ROOT itself — seeded by watcher.js's start(), simulated here directly
  dirObserver.seen('Filme');
  for (let dirIndex = 0; dirIndex < CATEGORY_DIR_COUNT; dirIndex += 1) {
    dirObserver.seen(`Filme/dir${String(dirIndex).padStart(4, '0')}`);
  }
}

test(
  'registers exactly one watch per directory across a 20 000-file, 400-directory tree, with bounded heap growth',
  { timeout: 120_000 },
  () => {
    const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'videothek-watch-scale-'));
    try {
      buildTree(mediaRoot);

      const log = { info() {}, warn() {}, error() {} };
      const dirObserver = createDirWatchSet({
        mediaRoot,
        watchFn: fs.watch,
        onEvent() {},
        onWatchError() {},
        log,
      });

      global.gc?.();
      const heapBefore = process.memoryUsage().heapUsed;

      simulateWalk(dirObserver);

      global.gc?.();
      const heapAfter = process.memoryUsage().heapUsed;

      assert.equal(dirObserver.count(), EXPECTED_WATCH_COUNT);
      assert.ok(
        heapAfter - heapBefore < HEAP_GROWTH_LIMIT_BYTES,
        `heap grew by ${heapAfter - heapBefore} bytes registering ${EXPECTED_WATCH_COUNT} watches, expected < ${HEAP_GROWTH_LIMIT_BYTES}`,
      );

      dirObserver.closeAll();
      assert.equal(dirObserver.count(), 0);
    } finally {
      fs.rmSync(mediaRoot, { recursive: true, force: true });
    }
  },
);
