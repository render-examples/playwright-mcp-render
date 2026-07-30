// Bearer-token gate in front of Playwright MCP.
//
// Playwright MCP ships no authentication in HTTP mode, and it exposes an
// RCE-equivalent tool (browser_run_code_unsafe) that no flag can remove. On
// Render the server gets a public URL, so "anyone who reaches it" is the whole
// internet. This process is the door: it listens on $PORT, requires
// `Authorization: Bearer $MCP_TOKEN`, and forwards only authenticated requests
// to the real server on 127.0.0.1:$UPSTREAM_PORT (which is not published). Failed
// attempts share one global budget so the token can't be guessed at speed.
//
// It also acts as PID 1: it spawns the upstream server given as its argv, dies
// when the child dies, and forwards SIGTERM/SIGINT so Render's shutdown works.
//
// It binds $PORT only once that server is accepting connections, so the open port
// means the whole stack is ready rather than just this gate (see waitForUpstream).
//
// Usage: PORT=10000 UPSTREAM_PORT=8931 MCP_TOKEN=… \
//          node render-auth-proxy.mjs node /app/cli.js --port 8931 …
//
// render-entrypoint.sh is the only launcher and owns the default port values, so
// none are repeated here — a missing or malformed one is a startup error.

import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { constants as osConstants } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import { createFailureBudget } from './render-auth-limiter.mjs';

// Number() alone would turn a typo into NaN, and listen(NaN) silently binds a
// random port — the failure would only surface as an unreachable service.
const parsePort = (name, value) => {
  const port = Number(value);
  if (!value || !Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[auth] ${name} is not a valid port: ${JSON.stringify(value)}`);
    process.exit(1);
  }
  return port;
};

const PORT = parsePort('PORT', process.env.PORT);
const UPSTREAM_PORT = parsePort('UPSTREAM_PORT', process.env.UPSTREAM_PORT);
const TOKEN = process.env.MCP_TOKEN;

// Fail closed: no token, no server. There is deliberately no flag to disable
// the check — an unauthenticated deploy is never a safe default here.
if (!TOKEN) {
  console.error('[auth] MCP_TOKEN is not set. Refusing to start an unauthenticated server.');
  process.exit(1);
}

// Hash both sides so timingSafeEqual gets equal-length buffers regardless of
// the presented token's length (it throws otherwise, which would itself leak).
const digest = value => createHash('sha256').update(value).digest();
const EXPECTED = digest(TOKEN);

// The scheme is matched case-insensitively per RFC 7235; the token itself is not.
const isAuthorized = header => {
  const presented = /^Bearer (.+)$/i.exec(header || '')?.[1];
  return presented !== undefined && timingSafeEqual(digest(presented), EXPECTED);
};

// Guessing the token is the only way past this gate, so failed attempts are what
// is worth limiting. Authenticated traffic is deliberately uncapped: MCP sessions
// are long-lived and chatty, and whoever holds the token is the operator — a limit
// there would break normal use without raising the bar for an attacker.
//
// One budget for all clients rather than one per address; render-auth-limiter.mjs
// documents why, and is the place to change it.
//
// The numbers are fixed with no env override, so no deploy can be configured into a
// weaker control; the tests inject a clock instead of turning a knob.
const AUTH_FAILURE_LIMIT = 10;
const AUTH_FAILURE_WINDOW_MS = 60_000;

const recordAuthFailure = createFailureBudget({
  limit: AUTH_FAILURE_LIMIT,
  windowMs: AUTH_FAILURE_WINDOW_MS,
});

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('[auth] usage: node render-auth-proxy.mjs <upstream-command> [args...]');
  process.exit(1);
}

const child = spawn(command, args, { stdio: 'inherit' });
// Report the child's fate as our own, using the shell's 128+signal convention so
// a signal-killed server is distinguishable from a clean non-zero exit in the logs.
child.on('exit', (code, signal) =>
  process.exit(signal ? 128 + osConstants.signals[signal] : code ?? 1),
);
child.on('error', err => {
  console.error(`[auth] failed to start upstream: ${err.message}`);
  process.exit(1);
});

// Hop-by-hop headers describe a single connection, so a proxy must not pass them
// along (RFC 9110 §7.6.1); Node writes the framing ones for each hop itself, and
// forwarding a stale `transfer-encoding` alongside them invites request smuggling.
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];
// The bearer token stops at the door it opens: upstream has no use for it, and a
// credential should travel no further than it must.
const STRIP_FROM_REQUEST = new Set([...HOP_BY_HOP, 'authorization']);
const STRIP_FROM_RESPONSE = new Set(HOP_BY_HOP);

// Node lower-cases incoming header names, so a lower-case lookup is exhaustive.
const withoutHeaders = (headers, stripped) =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !stripped.has(name)));

const server = http.createServer((req, res) => {
  if (!isAuthorized(req.headers.authorization)) {
    // The budget is spent only by requests that were going to be refused anyway, so
    // a valid token never touches it and the operator can always get in. That is what
    // makes a global budget safe: the lockout cannot be aimed at whoever holds the
    // token. Note there is deliberately no forgiveness on success either — resetting
    // the budget when the operator authenticates would hand an attacker a fresh
    // allowance every time.
    const { retryAfterMs, justLocked } = recordAuthFailure();
    // Refused either way, so the body is never read; discard it rather than letting
    // an unread body tear the connection down mid-send.
    req.resume();
    if (retryAfterMs > 0) {
      // One line as the budget is spent and then silence: an attacker that could
      // produce a line per attempt could bury everything else in the log.
      if (justLocked)
        console.error(
          `[auth] rate limiting failed attempts after ${AUTH_FAILURE_LIMIT} in ${AUTH_FAILURE_WINDOW_MS / 1000}s`,
        );
      res.writeHead(429, {
        'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
        'Content-Type': 'text/plain',
      });
      res.end('Too Many Requests\n');
      return;
    }
    // No detail in the body, and never log the presented token.
    console.error(`[auth] 401 ${req.method} ${req.url}`);
    res.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Content-Type': 'text/plain' });
    res.end('Unauthorized\n');
    return;
  }

  // Host is forwarded unchanged so upstream's --allowed-hosts DNS-rebinding
  // check still sees the hostname the client actually asked for.
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: UPSTREAM_PORT,
      method: req.method,
      path: req.url,
      headers: withoutHeaders(req.headers, STRIP_FROM_REQUEST),
    },
    upstreamRes => {
      res.writeHead(upstreamRes.statusCode, withoutHeaders(upstreamRes.headers, STRIP_FROM_RESPONSE));
      upstreamRes.pipe(res);
      // A stream that dies mid-flight would otherwise just stop, which is
      // indistinguishable from a clean end. Log it and destroy the response so
      // the client sees a truncated transport rather than a silent short read.
      upstreamRes.on('aborted', () => {
        // Unless the client hung up first: that destroys `res`, and the 'close'
        // handler below destroys this request, which lands here as an abort. It
        // is how every SSE session ends normally, so it is not worth a line.
        if (res.destroyed) return;
        console.error(`[auth] upstream ended the response early: ${req.method} ${req.url}`);
        res.destroy();
      });
    },
  );
  upstream.on('error', err => {
    // Same as above: a client that disconnected mid-request takes this request
    // down with it, and that is the client's doing, not upstream's.
    if (res.destroyed) return;
    console.error(`[auth] upstream error: ${err.message}`);
    // Once headers are out the status is already committed, so a 502 is
    // impossible; writing a body here would append a bogus frame to an in-flight
    // SSE stream. Destroying is the only honest signal left.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway\n');
  });
  req.pipe(upstream);
  // Covers both a client disconnect and a completed response; destroying an
  // already-finished request is a no-op, so this needs no state of its own.
  res.on('close', () => upstream.destroy());
});

// MCP's Streamable HTTP transport never upgrades a connection, and this gate does
// not proxy one. Without a handler Node would leave the client waiting on a reply
// that never comes, so answer it instead; no token is checked because the answer
// is the same either way.
server.on('upgrade', (req, socket) => {
  console.error(`[auth] refused connection upgrade: ${req.headers.upgrade} ${req.url}`);
  socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n');
});

// Node's timeouts are left at their defaults. headersTimeout and requestTimeout
// bound only how long a client may take to *send* a request; neither bounds how
// long a *response* may stay open, so MCP's long-lived SSE streams are safe
// (server.timeout already defaults to 0, so idle streams are not cut either).
// Don't read them as a slowloris control either: on the base image's Node 22 they
// were observed not to be enforced at all, even on a bare http.Server. Bounding
// half-open connections is Render's edge, which terminates HTTP ahead of this.

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    child.kill(signal);
    server.close();
  });
}

// Without a handler a failed bind surfaces as an uncaught exception and a stack
// trace; the cause (usually the port already being in use) is what matters.
server.on('error', err => {
  console.error(`[auth] cannot listen on port ${PORT}: ${err.message}`);
  process.exit(1);
});

// Render decides a service is live as soon as something accepts on $PORT, and it
// sends no auth header, so a health check can't be the readiness signal here (that
// is why render.yaml declares none). If this gate bound immediately, "live" would
// mean "the door is staffed" while the room behind it was still empty, and the
// first requests after a deploy would get the 502 above. So don't open the door
// until upstream answers: then the open port means the whole stack is ready, and
// an upstream that never comes up fails the deploy instead of going live broken.
const UPSTREAM_ACCEPT_TIMEOUT_MS = 60_000;
const UPSTREAM_POLL_MS = 250;

// Resolves true only on a completed TCP connect. The per-attempt timeout is what
// keeps the deadline below meaningful — it is only checked between attempts, so a
// connect left hanging would otherwise wait past it forever.
const upstreamAccepts = () =>
  new Promise(resolve => {
    const socket = net.connect(UPSTREAM_PORT, '127.0.0.1');
    const settle = accepted => {
      socket.destroy();
      resolve(accepted);
    };
    socket.setTimeout(UPSTREAM_POLL_MS, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });

// A child that dies while we wait exits the process via its own 'exit' handler, so
// the usual failure needs no handling here; the deadline is for a server that stays
// up without ever listening, which would otherwise hang the deploy with no reason.
const waitForUpstream = async () => {
  const deadline = Date.now() + UPSTREAM_ACCEPT_TIMEOUT_MS;
  while (!(await upstreamAccepts())) {
    if (Date.now() >= deadline) {
      console.error(
        `[auth] upstream never accepted on 127.0.0.1:${UPSTREAM_PORT} within ${UPSTREAM_ACCEPT_TIMEOUT_MS / 1000}s. Not opening port ${PORT}.`,
      );
      process.exit(1);
    }
    await delay(UPSTREAM_POLL_MS);
  }
};

console.log(`[auth] waiting for upstream on 127.0.0.1:${UPSTREAM_PORT} before opening port ${PORT}`);
await waitForUpstream();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[auth] Bearer-token gate listening on 0.0.0.0:${PORT} → 127.0.0.1:${UPSTREAM_PORT}`);
});
