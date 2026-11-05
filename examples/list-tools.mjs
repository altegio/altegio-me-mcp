// Run against a local server: node examples/list-tools.mjs [MCP_URL]
import assert from 'node:assert/strict';
import process from 'node:process';
import { URL } from 'node:url';

const url = new URL(process.argv[2] ?? 'http://127.0.0.1:8080/mcp');
assert.ok(['http:', 'https:'].includes(url.protocol));
const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
// Optional partner caller token; local .env.example permits anonymous discovery.
if (process.env.ALTEGIO_CALLER_TOKEN) {
  headers.authorization = `Bearer ${process.env.ALTEGIO_CALLER_TOKEN}`;
}
for (const [id, method, params] of [
  [
    1,
    'initialize',
    {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'list-tools-example', version: '1' },
    },
  ],
  [2, 'tools/list', {}],
]) {
  const response = await globalThis.fetch(url, {
    method: 'POST',
    headers,
    signal: globalThis.AbortSignal.timeout(10000),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  assert.equal(
    response.status,
    200,
    `${method} failed with HTTP ${response.status}`
  );
  const body = await response.json();
  assert.ok(body.result && !body.error, `${method} returned a protocol error`);
  assert.equal(response.headers.get('mcp-session-id'), null);
  if (method === 'tools/list') {
    process.stdout.write(
      body.result.tools
        .map((tool) => tool.name)
        .sort()
        .join('\n') + '\n'
    );
  }
}
