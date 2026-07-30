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

  // Records one failure and returns the milliseconds of lockout remaining, or 0 while
  // the budget still has room. Recording and deciding are one step so the failure that
  // reaches the limit is itself refused with a 429.
  return () => {
    const at = now();
    if (resetAt <= at) {
      failures = 0;
      resetAt = at + windowMs;
    }
    failures += 1;
    return failures >= limit ? resetAt - at : 0;
  };
};
