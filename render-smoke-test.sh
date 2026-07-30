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
#   2. a request without the token gets 401
#   3. a request with it completes an MCP handshake
#   4. a real browser tool call round-trips (this is the SSE path through the proxy)
#   5. SIGTERM stops the container promptly and cleanly (the proxy is PID 1)
#
# Run it after bumping the base-image tag — see the README "Rolling Playwright MCP"
# section. CI runs this same script on every pull request.
#
# Usage: ./render-smoke-test.sh
#   SMOKE_PORT=10000   host port to publish (override if 10000 is taken)
#   SMOKE_IMAGE=…      tag to build and run as
set -euo pipefail

PORT="${SMOKE_PORT:-10000}"
IMAGE="${SMOKE_IMAGE:-playwright-mcp-render:smoke}"
CONTAINER="playwright-mcp-smoke-$$"
# A fresh token per run, so a stale value can never be what makes this pass.
TOKEN="$(openssl rand -hex 16)"
WORKDIR="$(mktemp -d)"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
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
# Readiness has to be a *complete* handshake, not just a bound port: the gate binds
# immediately and answers 401 while the MCP server behind it is still starting, so
# an authenticated request in that window gets a 502 from the proxy. Polling for the
# real thing is also why a fixed sleep won't do — Chromium's first launch dominates.
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

step "4. Real browser tool call through the proxy"
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

step "5. Graceful shutdown on SIGTERM"
# Render sends SIGTERM and waits before SIGKILL. If the proxy failed to forward it,
# docker stop would sit through its own 10s timeout and the exit code would be 137.
start="$SECONDS"
docker stop "$CONTAINER" >/dev/null
elapsed="$((SECONDS - start))"
status="$(docker inspect -f '{{.State.ExitCode}}' "$CONTAINER")"
[ "$status" = "0" ] || fail "container exited $status on SIGTERM, expected 0"
[ "$elapsed" -lt 10 ] || fail "took ${elapsed}s to stop — SIGTERM was probably not forwarded"
echo "ok — stopped in ${elapsed}s with exit 0"

echo
echo "All smoke checks passed."
