// @ts-check
/**
 * Shared seeds and fakes for the `createAudioMetaPass` test files
 * (`test/library/audio-meta.test.js`, `test/library/audio-meta-runs.test.js`).
 */
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';

/** @returns {import('node:sqlite').DatabaseSync} an in-memory DB with migrations applied and FKs on */
export function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** @param {Partial<import('../../src/db/library-repo.js').LibraryItemInput>} overrides
 * @returns {import('../../src/db/library-repo.js').LibraryItemInput} */
export function makeItem(overrides = {}) {
  return {
    rel_path: 'Musik/Die Beispiele/Unterwegs/01 Titel.mp3',
    dir: 'Musik/Die Beispiele/Unterwegs',
    category: 'music',
    kind: 'audio',
    ext: 'mp3',
    title: 'Titel',
    sort_title: 'titel',
    playable: true,
    size: 1000,
    mtime_ms: 1_700_000_000_000,
    scan_version: 1,
    ...overrides,
  };
}

/** @param {Partial<import('../../src/library/tags/index.js').AudioTags>} [overrides]
 * @returns {import('../../src/library/tags/index.js').AudioTags} */
export function tagsStub(overrides = {}) {
  return {
    title: null, artist: null, albumArtist: null, album: null,
    trackNo: null, discNo: null, year: null, durationMs: null, format: null,
    ...overrides,
  };
}

/** @typedef {{ level: string, event: string, fields?: Record<string, unknown> }} LogCall */
/** @returns {{ log: import('../../src/log.js').Logger, calls: LogCall[] }} */
export function makeLog() {
  /** @type {LogCall[]} */
  const calls = [];
  /** @param {'info'|'warn'|'error'} level @returns {import('../../src/log.js').LogFn} */
  const at = (level) => (event, fields) => calls.push({ level, event, fields });
  return { log: { info: at('info'), warn: at('warn'), error: at('error') }, calls };
}

/** Fake `resolveMediaPath` — every rel path "resolves" without touching the filesystem. */
export const resolvePath = async (/** @type {string} */ root, /** @type {string} */ relPath) => `${root}/${relPath}`;

/** Resolves on the next macrotask, so a pass can be pre-empted mid-flight. */
export function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}
