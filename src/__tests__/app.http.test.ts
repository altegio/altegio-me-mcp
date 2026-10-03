import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { get } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PACKAGE_VERSION } from '../util/package-metadata.js';
import {
  closeAllApps,
  initializeBody,
  postMcp,
  startApp,
  toolCallBody,
  toolsListBody,
  waitForLogs,
} from './helpers/http-harness.js';

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await closeAllApps();
});

function getJson(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) })
      );
    }).on('error', reject);
  });
}

describe('stateless MCP over POST /mcp (tracer)', () => {
  it('lets an SDK client list and call a factory-defined tool', async () => {
    const harness = await startApp();
    const client = new Client({ name: 'jest-client', version: '0.0.0' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${harness.baseUrl}/mcp`))
    );

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['demo_echo_items']);

    // The Client validates structuredContent against the tool's outputSchema.
    const result = await client.callTool({
      name: 'demo_echo_items',
      arguments: { items: ['a', 'b'] },
    });
    expect(result.structuredContent).toEqual({ items: ['a', 'b'], count: 2 });
    const text =
      (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('a');
  });

  it('initializes on protocol 2025-11-25 without issuing a session id', async () => {
    const harness = await startApp();
    const res = await postMcp(harness.baseUrl, initializeBody());
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const body = (await res.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe('2025-11-25');
  });

  it('serves /health with the package version and makes no outbound call', async () => {
    const harness = await startApp();
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      const { status, body } = await getJson(`${harness.baseUrl}/health`);
      expect(status).toBe(200);
      expect(body).toEqual({ status: 'ok', version: PACKAGE_VERSION });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('writes exactly one closed-set log line per POST and never logs arguments', async () => {
    const harness = await startApp();
    const canaryArgument = 'canary-argument-7c1d';
    await postMcp(harness.baseUrl, initializeBody());
    await postMcp(harness.baseUrl, toolsListBody(2));
    await postMcp(
      harness.baseUrl,
      toolCallBody('demo_echo_items', { items: [canaryArgument] }, 3)
    );

    const logs = await waitForLogs(harness, 3);
    expect(logs).toHaveLength(3);
    for (const line of logs) {
      expect(line.event).toBe('mcp_call');
      const { level: _level, message: _message, ...fields } = line;
      expect(Object.keys(fields).sort()).toEqual(
        [
          'error_type',
          'event',
          'http_status',
          'latency_ms',
          'mcp_client',
          'outcome',
          'protocol_version',
          'rpc_method',
          'tool',
        ].sort()
      );
    }
    expect(logs.map((line) => line.rpc_method)).toEqual([
      'initialize',
      'tools/list',
      'tools/call',
    ]);
    expect(logs[2]?.tool).toBe('demo_echo_items');
    expect(JSON.stringify(logs)).not.toContain(canaryArgument);
  });
});
