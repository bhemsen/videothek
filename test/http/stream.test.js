import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { makeTempDir, writeFile, startServer, get, trackedOpenFile, waitFor, patternBuffer } from '../helpers/http-stream.js';

// ---------- 200 / 206 / headers ----------

test('GET with no Range answers 200 with the byte-exact body and the default headers', async (t) => {
  const dir = await makeTempDir(t);
  const buf = patternBuffer(10_000);
  const file = await writeFile(dir, 'movie.mp4', buf);
  const srv = await startServer(t, () => ({ path: file }));

  const res = await get(srv.port, '/');
  assert.equal(res.status, 200);
  assert.equal(res.body.equals(buf), true);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('content-length'), String(buf.length));
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('cache-control'), 'private, no-cache');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-range'), null);
});

test('GET with a satisfiable Range answers 206 with the byte-exact slice and Content-Range', async (t) => {
  const dir = await makeTempDir(t);
  const buf = patternBuffer(10_000);
  const file = await writeFile(dir, 'movie.mp4', buf);
  const srv = await startServer(t, () => ({ path: file }));

  const res = await get(srv.port, '/', { headers: { Range: 'bytes=100-199' } });
  assert.equal(res.status, 206);
  assert.equal(res.body.equals(buf.subarray(100, 200)), true);
  assert.equal(res.headers.get('content-length'), '100');
  assert.equal(res.headers.get('content-range'), `bytes 100-199/${buf.length}`);
});

test('cacheControl option overrides the default Cache-Control header', async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeFile(dir, 'cover.jpg', patternBuffer(100));
  const srv = await startServer(t, () => ({ path: file, cacheControl: 'public, max-age=3600' }));

  const res = await get(srv.port, '/');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
});

test('contentType option overrides the extension-derived default', async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeFile(dir, 'sidecar.vtt', 'WEBVTT\n');
  const srv = await startServer(t, () => ({ path: file, contentType: 'text/vtt; charset=utf-8' }));

  const res = await get(srv.port, '/');
  assert.equal(res.headers.get('content-type'), 'text/vtt; charset=utf-8');
});

// ---------- 416 ----------

test('an unsatisfiable Range answers 416 with Content-Range bytes */size', async (t) => {
  const dir = await makeTempDir(t);
  const buf = patternBuffer(1000);
  const file = await writeFile(dir, 'movie.mp4', buf);
  const srv = await startServer(t, () => ({ path: file }));

  const res = await get(srv.port, '/', { headers: { Range: 'bytes=5000-6000' } });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${buf.length}`);
  assert.deepEqual(JSON.parse(res.body.toString('utf8')), { error: 'range_not_satisfiable' });
});

// ---------- HEAD ----------

test('HEAD without Range answers the full Content-Length with no body', async (t) => {
  const dir = await makeTempDir(t);
  const buf = patternBuffer(10_000);
  const file = await writeFile(dir, 'movie.mp4', buf);
  const srv = await startServer(t, () => ({ path: file }));

  const res = await get(srv.port, '/', { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(buf.length));
  assert.equal(res.headers.get('content-range'), null);
  assert.equal(res.body.length, 0);
});

test('HEAD with a Range header ignores it and still answers the full Content-Length', async (t) => {
  const dir = await makeTempDir(t);
  const buf = patternBuffer(10_000);
  const file = await writeFile(dir, 'movie.mp4', buf);
  const srv = await startServer(t, () => ({ path: file }));

  const res = await get(srv.port, '/', { method: 'HEAD', headers: { Range: 'bytes=0-99' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(buf.length));
  assert.equal(res.body.length, 0);
});

// ---------- If-Range (no validators) ----------

test('a Range request carrying If-Range is answered with a full 200', async (t) => {
  const dir = await makeTempDir(t);
  const buf = patternBuffer(10_000);
  const file = await writeFile(dir, 'movie.mp4', buf);
  const srv = await startServer(t, () => ({ path: file }));

  const res = await get(srv.port, '/', { headers: { Range: 'bytes=0-99', 'If-Range': '"whatever"' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.equals(buf), true);
  assert.equal(res.headers.get('content-range'), null);
});

// ---------- slice ----------

test('a slice serves exactly its byte window, and a Range within it resolves relative to it', async (t) => {
  const dir = await makeTempDir(t);
  const container = patternBuffer(1000);
  const file = await writeFile(dir, 'container.jpg', container);
  const slice = { offset: 200, length: 300 };
  const srv = await startServer(t, () => ({ path: file, slice }));

  const whole = await get(srv.port, '/');
  assert.equal(whole.status, 200);
  assert.equal(whole.body.equals(container.subarray(200, 500)), true);
  assert.equal(whole.headers.get('content-length'), '300');

  const ranged = await get(srv.port, '/', { headers: { Range: 'bytes=10-49' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.body.equals(container.subarray(210, 250)), true);
  assert.equal(ranged.headers.get('content-range'), 'bytes 10-49/300');
});

test('a slice extending past the end of the file answers 404', async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeFile(dir, 'container.jpg', patternBuffer(1000));
  const srv = await startServer(t, () => ({ path: file, slice: { offset: 900, length: 200 } }));

  const res = await get(srv.port, '/');
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(res.body.toString('utf8')), { error: 'not_found' });
});

// ---------- missing file / directory ----------

test('a missing file answers 404 JSON', async (t) => {
  const dir = await makeTempDir(t);
  const srv = await startServer(t, () => ({ path: `${dir}/nope.mp4` }));

  const res = await get(srv.port, '/');
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(res.body.toString('utf8')), { error: 'not_found' });
});

test('a directory answers 404 JSON', async (t) => {
  const dir = await makeTempDir(t);
  const srv = await startServer(t, () => ({ path: dir }));

  const res = await get(srv.port, '/');
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(res.body.toString('utf8')), { error: 'not_found' });
});

// ---------- injected handle is closed ----------

test('the injected handle is closed after a 200 response', async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeFile(dir, 'movie.mp4', patternBuffer(1000));
  const tracked = trackedOpenFile();
  const srv = await startServer(t, () => ({ path: file, openFile: tracked.openFile }));

  await get(srv.port, '/');
  await waitFor(tracked.isClosed, 1000);
});

test('the injected handle is closed after a 206 response', async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeFile(dir, 'movie.mp4', patternBuffer(1000));
  const tracked = trackedOpenFile();
  const srv = await startServer(t, () => ({ path: file, openFile: tracked.openFile }));

  await get(srv.port, '/', { headers: { Range: 'bytes=0-99' } });
  await waitFor(tracked.isClosed, 1000);
});

test('the injected handle is closed after a 416 response', async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeFile(dir, 'movie.mp4', patternBuffer(1000));
  const tracked = trackedOpenFile();
  const srv = await startServer(t, () => ({ path: file, openFile: tracked.openFile }));

  await get(srv.port, '/', { headers: { Range: 'bytes=5000-6000' } });
  assert.equal(tracked.isClosed(), true);
});

test('the injected handle is closed after a HEAD response', async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeFile(dir, 'movie.mp4', patternBuffer(1000));
  const tracked = trackedOpenFile();
  const srv = await startServer(t, () => ({ path: file, openFile: tracked.openFile }));

  await get(srv.port, '/', { method: 'HEAD' });
  assert.equal(tracked.isClosed(), true);
});

test('the injected handle is closed after a directory 404', async (t) => {
  const dir = await makeTempDir(t);
  const tracked = trackedOpenFile();
  const srv = await startServer(t, () => ({ path: dir, openFile: tracked.openFile }));

  await get(srv.port, '/');
  assert.equal(tracked.isClosed(), true);
});

// ---------- abort / idle timeout ----------

test('a client that disconnects mid-stream settles aborted:true and closes the handle within 1 s', async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeFile(dir, 'movie.mp4', patternBuffer(5_000_000));
  const tracked = trackedOpenFile();
  const srv = await startServer(t, () => ({ path: file, openFile: tracked.openFile }));

  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${srv.port}/`, { signal: controller.signal });
  const reader = /** @type {ReadableStream} */ (res.body).getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.ok(first.value.length > 0);

  const settled = srv.nextResult();
  controller.abort();
  const result = await settled;
  assert.equal(result.aborted, true);
  assert.equal(result.error, null);
  await waitFor(tracked.isClosed, 1000);
});

test('a paused client with a short idleTimeoutMs is disconnected and its handle is closed', async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeFile(dir, 'movie.mp4', patternBuffer(5_000_000));
  const tracked = trackedOpenFile();
  const srv = await startServer(t, () => ({ path: file, idleTimeoutMs: 150, openFile: tracked.openFile }));

  const socket = net.connect(srv.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');

  // Read only until the header terminator, then stop draining entirely so
  // the body backpressures and the read stream stops emitting 'data'.
  let headerBuf = Buffer.alloc(0);
  await new Promise((resolve) => {
    const onData = (/** @type {Buffer} */ chunk) => {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      if (headerBuf.includes('\r\n\r\n')) {
        socket.off('data', onData);
        socket.pause();
        resolve(undefined);
      }
    };
    socket.on('data', onData);
  });

  const result = await srv.nextResult();
  assert.equal(result.aborted, true);
  assert.equal(result.error, null);
  await waitFor(tracked.isClosed, 2000);
});

// ---------- concurrent downloads ----------

test('two concurrent downloads of a 32 MiB file both complete byte-exact', async (t) => {
  const dir = await makeTempDir(t);
  const size = 32 * 1024 * 1024;
  const buf = patternBuffer(size);
  const expectedHash = crypto.createHash('sha256').update(buf).digest('hex');
  const file = await writeFile(dir, 'movie.mp4', buf);
  const srv = await startServer(t, () => ({ path: file }));

  const [a, b] = await Promise.all([get(srv.port, '/'), get(srv.port, '/')]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(crypto.createHash('sha256').update(a.body).digest('hex'), expectedHash);
  assert.equal(crypto.createHash('sha256').update(b.body).digest('hex'), expectedHash);
});
