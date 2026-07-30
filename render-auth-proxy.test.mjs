// Wiring tests for the bearer-token gate: the real proxy process, over a stub
// upstream, on a loopback port. No Docker and no browser, so these run in seconds and
// are cheap enough to run while editing — which render-smoke-test.sh is not, and that
// is why a broken rate limiter reached production once already.
//
// The gate's failure budget is per process, so any test that cares about the limit
// starts its own gate.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PROXY = fileURLToPath(new URL('./render-auth-proxy.mjs', import.meta.url));
const TOKEN = 'test-token-not-a-secret';

// Reports what reached upstream, so "the request was forwarded" and "the credential
// was not" are both observable from the client side.
const STUB_UPSTREAM = `
  require('http')
    .createServer((req, res) => {
      let bytes = 0;
      req.on('data', chunk => (bytes += chunk.length));
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'X-Upstream-Authorization': String(req.headers.authorization ?? 'absent'),
          'X-Upstream-Bytes': String(bytes),
        });
        res.end('upstream ok\\n');
      });
    })
    .listen(process.env.UPSTREAM_PORT, '127.0.0.1');
`;

// Racy in principle — the port could be taken between close and re-bind — but this is
// loopback on a test runner, and the alternative is hard-coding a port that collides
// with whatever else the machine is doing.
const freePort = () =>
  new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const request = (port, { headers = {}, body = '' } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers }, res => {
      res.setEncoding('utf8');
      let text = '';
      res.on('data', chunk => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });

const bearer = token => ({ Authorization: `Bearer ${token}` });

// Runs the proxy the way the entrypoint does, with a stub in place of the MCP server,
// and resolves once it is answering. Collects output so a failure can show why.
const running = [];
const startGate = async (env = {}) => {
  const port = await freePort();
  const upstreamPort = await freePort();
  const child = spawn(process.execPath, [PROXY, process.execPath, '-e', STUB_UPSTREAM], {
    env: { ...process.env, PORT: String(port), UPSTREAM_PORT: String(upstreamPort), MCP_TOKEN: TOKEN, ...env },
    // Own process group, so cleanup can take the stub upstream down with the gate. The
    // gate spawns it with inherited stdio, so a surviving stub holds these pipes open
    // and this test process never exits.
    detached: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => (output += chunk));
  child.stderr.on('data', chunk => (output += chunk));
  running.push(child);

  // Polled with a *valid* token on purpose: an unauthenticated probe would spend the
  // very budget the tests below are measuring.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) assert.fail(`gate exited ${child.exitCode} during startup:\n${output}`);
    try {
      const res = await request(port, { headers: bearer(TOKEN) });
      if (res.status === 200) return { port, log: () => output };
    } catch {
      // Not listening yet: the gate holds $PORT closed until upstream accepts.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`gate never answered on port ${port}:\n${output}`);
};

after(() => {
  for (const child of running) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone, which is the only other acceptable state.
    }
  }
});

// Runs the proxy to completion and reports how it died — for the startup checks, where
// refusing to run *is* the pass condition.
const gateExit = (env = {}) =>
  new Promise(resolve => {
    const child = spawn(process.execPath, [PROXY, process.execPath, '-e', ''], {
      env: { ...process.env, PORT: '10000', UPSTREAM_PORT: '8931', MCP_TOKEN: TOKEN, ...env },
    });
    let output = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => (output += chunk));
    child.on('exit', code => resolve({ code, output }));
  });

test('refuses to start without MCP_TOKEN', async () => {
  const { code, output } = await gateExit({ MCP_TOKEN: '' });
  assert.notEqual(code, 0, 'an unauthenticated gate must not run');
  assert.match(output, /MCP_TOKEN is not set/);
});

test('refuses to start on a malformed port', async () => {
  const { code, output } = await gateExit({ PORT: 'eighty' });
  assert.notEqual(code, 0, 'listen(NaN) would bind a random port and look healthy');
  assert.match(output, /PORT is not a valid port/);
});

test('forwards an authenticated request and keeps the token at the door', async () => {
  const { port } = await startGate();
  const res = await request(port, { headers: bearer(TOKEN), body: 'ping' });
  assert.equal(res.status, 200);
  assert.equal(res.body, 'upstream ok\n');
  assert.equal(res.headers['x-upstream-authorization'], 'absent', 'the bearer token must not reach upstream');
  assert.equal(res.headers['x-upstream-bytes'], '4', 'the request body must reach upstream intact');
});

test('answers 401 with no token and with a wrong one', async () => {
  const { port } = await startGate();
  for (const headers of [{}, bearer('wrong'), { Authorization: TOKEN }, bearer(TOKEN.slice(0, 8))]) {
    const res = await request(port, { headers });
    assert.equal(res.status, 401, `expected 401 for headers ${JSON.stringify(headers)}`);
    assert.equal(res.headers['www-authenticate'], 'Bearer');
  }
});

test('accepts the Bearer scheme case-insensitively', async () => {
  const { port } = await startGate();
  const res = await request(port, { headers: { Authorization: `bEaReR ${TOKEN}` } });
  assert.equal(res.status, 200);
});

test('the 10th consecutive failure is the first 429', async () => {
  const { port, log } = await startGate();
  for (let attempt = 1; attempt < 10; attempt++) {
    const res = await request(port, { headers: bearer('wrong') });
    assert.equal(res.status, 401, `attempt ${attempt} should be 401, not ${res.status}`);
  }
  const limited = await request(port, { headers: bearer('wrong') });
  assert.equal(limited.status, 429, 'the attempt that reaches the limit must itself be refused');
  const retryAfter = Number(limited.headers['retry-after']);
  assert.ok(retryAfter > 0 && retryAfter <= 60, `Retry-After should be within the window, got ${retryAfter}`);

  // One line on crossing, not one per attempt: an attacker must not be able to drown
  // the log. Ten more failures should add nothing.
  for (let attempt = 0; attempt < 10; attempt++)
    assert.equal((await request(port, { headers: bearer('wrong') })).status, 429);
  const lines = log().split('\n').filter(line => line.includes('rate limiting'));
  assert.equal(lines.length, 1, `expected exactly one rate-limiting line, got:\n${lines.join('\n')}`);
});

// The regression this whole change exists for. The old gate keyed its counter on the
// rightmost X-Forwarded-For entry, which on Render is a proxy hop that varies per
// request — so every failure landed on a fresh counter and 429 never came.
test('429 still arrives when the rightmost X-Forwarded-For varies per request', async () => {
  const { port } = await startGate({ RENDER_EXTERNAL_HOSTNAME: 'example.onrender.com' });
  const codes = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await request(port, {
      headers: { ...bearer('wrong'), 'X-Forwarded-For': `203.0.113.9, 10.0.${attempt}.${attempt + 1}` },
    });
    codes.push(res.status);
  }
  assert.deepEqual(codes, [...Array(9).fill(401), ...Array(3).fill(429)]);
});

test('a valid token still gets through while the budget is exhausted', async () => {
  const { port } = await startGate();
  for (let attempt = 0; attempt < 12; attempt++) await request(port, { headers: bearer('wrong') });
  assert.equal((await request(port, { headers: bearer('wrong') })).status, 429, 'budget should be spent');

  const res = await request(port, { headers: bearer(TOKEN), body: 'ping' });
  assert.equal(res.status, 200, 'the lockout must never be aimable at the token holder');

  // And authenticating must not refill the budget for the attacker.
  assert.equal((await request(port, { headers: bearer('wrong') })).status, 429);
});

test('a large refused body does not break the response', async () => {
  const { port } = await startGate();
  const res = await request(port, { headers: bearer('wrong'), body: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(res.status, 401);
});

test('refuses to proxy a connection upgrade', async () => {
  const { port } = await startGate();
  const res = await request(port, {
    headers: { ...bearer(TOKEN), Connection: 'Upgrade', Upgrade: 'websocket' },
  });
  assert.equal(res.status, 501);
});
