#!/usr/bin/env bash
# Smoke-test the Render wrapper end to end.
#
# What this covers is exactly what upstream's own test suite cannot: this template
# doesn't build the MCP server, it wraps a prebuilt image (see Dockerfile.render).
# So the things that can break here are the wrapper's own — the base-image tag, the
# entrypoint's flags, and the bearer-token gate — and none of them are exercised by
# a test that imports src/.
#
# Checks, in order:
#   1. the container refuses to start without MCP_TOKEN (fails closed)
#   2. a request with the token completes an MCP handshake
#   3. a request without it gets 401
#   4. sustained bad tokens keep getting 401, log volume stays bounded, good one works
#   5. a real browser tool call round-trips (this is the SSE path through the proxy)
#   6. SIGTERM stops the container promptly and cleanly (the proxy is PID 1)
#   7. same behavior when RENDER_EXTERNAL_HOSTNAME and X-Forwarded-For are present
#
# Run it after bumping the base-image tag — see the README "Rolling Playwright MCP"
# section. CI runs this same script on every pull request.
#
# Usage: ./render-smoke-test.sh
#   SMOKE_PORT=10000   host port to publish (override if 10000 is taken)
#   SMOKE_FWD_PORT=…  host port for check 7's second container (default SMOKE_PORT+1)
#   SMOKE_IMAGE=…      tag to build and run as
set -euo pipefail

PORT="${SMOKE_PORT:-10000}"
FWD_PORT="${SMOKE_FWD_PORT:-$((PORT + 1))}"
IMAGE="${SMOKE_IMAGE:-playwright-mcp-render:smoke}"
CONTAINER="playwright-mcp-smoke-$$"
# A fresh token per run, so a stale value can never be what makes this pass.
TOKEN="$(openssl rand -hex 16)"
WORKDIR="$(mktemp -d)"

cleanup() {
  docker rm -f "$CONTAINER" "$CONTAINER-fwd" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Each check announces itself before it runs, so a hang is attributable.
step() { echo; echo "--- $* ---"; }

cd "$(dirname "$0")"

step "Building $IMAGE from Dockerfile.render"
docker build -f Dockerfile.render -t "$IMAGE" .

step "1. Refuses to start without MCP_TOKEN"
# Inverted on purpose: a zero exit here is the failure. The grep pins the reason,
# so an unrelated crash can't be mistaken for the gate holding the line.
if docker run --rm "$IMAGE" >"$WORKDIR/noauth.log" 2>&1; then
  fail "container started with no MCP_TOKEN set"
fi
grep -q 'MCP_TOKEN is not set' "$WORKDIR/noauth.log" \
  || fail "exited without MCP_TOKEN, but not because of the token check:
$(cat "$WORKDIR/noauth.log")"
echo "ok — exited non-zero: $(grep '\[auth\]' "$WORKDIR/noauth.log")"

step "2. Starting the container and waiting for a successful handshake"
docker run -d --name "$CONTAINER" -e MCP_TOKEN="$TOKEN" -p "$PORT:10000" "$IMAGE" >/dev/null
# Readiness is a *complete* handshake, not a reachable port. The gate deliberately
# doesn't open $PORT until upstream accepts, so early polls are refused connections
# rather than errors — and asserting the handshake proves the whole chain, which is
# the claim that matters. A fixed sleep won't do: the base image's startup varies.
for _ in $(seq 60); do
  handshake="$(curl -sS -D "$WORKDIR/headers.txt" -X POST "http://127.0.0.1:$PORT/mcp" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1"}}}' || true)"
  grep -q '"name":"Playwright"' <<<"$handshake" && break
  # If the container died, stop waiting on a port that will never answer.
  docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true \
    || fail "container exited during startup:
$(docker logs "$CONTAINER" 2>&1)"
  sleep 1
done
grep -q '"name":"Playwright"' <<<"${handshake:-}" \
  || fail "never got a serverInfo naming Playwright. Last response:
${handshake:-none}
$(docker logs "$CONTAINER" 2>&1)"
session="$(tr -d '\r' <"$WORKDIR/headers.txt" | awk 'tolower($1) == "mcp-session-id:" {print $2}')"
[ -n "$session" ] || fail "no mcp-session-id header in the initialize response"
echo "ok — serverInfo returned, session $session"

step "3. A request without the token gets 401"
code="$(curl -s -o "$WORKDIR/401.txt" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1"}}}')"
# Checked against a server already proven to answer, so a 401 here is the gate
# refusing the request rather than nothing being up yet.
[ "$code" = "401" ] || fail "unauthenticated request got $code, expected 401:
$(cat "$WORKDIR/401.txt")"
echo "ok — unauthenticated request got 401"

step "4. Sustained bad tokens keep getting 401 and don't flood the log"
# There is deliberately no per-client lockout: MCP_TOKEN is machine-generated and
# not guessable at HTTP speed, and rate limiting belongs at Render's edge (see the
# README "Security" section). What the gate must not do is let an attacker bury
# every other line in the log, so rejections are logged a few per minute and then
# summarized.
attempt() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/mcp" \
    -H "Authorization: Bearer $1" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1"}}}'
}
for i in $(seq 20); do
  code="$(attempt "not-the-token")"
  [ "$code" = "401" ] || fail "bad token #$i got $code, expected 401"
done
echo "ok — 20 bad tokens all got 401"
# 20 rejections just happened plus one from check 3, but only a handful may be
# logged individually. The bound is what matters, not the exact count.
logged="$(docker logs "$CONTAINER" 2>&1 | grep -c '\[auth\] 401' || true)"
[ "$logged" -le 10 ] \
  || fail "21 rejections produced $logged log lines — the log throttle is not engaging"
echo "ok — log volume bounded to $logged lines"
# The gate must not have broken the happy path while refusing all of that.
code="$(attempt "$TOKEN")"
[ "$code" = "200" ] || fail "valid token got $code after a burst of bad ones, expected 200"
echo "ok — the valid token still gets through"

step "5. Real browser tool call through the proxy"
mcp() {
  curl -sS --max-time 120 -X POST "http://127.0.0.1:$PORT/mcp" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "mcp-session-id: $session" \
    -d "$1"
}
mcp '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
# A data: URL keeps this hermetic — the point is to prove the tool call and its SSE
# response survive the proxy, not that the CI runner can reach the public internet.
navigate="$(mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"data:text/html,<title>smoke</title><h1>ok</h1>"}}}')"
grep -q 'Page Title: smoke' <<<"$navigate" \
  || fail "browser_navigate did not report the page it loaded:
$navigate"
echo "ok — Chromium navigated and the snapshot came back through the gate"

step "6. Graceful shutdown on SIGTERM"
# Render sends SIGTERM and waits before SIGKILL. If the proxy failed to forward it,
# docker stop would sit through its own 10s timeout and the exit code would be 137.
start="$SECONDS"
docker stop "$CONTAINER" >/dev/null
elapsed="$((SECONDS - start))"
status="$(docker inspect -f '{{.State.ExitCode}}' "$CONTAINER")"
[ "$status" = "0" ] || fail "container exited $status on SIGTERM, expected 0"
[ "$elapsed" -lt 10 ] || fail "took ${elapsed}s to stop — SIGTERM was probably not forwarded"
echo "ok — stopped in ${elapsed}s with exit 0"

step "7. Behaves the same when Render's proxy headers are present"
# Regression guard. The gate once branched on RENDER_EXTERNAL_HOSTNAME to read a
# client address out of X-Forwarded-For, and because that variable is unset
# locally, this suite ran the other branch and never saw the bug. Anything that
# reads request headers to identify a client must be exercised here, with the
# variable set and the header forged, or it is untested in the only configuration
# that ships.
FWD_CONTAINER="$CONTAINER-fwd"
docker run -d --name "$FWD_CONTAINER" \
  -e MCP_TOKEN="$TOKEN" \
  -e RENDER_EXTERNAL_HOSTNAME=smoke.onrender.com \
  -p "$FWD_PORT:10000" "$IMAGE" >/dev/null
for _ in $(seq 60); do
  curl -sS -o /dev/null "http://127.0.0.1:$FWD_PORT/mcp" 2>/dev/null && break
  docker inspect -f '{{.State.Running}}' "$FWD_CONTAINER" 2>/dev/null | grep -q true \
    || fail "forwarded-header container exited during startup:
$(docker logs "$FWD_CONTAINER" 2>&1)"
  sleep 1
done
# Each request forges a different client address. Under the old per-client scheme
# these would land in 20 separate buckets and never trip anything; the assertion
# is simply that every one is refused and the log stays bounded either way.
for i in $(seq 20); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$FWD_PORT/mcp" \
    -H "X-Forwarded-For: 203.0.113.$i, 10.0.0.$i" \
    -H 'Authorization: Bearer not-the-token' \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')"
  [ "$code" = "401" ] || fail "forged X-Forwarded-For request #$i got $code, expected 401"
done
logged="$(docker logs "$FWD_CONTAINER" 2>&1 | grep -c '\[auth\] 401' || true)"
[ "$logged" -le 10 ] \
  || fail "20 rejections with rotating X-Forwarded-For produced $logged log lines"
# And a valid token is unaffected by any of it. Host must match the hostname above,
# because setting RENDER_EXTERNAL_HOSTNAME also scopes upstream's --allowed-hosts to
# it (see render-entrypoint.sh) and the gate forwards Host unchanged so that
# DNS-rebinding check still works. Sending the real Host is what a client on Render
# does; sending 127.0.0.1 here would earn a 403 from upstream, correctly.
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$FWD_PORT/mcp" \
  -H 'Host: smoke.onrender.com' \
  -H 'X-Forwarded-For: 203.0.113.99, 10.0.0.99' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1"}}}')"
[ "$code" = "200" ] || fail "valid token got $code with proxy headers present, expected 200"
echo "ok — identical behavior with RENDER_EXTERNAL_HOSTNAME set and X-Forwarded-For forged"

echo
echo "All smoke checks passed."
