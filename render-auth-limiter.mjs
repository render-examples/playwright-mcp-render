// A fixed-window cap on failed authentications, counted across all clients.
//
// Deliberately not per-client: the gate protects one shared secret, so the property
// worth guaranteeing is a ceiling on total guesses per window. Keying on the client
// address cannot provide that — an attacker rotating addresses gets a fresh budget
// each time — and behind Render's edge the address is not reliably knowable anyway.
//
// Fixed window rather than a token bucket: the numbers are a brute-force backstop,
// not a traffic shaper, and a window is one integer and one timestamp with no refill
// arithmetic to get wrong. `now` is injectable so the behaviour is testable without
// sleeping; nothing else here has side effects.
export const createFailureBudget = ({ limit, windowMs, now = Date.now }) => {
  let failures = 0;
  let resetAt = 0;

  // Records one failure and reports what it cost:
  //
  //   retryAfterMs — milliseconds of lockout remaining, or 0 while the budget has room
  //   justLocked   — true only on the failure that exhausts the budget
  //
  // Recording and deciding are one step so the failure that reaches the limit is itself
  // refused with a 429. `justLocked` is reported rather than left to the caller because
  // it is an edge in *this* window's state: a caller tracking it with its own flag would
  // be keeping half a state machine, and would re-arm on any future return of 0.
  return () => {
    const at = now();
    if (resetAt <= at) {
      failures = 0;
      resetAt = at + windowMs;
    }
    failures += 1;
    return {
      retryAfterMs: failures >= limit ? resetAt - at : 0,
      justLocked: failures === limit,
    };
  };
};
