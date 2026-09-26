// @ts-check

import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sendMedia } from '../../src/http/stream.js';

/**
 * @typedef {import('../../src/http/stream.js').SendMediaOptions} SendMediaOptions
 * @typedef {import('../../src/http/stream.js').SendMediaResult} SendMediaResult
 */

/**
 * A deterministic, non-repeating-within-one-byte-range fill so a byte-exact
 * comparison can't pass by coincidence.
 * @param {number} size
 * @param {number} [seed]
 * @returns {Buffer}
 */
export function patternBuffer(size, seed = 0) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i + seed) % 256;
  return buf;
}

/**
 * Creates a fresh temp directory and registers its removal on `t.after`.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<string>}
 */
export async function makeTempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vt-stream-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Writes `content` under `dir/name` and returns the full path.
 * @param {string} dir
 * @param {string} name
 * @param {Buffer | string} content
 * @returns {Promise<string>}
 */
export async function writeFile(dir, name, content) {
  const filePath = path.join(dir, name);
  await fsp.writeFile(filePath, content);
  return filePath;
}

/**
 * Starts an HTTP server whose single handler calls
 * `sendMedia(req, res, optsFor(req))`, collecting every settled result and
 * letting a test await the next one (`nextResult()`, only safe to call
 * *before* the event that settles it — awaiting it after the triggering
 * request has already finished races an already-pushed result). Registers
 * the server's shutdown on `t.after`.
 * @param {import('node:test').TestContext} t
 * @param {(req: import('node:http').IncomingMessage) => SendMediaOptions} optsFor
 */
export async function startServer(t, optsFor) {
  /** @type {SendMediaResult[]} */
  const results = [];
  /** @type {Array<(r: SendMediaResult) => void>} */
  const waiters = [];
  const server = http.createServer((req, res) => {
    sendMedia(req, res, optsFor(req)).then((result) => {
      results.push(result);
      waiters.shift()?.(result);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    port: address.port,
    results,
    nextResult: () => new Promise((res) => waiters.push(res)),
  };
}

/**
 * Performs a request and buffers the full body.
 * @param {number} port
 * @param {string} pathname
 * @param {RequestInit} [init]
 */
export async function get(port, pathname, init = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body };
}

/**
 * A test seam that wraps every opened handle in a Proxy recording whether
 * `close()` was called, while remaining a real `FileHandle` for
 * `fs.createReadStream`'s `fd:` option — a Proxy's default traps forward
 * `instanceof` (and every other check) to its target.
 */
export function trackedOpenFile() {
  let closed = false;
  return {
    /** @param {string} p */
    openFile: async (p) => {
      const handle = await fsp.open(p, 'r');
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === 'close') {
            return async () => {
              closed = true;
              return target.close();
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    isClosed: () => closed,
  };
}

/**
 * Polls `predicate` until it is true or `timeoutMs` elapses.
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
export async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await delay(20);
  }
}
