// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeKill, terminateRun } from '../../src/convert/queue-kill.js';
import { fakeLogger } from '../helpers/conversion-queue-fixtures.js';

/** @param {(signal: string) => void} kill @param {number} [killGraceMs] */
function makeState(kill, killGraceMs = 20) {
  const { log, calls } = fakeLogger();
  const state = { log, killGraceMs, currentHandle: /** @type {any} */ ({ result: new Promise(() => {}), kill }), killTimer: /** @type {NodeJS.Timeout | null} */ (null) };
  return { state, calls };
}

test('terminateRun sends SIGTERM now and one SIGKILL after killGraceMs; a repeat call re-arms nothing', async () => {
  const sent = /** @type {string[]} */ ([]);
  const { state } = makeState((s) => sent.push(s));
  terminateRun(state);
  const timer = state.killTimer;
  assert.ok(timer);
  terminateRun(state);
  assert.equal(state.killTimer, timer, 'the armed timer is reused, not overwritten');
  assert.deepEqual(sent, ['SIGTERM']);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(sent, ['SIGTERM', 'SIGKILL']);
  assert.equal(state.killTimer, null);
});

test('terminateRun without a handle is a no-op', () => {
  const { state } = makeState(() => assert.fail('no kill expected'));
  state.currentHandle = null;
  terminateRun(state);
  assert.equal(state.killTimer, null);
});

test('safeKill logs a throwing kill() instead of throwing', () => {
  const { state, calls } = makeState(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  assert.doesNotThrow(() => safeKill(state, state.currentHandle, 'SIGTERM'));
  assert.deepEqual(calls.find((c) => c.event === 'conversion_error')?.fields, { code: 'ESRCH' });
});
