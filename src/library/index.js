// @ts-check
import { createScanner } from './scanner.js';
import { createWatcher } from './watcher.js';

/**
 * Boots the whole library subsystem (scanner + change detection) and wires
 * it into the server lifecycle. Spec: spec-library-video.md, "Service
 * (`src/library/index.js`) and wiring".
 */

/** @typedef {import('./scanner.js').ScanCompletePayload} ScanCompletePayload */
/** @typedef {import('./scanner.js').ScanStatus} ScanStatus */
/** @typedef {import('../log.js').Logger} Logger */
/** @typedef {import('../config.js').Config} Config */

/**
 * @typedef {{
 *   onScanComplete(listener: (payload: ScanCompletePayload) => void | Promise<void>): () => void,
 *   requestFull(): void,
 *   stop(): Promise<void>,
 *   status(): ScanStatus,
 * }} LibraryService
 */

const MS_PER_MINUTE = 60_000;

/**
 * Synchronously creates the watcher and scanner and returns immediately (D4):
 * the watcher start and the first (`'initial'`) full scan are deferred with
 * `setImmediate`, so `listen()` is never delayed. The periodic rescan (every
 * `config.rescanIntervalMin` minutes) requests a plain `'full'` scan through
 * an `unref()`ed `setInterval`; it never overlaps another run — the scanner's
 * own queue coalesces every request, timer included.
 *
 * The scanner needs the watcher's `dirObserver` at creation time, and the
 * watcher needs a scanner-like object to call `requestFull`/`requestPaths`
 * on — but only later, from an event or timer callback, never during its own
 * construction. `scannerProxy` forwards to `scanner` once it exists, letting
 * both sides build in the only order that works without either one already
 * existing.
 * @param {{ db: import('node:sqlite').DatabaseSync, config: Config, log: Logger, now?: () => number }} deps
 * @returns {LibraryService}
 */
export function startLibrary({ db, config, log, now = Date.now }) {
  /** @type {ReturnType<typeof createScanner> | null} */
  let scanner = null;
  const scannerProxy = {
    /** @param {'initial' | 'full'} [kind] */
    requestFull(kind) {
      scanner?.requestFull(kind);
    },
    /** @param {string[]} relPaths */
    requestPaths(relPaths) {
      scanner?.requestPaths(relPaths);
    },
  };
  const watcher = createWatcher({ mediaRoot: config.mediaRoot, log, scanner: scannerProxy });
  scanner = createScanner({ db, mediaRoot: config.mediaRoot, log, now, dirObserver: watcher.dirObserver });

  // Guards the deferred boot below against a `stop()` that lands before it
  // runs (e.g. a caller stopping the server right after `startLibrary()`,
  // before the event loop reaches this `setImmediate`): without it, the
  // watcher would still start — and open a real, persistent watch — after
  // the service was already told to stop, leaking a handle that keeps the
  // process alive forever.
  let stopped = false;
  setImmediate(() => {
    if (stopped) return;
    watcher.start();
    /** @type {NonNullable<typeof scanner>} */ (scanner).requestFull('initial');
  });

  const rescanTimer = setInterval(
    () => /** @type {NonNullable<typeof scanner>} */ (scanner).requestFull(),
    config.rescanIntervalMin * MS_PER_MINUTE,
  );
  rescanTimer.unref();

  const readyScanner = /** @type {NonNullable<typeof scanner>} */ (scanner);
  return {
    onScanComplete: (listener) => readyScanner.onScanComplete(listener),
    requestFull: () => readyScanner.requestFull(),
    status: () => readyScanner.status(),
    async stop() {
      stopped = true;
      clearInterval(rescanTimer);
      watcher.stop();
      readyScanner.stop();
      await readyScanner.idle();
    },
  };
}
