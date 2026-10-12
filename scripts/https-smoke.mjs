// Controlled TLS-terminating trusted proxy. Uses the production container,
// real v1 HMAC format and mounted key; no HTTP harness or auth-off seam.
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import https from 'node:https';

// Liveness and direct unsigned rejection are independent of protocol success.
let healthy = false;
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    const response = await globalThis.fetch('http://127.0.0.1:8080/health');
    const health = await response.json();
    if (
      response.status === 200 &&
      health.status === 'ok' &&
      health.commit === '0123abc'
    ) {
      healthy = true;
      break;
    }
  } catch {
    /* The process may still be starting. */
  }
  await delay(1000);
}
assert.equal(healthy, true, 'production container liveness/commit');
if (process.env.VERIFY_UNSIGNED !== '0') {
  const unsigned = await globalThis.fetch('http://127.0.0.1:8080/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/list' }),
  });
  assert.equal(unsigned.status, 401);
  assert.equal((await unsigned.json()).error, 'proxy_auth_required');
}

const key = readFileSync('/tmp/proxy-key', 'utf8').trim();
const cert = readFileSync('/tmp/fixture-cert.pem');
const signedIds = [];
const proxy = https.createServer(
  {
    cert,
    key: readFileSync('/tmp/fixture-key.pem'),
  },
  (req, res) => {
    const seconds = Math.floor(Date.now() / 1000);
    const requestId = randomUUID();
    signedIds.push(requestId);
    // The /me lane (ADR 0004): a caller's Bearer becomes the signed partner
    // token header, and Authorization never reaches the backend.
    const identity = { 'x-mcp-auth-request-id': requestId };
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    if (bearer !== null) {
      identity['x-mcp-auth-kind'] = 'partner';
      identity['x-mcp-auth-altegio-partner-token'] = bearer[1];
    }
    const lines = Object.keys(identity)
      .sort()
      .map((name) => `${name}:${identity[name]}`);
    const mac = createHmac('sha256', key)
      .update(
        [
          'mcp-proxy-auth/v1',
          String(seconds),
          req.method,
          req.url,
          ...lines,
        ].join('\n')
      )
      .digest('hex');
    // Drop caller-supplied identity, signature and credential before signing
    // our upstream.
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(
        ([name]) =>
          !name.startsWith('x-mcp-') &&
          name !== 'host' &&
          name !== 'authorization'
      )
    );
    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: 8080,
        path: req.url,
        method: req.method,
        headers: {
          ...headers,
          'x-forwarded-proto': 'https',
          ...identity,
          'x-mcp-proxy-auth': `v1:${seconds}:${mac}`,
        },
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      }
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  }
);
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const port = proxy.address().port;
function post(body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'localhost',
        family: 4,
        port,
        path: '/mcp',
        method: 'POST',
        ca: cert,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...extraHeaders,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: JSON.parse(text),
          })
        );
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
try {
  const init = await post({
    jsonrpc: '2.0',
    id: 101,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'https-release-fixture', version: '1' },
    },
  });
  assert.equal(init.status, 200);
  assert.equal(init.headers['x-request-id'], signedIds[0]);
  assert.equal(init.body.result.protocolVersion, '2025-11-25');
  assert.equal(init.headers['mcp-session-id'], undefined);
  const list = await post({ jsonrpc: '2.0', id: 102, method: 'tools/list' });
  assert.equal(list.status, 200);
  // The caller check is wired: a partner token of an impossible shape is
  // refused as invalid without any upstream call (ADR 0004).
  const refused = await post(
    { jsonrpc: '2.0', id: 103, method: 'tools/list' },
    { authorization: 'Bearer short' }
  );
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error, 'invalid_token');
  assert.equal(list.headers['x-request-id'], signedIds[1]);
  assert.equal(list.headers['mcp-session-id'], undefined);
  assert.deepEqual(list.body.result.tools.map((tool) => tool.name).sort(), [
    'book_check',
    'business_get',
    'business_list_dates',
    'business_list_services',
    'business_list_team_members',
    'business_list_time_slots',
    'business_search',
    'me_book',
    'me_cancel_booking',
    'me_list_bookings',
    'me_list_places',
    'me_reschedule_booking',
  ]);
  for (const tool of list.body.result.tools)
    assert.equal(tool.inputSchema.type, 'object');
  process.stdout.write(
    'PASS: signed HTTPS initialize and tool catalog, stateless responses\n'
  );
} finally {
  await new Promise((resolve) => proxy.close(resolve));
}
