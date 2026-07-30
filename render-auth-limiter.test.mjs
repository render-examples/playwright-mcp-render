// Unit tests for the failure budget. It takes a clock, so every window boundary here
// is exact and nothing sleeps — the whole file runs in milliseconds.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFailureBudget } from './render-auth-limiter.mjs';

// A budget wired to a clock the test moves by hand. `record` returns the budget's own
// {retryAfterMs, justLocked}; `lockout` narrows it to the millisecond figure, which is
// all most of these cases are about.
const budgetAt = (limit, windowMs, start = 1_000) => {
  let clock = start;
  const record = createFailureBudget({ limit, windowMs, now: () => clock });
  return { record, lockout: () => record().retryAfterMs, advance: ms => (clock += ms) };
};

test('the failure that reaches the limit is itself refused', () => {
  const { lockout } = budgetAt(10, 60_000);
  for (let attempt = 1; attempt < 10; attempt++)
    assert.equal(lockout(), 0, `attempt ${attempt} should still have budget`);
  assert.ok(lockout() > 0, 'the 10th attempt should be refused, not the 11th');
});

test('a limit of 1 refuses the very first failure', () => {
  const { lockout } = budgetAt(1, 60_000);
  assert.ok(lockout() > 0);
});

test('the lockout lasts the rest of the window and no longer', () => {
  const { lockout, advance } = budgetAt(10, 60_000);
  for (let attempt = 1; attempt < 10; attempt++) lockout();

  // Exhausted 0ms into the window, so the whole window remains.
  assert.equal(lockout(), 60_000);
  advance(59_999);
  assert.equal(lockout(), 1, 'still refused with 1ms to go');
  advance(1);
  // The window has elapsed: this failure opens a fresh one and is allowed.
  assert.equal(lockout(), 0, 'the window should have reset');
});

test('Retry-After counts down within the window', () => {
  const { lockout, advance } = budgetAt(3, 30_000);
  lockout();
  advance(5_000);
  lockout();
  advance(5_000);
  assert.equal(lockout(), 20_000, 'remaining is measured from the window start, not the last failure');
});

test('a fresh window gets the full allowance again', () => {
  const { lockout, advance } = budgetAt(3, 60_000);
  lockout();
  lockout();
  assert.ok(lockout() > 0);
  advance(60_000);
  assert.equal(lockout(), 0);
  assert.equal(lockout(), 0);
  assert.ok(lockout() > 0, 'and is refused again at the limit');
});

test('failures spread across a window still accumulate', () => {
  // Nothing here resets the count early: a slow attacker is capped just the same.
  const { lockout, advance } = budgetAt(5, 60_000);
  for (let attempt = 1; attempt < 5; attempt++) {
    assert.equal(lockout(), 0);
    advance(1_000);
  }
  assert.ok(lockout() > 0);
});

test('the window is not extended by failures inside it', () => {
  const { lockout, advance } = budgetAt(2, 10_000);
  lockout();
  advance(9_000);
  assert.equal(lockout(), 1_000, 'the 2nd failure must not push the reset out to 19s');
});

test('two budgets are independent', () => {
  // The proxy makes one; nothing about the closure should be shared or module-level.
  const a = budgetAt(2, 60_000);
  const b = budgetAt(2, 60_000);
  a.lockout();
  assert.ok(a.lockout() > 0);
  assert.equal(b.lockout(), 0, 'budget b should be untouched by budget a');
});

test('defaults to the real clock when none is injected', () => {
  const record = createFailureBudget({ limit: 2, windowMs: 60_000 });
  assert.equal(record().retryAfterMs, 0);
  assert.ok(record().retryAfterMs > 0);
});

// justLocked is what the proxy logs on, so "exactly once per window" is the property
// that keeps an attacker from flooding the log.
test('justLocked is true on the failure that exhausts the budget and no other', () => {
  const { record, advance } = budgetAt(3, 60_000);
  assert.deepEqual(record(), { retryAfterMs: 0, justLocked: false });
  assert.deepEqual(record(), { retryAfterMs: 0, justLocked: false });
  assert.deepEqual(record(), { retryAfterMs: 60_000, justLocked: true });

  // Still locked out, but the crossing has already been reported.
  advance(1_000);
  assert.deepEqual(record(), { retryAfterMs: 59_000, justLocked: false });

  // A new window re-arms it, so each lockout is announced exactly once.
  advance(59_000);
  assert.equal(record().justLocked, false, 'the fresh window has budget again');
  record();
  assert.equal(record().justLocked, true, 'the new window announces its own lockout');
});
