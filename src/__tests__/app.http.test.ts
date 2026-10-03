import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { get } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PACKAGE_VERSION } from '../util/package-metadata.js';
import { createApp } from '../app.js';
import {
  ALLOWED_ORIGIN,
  closeAllApps,
  echoItemsTool,
  initializeBody,
  namedEchoTool,
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

const NO_LEAK = [/^\s+at /m, /node_modules/, /\/src\//, /SyntaxError/];

function expectNoLeak(text: string): void {
  for (const pattern of NO_LEAK) {
    expect(text).not.toMatch(pattern);
  }
}

interface RpcResponse {
  result?: {
    tools?: { name: string }[];
    structuredContent?: { items: string[] };
  };
  error?: { code: number; message: string };
}

describe('HTTP transport contract', () => {
  it.each(['GET', 'DELETE'])(
    'answers %s /mcp with 405 and Allow: POST',
    async (method) => {
      const harness = await startApp();
      const res = await fetch(`${harness.baseUrl}/mcp`, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      const body = (await res.json()) as RpcResponse;
      expect(body.error?.code).toBe(-32000);
    }
  );

  it('answers a POST without both Accept types with 406', async () => {
    const harness = await startApp();
    const res = await postMcp(harness.baseUrl, toolsListBody(), {
      accept: 'application/json',
    });
    expect(res.status).toBe(406);
  });

  it('serves tools/list with no prior initialize', async () => {
    const harness = await startApp();
    const res = await postMcp(harness.baseUrl, toolsListBody());
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const body = (await res.json()) as RpcResponse;
    expect(body.result?.tools?.map((tool) => tool.name)).toEqual([
      'demo_echo_items',
    ]);
  });

  it('rejects MCP-Protocol-Version 2026-07-28 with 400 (SDK 1.x boundary, D-04)', async () => {
    const harness = await startApp();
    const res = await postMcp(harness.baseUrl, toolsListBody(), {
      'mcp-protocol-version': '2026-07-28',
    });
    expect(res.status).toBe(400);
  });

  it('accepts notifications/initialized with 202', async () => {
    const harness = await startApp();
    const res = await postMcp(harness.baseUrl, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(res.status).toBe(202);
  });
});

describe('safe error responses', () => {
  it('maps a malformed JSON body to 400 / -32700 with no stack, path or class name', async () => {
    const harness = await startApp();
    const res = await postMcp(harness.baseUrl, '{bad');
    expect(res.status).toBe(400);
    const text = await res.text();
    expect((JSON.parse(text) as RpcResponse).error?.code).toBe(-32700);
    expectNoLeak(text);
  });

  it('answers an empty JSON body with a JSON-RPC error and no stack text', async () => {
    const harness = await startApp();
    const res = await postMcp(harness.baseUrl, '');
    expect(res.status).toBeGreaterThanOrEqual(400);
    const text = await res.text();
    expect(typeof (JSON.parse(text) as RpcResponse).error?.code).toBe('number');
    expectNoLeak(text);
  });

  it('answers a body over 100kb with 413', async () => {
    const harness = await startApp();
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('demo_echo_items', { pad: 'x'.repeat(101 * 1024) })
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as RpcResponse).error?.code).toBe(-32000);
  });
});

describe('Origin guard (DNS rebinding)', () => {
  it('rejects a foreign Origin with 403 and still logs the request once', async () => {
    const harness = await startApp();
    const res = await postMcp(harness.baseUrl, toolsListBody(), {
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as RpcResponse).error?.message).toBe(
      'Forbidden origin'
    );
    const logs = await waitForLogs(harness, 1);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.http_status).toBe(403);
  });

  it('serves an allowed Origin and a request without Origin', async () => {
    const harness = await startApp();
    const allowed = await postMcp(harness.baseUrl, toolsListBody(), {
      origin: ALLOWED_ORIGIN,
    });
    expect(allowed.status).toBe(200);
    const absent = await postMcp(harness.baseUrl, toolsListBody());
    expect(absent.status).toBe(200);
  });

  it('allows loopback origins only when allowLoopbackOrigins is true', async () => {
    const closed = await startApp({ allowLoopbackOrigins: false });
    const blocked = await postMcp(closed.baseUrl, toolsListBody(), {
      origin: 'http://localhost:3000',
    });
    expect(blocked.status).toBe(403);

    const open = await startApp({ allowLoopbackOrigins: true });
    for (const origin of [
      'http://localhost:3000',
      'http://127.0.0.1:5173',
      'http://[::1]:3000',
    ]) {
      const res = await postMcp(open.baseUrl, toolsListBody(), { origin });
      expect(res.status).toBe(200);
    }
  });

  it('rejects an unparsable Origin', async () => {
    const harness = await startApp({ allowLoopbackOrigins: true });
    const res = await postMcp(harness.baseUrl, toolsListBody(), {
      origin: 'null',
    });
    expect(res.status).toBe(403);
  });
});

describe('independence and registry behaviour', () => {
  it('keeps 20 concurrent tools/call requests with the same JSON-RPC id independent', async () => {
    const harness = await startApp();
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        postMcp(
          harness.baseUrl,
          toolCallBody('demo_echo_items', { items: [`item-${index}`] }, 1)
        )
      )
    );
    const bodies = await Promise.all(
      responses.map((res) => res.json() as Promise<RpcResponse>)
    );
    bodies.forEach((body, index) => {
      expect(body.result?.structuredContent?.items).toEqual([`item-${index}`]);
    });
  });

  it('lists tools sorted by name whatever the registration order', async () => {
    const harness = await startApp({
      tools: [
        namedEchoTool('zeta_echo_items'),
        namedEchoTool('alpha_echo_items'),
      ],
    });
    const res = await postMcp(harness.baseUrl, toolsListBody());
    const body = (await res.json()) as RpcResponse;
    expect(body.result?.tools?.map((tool) => tool.name)).toEqual([
      'alpha_echo_items',
      'zeta_echo_items',
    ]);
  });

  it('returns an empty tools array for an empty registry', async () => {
    const harness = await startApp({ tools: [] });
    const res = await postMcp(harness.baseUrl, toolsListBody());
    expect(((await res.json()) as RpcResponse).result?.tools).toEqual([]);
  });

  it('throws when two tools share a name', () => {
    expect(() =>
      createApp({
        name: 'dup',
        version: '0.0.0',
        tools: [echoItemsTool, namedEchoTool('demo_echo_items')],
        toolDeps: undefined,
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
        secrets: [],
        allowedOrigins: [],
        allowLoopbackOrigins: false,
      })
    ).toThrow('Duplicate tool name: demo_echo_items');
  });
});
