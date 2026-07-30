// A fixed-window cap on failed authentications, counted across all clients.
//
// Deliberately not per-client: the gate protects one shared secret, so the property
// worth guaranteeing is a ceiling on total guesses per window. Keying on the client
// address cannot provide that — an attacker rotating addresses gets a fresh budget
// each time — and behind Render's edge the address is not reliably knowable anyway:
// the rightmost X-Forwarded-For entry is a Render proxy hop that varies from request
// to request, so the per-address version of this reached production and never counted
// past 1 — every failure landed on a fresh counter and the 429 never came.
//
// The cost of that choice: any client can hold the budget empty, and while it is
// empty a wrong token is answered 429 instead of 401. Only requests that were going
// to be refused anyway are affected — a valid token never consumes the budget and is
// never subject to it — so the lockout cannot be aimed at the operator.
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
