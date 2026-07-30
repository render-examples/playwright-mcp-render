// Unit tests for the failure budget. It takes a clock, so every window boundary here
// is exact and nothing sleeps — the whole file runs in milliseconds.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFailureBudget } from './render-auth-limiter.mjs';

// A budget wired to a clock the test moves by hand.
const budgetAt = (limit, windowMs, start = 1_000) => {
  let clock = start;
  const record = createFailureBudget({ limit, windowMs, now: () => clock });
  return { record, advance: ms => (clock += ms) };
};

test('the failure that reaches the limit is itself refused', () => {
  const { record } = budgetAt(10, 60_000);
  for (let attempt = 1; attempt < 10; attempt++)
    assert.equal(record(), 0, `attempt ${attempt} should still have budget`);
  assert.ok(record() > 0, 'the 10th attempt should be refused, not the 11th');
});

test('a limit of 1 refuses the very first failure', () => {
  const { record } = budgetAt(1, 60_000);
  assert.ok(record() > 0);
});

test('the lockout lasts the rest of the window and no longer', () => {
  const { record, advance } = budgetAt(10, 60_000);
  for (let attempt = 1; attempt < 10; attempt++) record();

  // Exhausted 0ms into the window, so the whole window remains.
  assert.equal(record(), 60_000);
  advance(59_999);
  assert.equal(record(), 1, 'still refused with 1ms to go');
  advance(1);
  // The window has elapsed: this failure opens a fresh one and is allowed.
  assert.equal(record(), 0, 'the window should have reset');
});

test('Retry-After counts down within the window', () => {
  const { record, advance } = budgetAt(3, 30_000);
  record();
  advance(5_000);
  record();
  advance(5_000);
  assert.equal(record(), 20_000, 'remaining is measured from the window start, not the last failure');
});

test('a fresh window gets the full allowance again', () => {
  const { record, advance } = budgetAt(3, 60_000);
  record();
  record();
  assert.ok(record() > 0);
  advance(60_000);
  assert.equal(record(), 0);
  assert.equal(record(), 0);
  assert.ok(record() > 0, 'and is refused again at the limit');
});

test('failures spread across a window still accumulate', () => {
  // Nothing here resets the count early: a slow attacker is capped just the same.
  const { record, advance } = budgetAt(5, 60_000);
  for (let attempt = 1; attempt < 5; attempt++) {
    assert.equal(record(), 0);
    advance(1_000);
  }
  assert.ok(record() > 0);
});

test('the window is not extended by failures inside it', () => {
  const { record, advance } = budgetAt(2, 10_000);
  record();
  advance(9_000);
  assert.equal(record(), 1_000, 'the 2nd failure must not push the reset out to 19s');
});

test('two budgets are independent', () => {
  // The proxy makes one; nothing about the closure should be shared or module-level.
  const a = budgetAt(2, 60_000);
  const b = budgetAt(2, 60_000);
  a.record();
  assert.ok(a.record() > 0);
  assert.equal(b.record(), 0, 'budget b should be untouched by budget a');
});

test('defaults to the real clock when none is injected', () => {
  const record = createFailureBudget({ limit: 2, windowMs: 60_000 });
  assert.equal(record(), 0);
  assert.ok(record() > 0);
});
