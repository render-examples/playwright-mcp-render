#!/bin/sh
# Render entrypoint for Playwright MCP.
#
# Two startup profiles, selected by the DEMO env var (default off):
#
#   DEMO unset/false  -> full app. Every capability enabled, no origin limits.
#                        This is what a fork gets. Keep the URL private / put it
#                        behind your own auth — Playwright MCP ships no auth.
#
#   DEMO=true         -> public, locked-down demo. Each connection gets its own
#                        in-memory (isolated) browser session that never touches
#                        disk, obvious internal origins are blocked, service
#                        workers are off, and navigation/action timeouts are tight.
#
# Both profiles read the port from $PORT (Render sets it) and scope the server's
# host check to this service's own hostname via $RENDER_EXTERNAL_HOSTNAME
# (Render sets it automatically), falling back to "*" for local runs.
set -eu

PORT="${PORT:-10000}"
ALLOWED_HOSTS="${RENDER_EXTERNAL_HOSTNAME:-*}"

# Match DEMO case-insensitively and accept common truthy spellings, so a value
# typed straight into the Render dashboard ("True", "yes", "on") can't silently
# fall through to the full server.
case "$(printf '%s' "${DEMO:-false}" | tr '[:upper:]' '[:lower:]')" in
  true | 1 | yes | on)
    echo "[startup] DEMO mode enabled — public, locked-down, per-connection isolated browser sessions"
    exec node /app/cli.js \
      --headless --browser chromium --no-sandbox \
      --host 0.0.0.0 --port "$PORT" \
      --allowed-hosts "$ALLOWED_HOSTS" \
      --isolated \
      --block-service-workers \
      --blocked-origins "http://localhost;https://localhost;http://127.0.0.1;https://127.0.0.1;http://[::1];https://[::1];http://169.254.169.254;http://metadata.google.internal;http://metadata" \
      --timeout-navigation 30000 \
      --timeout-action 5000 \
      --image-responses omit
    ;;
  *)
    echo "[startup] normal mode — full capabilities (set DEMO=true for the locked-down public demo)"
    exec node /app/cli.js \
      --headless --browser chromium --no-sandbox \
      --host 0.0.0.0 --port "$PORT" \
      --allowed-hosts "$ALLOWED_HOSTS"
    ;;
esac
