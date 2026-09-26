import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoginLimiter } from '../../src/auth/rate-limit.js';

/**
 * A controllable clock for deterministic sliding-window tests.
 * @param {number} [start]
 * @returns {{ now: () => number, advance: (ms: number) => void }}
 */
function fakeClock(start = 0) {
  let current = start;
  /** @param {number} ms */
  const advance = (ms) => {
    current += ms;
  };
  return { now: () => current, advance };
}

test('allows the first maxFailures attempts, blocks the next', () => {
  const { now } = fakeClock();
  const limiter = createLoginLimiter({ maxFailures: 5, windowMs: 900000, now });

  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.check('julia').allowed, true, `attempt ${i + 1} should be allowed`);
    limiter.fail('julia');
  }
  const sixth = limiter.check('julia');
  assert.equal(sixth.allowed, false);
  assert.equal(typeof sixth.retryAfterSec, 'number');
});

test('retryAfterSec is rounded up to the next whole second', () => {
  const { now, advance } = fakeClock();
  const limiter = createLoginLimiter({ maxFailures: 1, windowMs: 10000, now });

  limiter.fail('julia'); // failure at t=0, window ends at t=10000
  advance(9500); // 500ms remaining in the window
  const result = limiter.check('julia');
  assert.equal(result.allowed, false);
  // 500ms remaining -> ceil(0.5) = 1s
  assert.equal(result.retryAfterSec, 1);
});

test('the window expires and access is restored without an explicit reset', () => {
  const { now, advance } = fakeClock();
  const limiter = createLoginLimiter({ maxFailures: 2, windowMs: 1000, now });

  limiter.fail('julia');
  limiter.fail('julia');
  assert.equal(limiter.check('julia').allowed, false);

  advance(1001);
  assert.equal(limiter.check('julia').allowed, true);
});

test('reset clears failures on a successful login', () => {
  const { now } = fakeClock();
  const limiter = createLoginLimiter({ maxFailures: 2, windowMs: 900000, now });

  limiter.fail('julia');
  limiter.fail('julia');
  assert.equal(limiter.check('julia').allowed, false);

  limiter.reset('julia');
  assert.equal(limiter.check('julia').allowed, true);
});

test('keys are independent of each other', () => {
  const { now } = fakeClock();
  const limiter = createLoginLimiter({ maxFailures: 1, windowMs: 900000, now });

  limiter.fail('julia');
  assert.equal(limiter.check('julia').allowed, false);
  assert.equal(limiter.check('marco').allowed, true);
});

test('evicts the least-recently-failed key once maxKeys is exceeded', () => {
  const { now } = fakeClock();
  const limiter = createLoginLimiter({ maxFailures: 1, windowMs: 900000, maxKeys: 2, now });

  limiter.fail('julia'); // oldest
  limiter.fail('marco');
  assert.equal(limiter.check('julia').allowed, false);
  assert.equal(limiter.check('marco').allowed, false);

  limiter.fail('petra'); // should evict 'julia' (least recently failed)
  assert.equal(limiter.check('julia').allowed, true, 'julia should have been evicted');
  assert.equal(limiter.check('marco').allowed, false, 'marco should still be blocked');
  assert.equal(limiter.check('petra').allowed, false, 'petra should be blocked');
});
