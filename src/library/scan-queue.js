/**
 * Serialising, coalescing scan run queue (no I/O — `src/library/scanner.js`
 * supplies the actual full/paths scan implementations and owns all I/O).
 *
 * Spec: docs/specs/spec-library-video.md, "Scanner modules" / "Queue".
 */

/**
 * @typedef {'initial' | 'full'} FullScanKind
 * @typedef {'initial' | 'full' | 'paths'} ScanRunKind
 */

/**
 * @typedef {object} ScanQueueLogger
 * @property {(event: string, fields?: Record<string, unknown>) => void} error
 */

/**
 * @typedef {object} ScanCompletePayload
 * @property {ScanRunKind} kind
 * @property {unknown} stats
 */

/**
 * @typedef {object} ScanQueueDeps
 * @property {(kind: FullScanKind) => Promise<unknown>} runFull Runs a full
 *   scan; called with the requested kind ('initial' the first time, 'full'
 *   for every later one). May call `drainPathsBetweenDirs()` (the object
 *   `createScanQueue` returns) between directories.
 * @property {(relPaths: string[]) => Promise<unknown>} runPaths Reconciles
 *   the given media-root-relative paths.
 * @property {(payload: ScanCompletePayload) => void} [onComplete] Called once
 *   per finished run, after it resolves.
 * @property {ScanQueueLogger} [log]
 */

/**
 * @typedef {object} ScanQueue
 * @property {(kind?: FullScanKind) => void} requestFull
 * @property {(relPaths: string[]) => void} requestPaths
 * @property {() => Promise<void>} drainPathsBetweenDirs
 * @property {() => Promise<void>} idle
 * @property {() => void} stop
 * @property {() => boolean} running
 */

/**
 * Creates a scan run queue that serialises `runFull`/`runPaths` calls (at
 * most one in flight at a time) and coalesces requests that arrive while a
 * run is in flight: several `requestFull` calls collapse into a single
 * follow-up run, `requestPaths` unions its relative-path sets into one
 * pending batch, and a pending or in-flight full scan absorbs any pending
 * paths (the full walk covers everything a reconcile would).
 *
 * A running full scan does not defer pending paths until it finishes: its
 * own `runFull` implementation calls `drainPathsBetweenDirs()` between
 * directories to run them inline, keeping the freshness bound during a full
 * scan. `drainPathsBetweenDirs()` must only be called from within the
 * currently-running `runFull` (it assumes a run is already in flight and
 * does not itself manage the in-flight/coalescing state).
 *
 * @param {ScanQueueDeps} deps
 * @returns {ScanQueue}
 */
export function createScanQueue({ runFull, runPaths, onComplete, log }) {
  let inFlight = false;
  let stopped = false;
  /** @type {FullScanKind | null} */
  let pendingFullKind = null;
  /** @type {Set<string> | null} */
  let pendingPaths = null;
  /** @type {Array<() => void>} */
  let idleWaiters = [];

  /**
   * Reports a finished run, tolerating a throwing `onComplete` so it never
   * breaks the queue.
   * @param {ScanRunKind} kind
   * @param {unknown} stats
   * @returns {void}
   */
  function complete(kind, stats) {
    try {
      onComplete?.({ kind, stats });
    } catch (err) {
      log?.error('library_scan_queue_oncomplete_failed', {
        kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Executes one run and reports its completion. A thrown/rejected `fn` is
   * logged and swallowed (no completion is reported for it) so the queue
   * keeps serving requests afterward.
   * @param {ScanRunKind} kind
   * @param {() => Promise<unknown>} fn
   * @returns {Promise<void>}
   */
  async function executeRun(kind, fn) {
    try {
      const stats = await fn();
      complete(kind, stats);
    } catch (err) {
      log?.error('library_scan_run_failed', {
        kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** @returns {void} */
  function settleIdle() {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Starts the next coalesced run when one is pending and none is in
   * flight, chains directly into whatever coalesced while it ran, and
   * settles `idle()` waiters once the queue empties.
   * @returns {Promise<void>}
   */
  async function startNext() {
    if (inFlight || stopped) return;
    /** @type {{ kind: ScanRunKind, fn: () => Promise<unknown> } | null} */
    let job = null;
    if (pendingFullKind) {
      const kind = pendingFullKind;
      pendingFullKind = null;
      job = { kind, fn: () => runFull(kind) };
    } else if (pendingPaths && pendingPaths.size > 0) {
      const paths = [...pendingPaths];
      pendingPaths = null;
      job = { kind: 'paths', fn: () => runPaths(paths) };
    }
    if (!job) return;
    inFlight = true;
    await executeRun(job.kind, job.fn);
    inFlight = false;
    if (!stopped && (pendingFullKind || (pendingPaths && pendingPaths.size > 0))) {
      void startNext();
    } else {
      settleIdle();
    }
  }

  /**
   * Requests a full scan. Coalesces with any run already in flight or
   * pending: several calls collapse into one follow-up run, and it drops
   * any pending paths (the follow-up full walk will cover them).
   * @param {FullScanKind} [kind]
   * @returns {void}
   */
  function requestFull(kind = 'full') {
    if (stopped) return;
    pendingFullKind = kind;
    pendingPaths = null;
    if (!inFlight) void startNext();
  }

  /**
   * Requests a reconcile of the given relative paths, unioning them into
   * any already-pending set. Dropped when a full scan is pending or in
   * flight — it will cover them instead.
   * @param {string[]} relPaths
   * @returns {void}
   */
  function requestPaths(relPaths) {
    if (stopped || relPaths.length === 0 || pendingFullKind) return;
    pendingPaths ??= new Set();
    for (const path of relPaths) pendingPaths.add(path);
    if (!inFlight) void startNext();
  }

  /**
   * Runs any pending paths inline, for the currently-running `runFull` to
   * call between directories. A no-op when nothing is pending or a full
   * scan is already queued to absorb them. Does not itself manage the
   * in-flight state — the caller (the enclosing full run) already holds it.
   * @returns {Promise<void>}
   */
  async function drainPathsBetweenDirs() {
    if (stopped || pendingFullKind || !pendingPaths || pendingPaths.size === 0) return;
    const paths = [...pendingPaths];
    pendingPaths = null;
    await executeRun('paths', () => runPaths(paths));
  }

  /**
   * Resolves once the queue has no run in flight and nothing pending.
   * @returns {Promise<void>}
   */
  function idle() {
    if (!inFlight && !pendingFullKind && !(pendingPaths && pendingPaths.size > 0)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  /**
   * Prevents any further run from starting. A run already in flight
   * finishes normally; nothing pending is started after it.
   * @returns {void}
   */
  function stop() {
    stopped = true;
    pendingFullKind = null;
    pendingPaths = null;
  }

  /**
   * @returns {boolean} Whether a run is currently in flight.
   */
  function running() {
    return inFlight;
  }

  return { requestFull, requestPaths, drainPathsBetweenDirs, idle, stop, running };
}
