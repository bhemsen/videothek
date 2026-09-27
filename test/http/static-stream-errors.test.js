import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createStaticHandler } from '../../src/http/static.js';
import { waitFor } from '../helpers/http-stream.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/public');

/**
 * Builds a log stub that records every `error()` call.
 * @returns {{ log: { error: (event: string, fields?: Record<string, unknown>) => void }, calls: Array<{ event: string, fields?: Record<string, unknown> }> }}
 */
function spyLog() {
  /** @type {Array<{ event: string, fields?: Record<string, unknown> }>} */
  const calls = [];
  return { log: { error: (event, fields) => void calls.push({ event, fields }) }, calls };
}

/**
 * A minimal fake `res`: a real `Writable` (so `pipeline` can drive it) with a
 * no-op `writeHead` and a `destroy` spy, cast to `ServerResponse` for callers.
 * @param {ConstructorParameters<typeof Writable>[0]} options
 * @returns {{ res: import('node:http').ServerResponse, destroyed: () => boolean }}
 */
function fakeRes(options) {
  const writable = new Writable(options);
  let destroyed = false;
  const res = Object.assign(writable, {
    writeHead: () => {},
    destroy: (/** @type {Error | undefined} */ err) => {
      destroyed = true;
      return Writable.prototype.destroy.call(writable, err);
    },
  });
  return { res: /** @type {import('node:http').ServerResponse} */ (/** @type {unknown} */ (res)), destroyed: () => destroyed };
}

const REQ = /** @type {import('node:http').IncomingMessage} */ (/** @type {unknown} */ ({ method: 'GET', headers: {} }));
const CTX = { user: null, params: {}, url: new URL('http://localhost/css/tokens.css'), sessionId: null };

// Regression for #155: a client closing the connection during or right after
// receiving a static response makes `pipeline()` reject with
// `ERR_STREAM_PREMATURE_CLOSE`, which is not a real failure and must not be
// logged at `error` level. Reproduced without a real socket race by giving
// `sendFile` (via the `openReadStream` seam) a destination that destroys
// itself right after receiving the body's one chunk, instead of ever calling
// `.end()` — the same "got the full body, then the connection drops" shape.
test('a client closing the connection right after the body logs no request_error and releases the file handle', async () => {
  const { log, calls } = spyLog();
  let handleClosed = false;
  const openReadStream = (/** @type {string} */ filePath) => {
    const stream = createReadStream(filePath);
    stream.once('close', () => (handleClosed = true));
    return stream;
  };
  const handler = createStaticHandler({ publicDir: PUBLIC_DIR, log, openReadStream });
  const { res } = fakeRes({
    write(_chunk, _enc, _cb) {
      this.destroy(); // never acks the write / calls end() -> premature close
    },
  });

  const served = await handler(REQ, res, CTX);
  assert.equal(served, true);
  assert.deepEqual(calls, []);
  await waitFor(() => handleClosed, 1000);
});

// Counterpart: a genuine read failure (not a client disconnect) still
// surfaces as an `error`-level `request_error` and destroys the socket.
test('a genuine read-stream error is still logged as request_error and destroys the socket', async () => {
  const { log, calls } = spyLog();
  const openReadStream = () => {
    const stream = new Readable({ read() {} });
    process.nextTick(() => stream.destroy(new Error('boom: source read failure')));
    return stream;
  };
  const handler = createStaticHandler({ publicDir: PUBLIC_DIR, log, openReadStream });
  const { res, destroyed } = fakeRes({ write(_chunk, _enc, cb) { cb(); } });

  const served = await handler(REQ, res, CTX);
  assert.equal(served, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, 'request_error');
  assert.equal(/** @type {Record<string, unknown>} */ (calls[0].fields).method, 'GET');
  assert.equal(/** @type {Record<string, unknown>} */ (calls[0].fields).path, '/css/tokens.css');
  assert.match(String(/** @type {Record<string, unknown>} */ (calls[0].fields).stack), /boom: source read failure/);
  assert.equal(destroyed(), true);
});
