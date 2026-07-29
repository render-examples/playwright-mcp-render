#!/bin/sh
# Render entrypoint for Playwright MCP.
#
# One profile: the full server, every capability enabled, no origin limits.
# Playwright MCP ships no authentication in HTTP mode, so this is meant to run
# privately — as a Render private service, behind an IP allow-list, or behind
# your own auth proxy. Never expose it to the public internet.
#
# The port comes from $PORT (Render sets it) and, by default, the server's host
# check is scoped to this service's own hostname via $RENDER_EXTERNAL_HOSTNAME
# (Render sets it automatically), falling back to "*" for local runs. Set
# PLAYWRIGHT_MCP_ALLOWED_HOSTS to override — e.g. to add a custom domain
# (comma-separated) or to pass "*" to disable the host check.
set -eu

PORT="${PORT:-10000}"
ALLOWED_HOSTS="${PLAYWRIGHT_MCP_ALLOWED_HOSTS:-${RENDER_EXTERNAL_HOSTNAME:-*}}"

# Upstream's own startup banner prints "http://localhost:$PORT/mcp", which is
# misleading on Render. Print the real public URL first so anyone copy-pasting
# from the logs gets the right endpoint.
echo "[startup] Connect MCP clients to: https://${RENDER_EXTERNAL_HOSTNAME:-localhost:$PORT}/mcp"

exec node /app/cli.js \
  --headless --browser chromium --no-sandbox \
  --host 0.0.0.0 --port "$PORT" \
  --allowed-hosts "$ALLOWED_HOSTS"
