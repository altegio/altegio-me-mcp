import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { get } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PACKAGE_VERSION } from '../util/package-metadata.js';
import { PROXY_AUTH_HEADER } from '../security/proxy-auth.js';
import { allowedOriginsFor, createApp } from '../app.js';
import { createSharedEgressList } from '../security/client-ip.js';
import { createEdgeLimiter } from '../security/edge-limiter.js';
import { defineTool } from '../tools/factory.js';
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
import { signProxyRequest } from './helpers/sign-request.js';

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
      expect(body).toEqual({
        status: 'ok',
        service: 'altegio-me-mcp',
        version: PACKAGE_VERSION,
        commit: null,
      });
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
      expect(line.service).toBe('altegio-me-mcp');
      expect(line.version).toBe(PACKAGE_VERSION);
      expect(line.route).toBe('/mcp');
      expect(line.request_id).toMatch(/^[a-f0-9-]{36}$/);
      const { level: _level, message: _message, ...fields } = line;
      expect(Object.keys(fields).sort()).toEqual(
        [
          'service',
          'version',
          'commit',
          'request_id',
          'route',
          'auth_reason',
          'error_type',
          'event',
          'forwarded_for_count',
          'http_status',
          'latency_ms',
          'limited_by',
          'mcp_client',
          'origin_host',
          'outcome',
          'protocol_version',
          'rpc_method',
          'suppressed',
          'tool',
          'upstream_kind',
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

describe('JSON-RPC batch rejection (WR-01)', () => {
  it('answers an array body with 400 / -32600, runs no tool and logs one batch line', async () => {
    let invocations = 0;
    const countingTool = defineTool({
      name: 'demo_count',
      title: 'Count',
      description: 'Counts its invocations.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      input: z.strictObject({}),
      output: z.strictObject({ ok: z.boolean() }),
      render: () => 'ok',
      handler: () => {
        invocations += 1;
        return Promise.resolve({ ok: true });
      },
    });
    const harness = await startApp({ tools: [countingTool] });
    const res = await postMcp(harness.baseUrl, [
      toolsListBody(1),
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      toolCallBody('demo_count', {}, 3),
    ]);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect((JSON.parse(text) as RpcResponse).error).toEqual({
      code: -32600,
      message: 'Batch requests are not supported',
    });
    expectNoLeak(text);
    expect(invocations).toBe(0);
    const logs = await waitForLogs(harness, 1);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.rpc_method).toBe('batch');
    expect(logs[0]?.outcome).toBe('protocol_error');
  });
});

describe('client-caused body-parser errors stay 4xx (WR-02)', () => {
  const PING = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
  const PINO_WARN = 40;

  it.each([
    ['Content-Encoding br on a plain body', { 'content-encoding': 'br' }, null],
    [
      'an unsupported Content-Encoding',
      { 'content-encoding': 'x-unknown' },
      415,
    ],
    [
      'an unsupported charset',
      { 'content-type': 'application/json; charset=koi8-r' },
      415,
    ],
  ] as const)(
    'answers %s with a 4xx / -32600 and a WARN log line',
    async (_label, headers, expectedStatus) => {
      const harness = await startApp();
      const res = await postMcp(harness.baseUrl, PING, { ...headers });
      if (expectedStatus === null) {
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
      } else {
        expect(res.status).toBe(expectedStatus);
      }
      const text = await res.text();
      expect((JSON.parse(text) as RpcResponse).error).toEqual({
        code: -32600,
        message: 'Invalid request',
      });
      expectNoLeak(text);
      const logs = await waitForLogs(harness, 1);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.level).toBe(PINO_WARN);
      expect(logs[0]?.http_status).toBe(res.status);
    }
  );
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

describe('proxy-origin signature on POST /mcp (OPS-03, D-04)', () => {
  const KEY = 'http-test-key-0123456789abcdef0123456789abcdef';
  const REFUSAL = {
    error: 'proxy_auth_required',
    error_description: 'requests must come through mcp-proxy',
  };

  function signed(
    headers: Record<string, string> = {}
  ): Record<string, string> {
    return {
      ...headers,
      [PROXY_AUTH_HEADER]: signProxyRequest({
        key: KEY,
        method: 'POST',
        path: '/mcp',
        headers,
      }),
    };
  }

  it('serves a signed tools/list', async () => {
    const harness = await startApp({ proxyAuth: { keys: () => [KEY] } });
    const res = await postMcp(harness.baseUrl, toolsListBody(), signed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResponse;
    expect(body.result?.tools?.map((tool) => tool.name)).toEqual([
      'demo_echo_items',
    ]);
  });

  it('refuses an unsigned tools/list with 401 and the exact body', async () => {
    const harness = await startApp({ proxyAuth: { keys: () => [KEY] } });
    const res = await postMcp(harness.baseUrl, toolsListBody());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(REFUSAL);
  });

  it('refuses a signature made with another key, a stale one and a malformed one', async () => {
    const now = Date.now();
    const harness = await startApp({
      proxyAuth: { keys: () => [KEY], now: () => now },
    });
    const wrongKey = signProxyRequest({
      key: 'another-key-0123456789abcdef0123456789abcdef',
      method: 'POST',
      path: '/mcp',
      nowMs: now,
    });
    const stale = signProxyRequest({
      key: KEY,
      method: 'POST',
      path: '/mcp',
      nowMs: now - 301_000,
    });
    for (const header of [wrongKey, stale, 'nonsense']) {
      const res = await postMcp(harness.baseUrl, toolsListBody(), {
        [PROXY_AUTH_HEADER]: header,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(REFUSAL);
    }
  });

  it('refuses before the body is parsed', async () => {
    const harness = await startApp({ proxyAuth: { keys: () => [KEY] } });
    const res = await postMcp(harness.baseUrl, '{ not json');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(REFUSAL);
  });

  it('covers the identity headers the proxy adds', async () => {
    const harness = await startApp({ proxyAuth: { keys: () => [KEY] } });
    const identity = { 'x-mcp-auth-client-ip': '203.0.113.7' };
    const header = signed(identity)[PROXY_AUTH_HEADER] ?? '';
    const ok = await postMcp(harness.baseUrl, toolsListBody(), {
      ...identity,
      [PROXY_AUTH_HEADER]: header,
    });
    expect(ok.status).toBe(200);
    const tampered = await postMcp(harness.baseUrl, toolsListBody(), {
      'x-mcp-auth-client-ip': '203.0.113.8',
      [PROXY_AUTH_HEADER]: header,
    });
    expect(tampered.status).toBe(401);
  });

  it('refuses everything when the key list is empty, never failing open', async () => {
    const harness = await startApp({ proxyAuth: { keys: () => [] } });
    expect((await postMcp(harness.baseUrl, toolsListBody())).status).toBe(401);
    expect(
      (await postMcp(harness.baseUrl, toolsListBody(), signed())).status
    ).toBe(401);
  });

  // Changes the last hex digit of a signature so it can no longer verify. The
  // digit is flipped, not set to a fixed value: setting it to '0' left the
  // signature intact one time in sixteen and made the refusal tests flaky.
  function tamper(header: string): string {
    return `${header.slice(0, -1)}${header.endsWith('0') ? '1' : '0'}`;
  }

  it('refuses a signature with its last digit changed, whatever that digit is', async () => {
    let nowMs = 1_700_000_000_000;
    const harness = await startApp({
      proxyAuth: { keys: () => [KEY], now: () => nowMs },
    });
    let endingInZero = 0;
    for (let second = 0; second < 64; second += 1) {
      nowMs = 1_700_000_000_000 + second * 1000;
      const header = signProxyRequest({
        key: KEY,
        method: 'POST',
        path: '/mcp',
        nowMs,
      });
      if (header.endsWith('0')) endingInZero += 1;
      const res = await postMcp(harness.baseUrl, toolsListBody(), {
        [PROXY_AUTH_HEADER]: tamper(header),
      });
      expect(res.status).toBe(401);
    }
    // The fixed clock makes this deterministic: the loop does cover the case
    // that used to slip through.
    expect(endingInZero).toBeGreaterThan(0);
  });

  it('logs a refused request once, with no header value and no key', async () => {
    const harness = await startApp({ proxyAuth: { keys: () => [KEY] } });
    const header = signed()[PROXY_AUTH_HEADER] ?? '';
    await postMcp(harness.baseUrl, toolsListBody(), {
      [PROXY_AUTH_HEADER]: tamper(header),
    });
    const logs = await waitForLogs(harness, 1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: 'mcp_call',
      http_status: 401,
      outcome: 'http_error',
      auth_reason: 'bad_signature',
    });
    const text = JSON.stringify(logs);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(header.slice(0, -1));
  });

  it('writes an mcp_call line with auth_reason missing and status 401 for an unsigned POST, with all six new fields', async () => {
    const harness = await startApp({ proxyAuth: { keys: () => [KEY] } });
    const res = await postMcp(harness.baseUrl, toolsListBody(), {
      'x-mcp-auth-client-ip': '203.0.113.7',
    });
    expect(res.status).toBe(401);
    const logs = await waitForLogs(harness, 1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: 'mcp_call',
      http_status: 401,
      outcome: 'http_error',
      auth_reason: 'missing',
      limited_by: null,
      upstream_kind: null,
      origin_host: null,
      forwarded_for_count: null,
      suppressed: 0,
    });
    const text = JSON.stringify(logs);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('203.0.113.7');
    expect(text).not.toContain(PROXY_AUTH_HEADER);
  });

  it.each([
    ['malformed', (): string => 'nonsense-value-8d3f', 'nonsense-value-8d3f'],
    [
      'stale',
      (): string =>
        signProxyRequest({
          key: KEY,
          method: 'POST',
          path: '/mcp',
          nowMs: Date.now() - 301_000,
        }),
      null,
    ],
    [
      'bad_signature',
      (): string => tamper(signed()[PROXY_AUTH_HEADER] ?? ''),
      null,
    ],
  ])(
    'records auth_reason %s on the refusal line',
    async (reason, headerValue, literal) => {
      const harness = await startApp({ proxyAuth: { keys: () => [KEY] } });
      const header = headerValue();
      const res = await postMcp(harness.baseUrl, toolsListBody(), {
        [PROXY_AUTH_HEADER]: header,
      });
      expect(res.status).toBe(401);
      const logs = await waitForLogs(harness, 1);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.auth_reason).toBe(reason);
      const text = JSON.stringify(logs);
      expect(text).not.toContain(header);
      if (literal !== null) expect(text).not.toContain(literal);
    }
  );

  it('leaves auth_reason null on the line of a served signed request', async () => {
    const harness = await startApp({ proxyAuth: { keys: () => [KEY] } });
    const res = await postMcp(harness.baseUrl, toolsListBody(), signed());
    expect(res.status).toBe(200);
    const logs = await waitForLogs(harness, 1);
    expect(logs[0]).toMatchObject({ auth_reason: null, suppressed: null });
  });

  it('leaves /health open', async () => {
    const harness = await startApp({
      proxyAuth: { keys: () => [KEY] },
      commit: '0123abc',
    });
    const { status, body } = await getJson(`${harness.baseUrl}/health`);
    expect(status).toBe(200);
    expect(body).toEqual({
      status: 'ok',
      service: 'altegio-me-mcp',
      version: PACKAGE_VERSION,
      commit: '0123abc',
    });
  });
});

describe('secrets as a function, evaluated once per request (OPS-04, SEC-03)', () => {
  const OLD_SECRET = 'rotated-out-partner-token-0001';
  const NEW_SECRET = 'rotated-in-partner-token-0002';

  async function echoed(baseUrl: string, item: string): Promise<string> {
    const response = await postMcp(
      baseUrl,
      toolCallBody('demo_echo_items', { items: [item] })
    );
    expect(response.status).toBe(200);
    return response.text();
  }

  it('redacts what the list holds at the time of each request', async () => {
    let current: readonly string[] = [OLD_SECRET];
    const app = await startApp({ secrets: () => current });

    const first = await echoed(app.baseUrl, OLD_SECRET);
    expect(first).not.toContain(OLD_SECRET);
    expect(first).toContain('[redacted]');

    // A rotation: the new token is not known yet, then it is, with the old one.
    expect(await echoed(app.baseUrl, NEW_SECRET)).toContain(NEW_SECRET);
    current = [NEW_SECRET, OLD_SECRET];
    const rotated = await echoed(
      app.baseUrl,
      `${NEW_SECRET} then ${OLD_SECRET}`
    );
    expect(rotated).not.toContain(NEW_SECRET);
    expect(rotated).not.toContain(OLD_SECRET);
  });

  it('evaluates the function once per POST, not once at startup', async () => {
    const secrets = jest.fn((): readonly string[] => [OLD_SECRET]);
    const app = await startApp({ secrets });
    expect(secrets).not.toHaveBeenCalled();

    await postMcp(app.baseUrl, toolsListBody());
    await postMcp(app.baseUrl, toolCallBody('demo_echo_items', { items: [] }));

    expect(secrets).toHaveBeenCalledTimes(2);
  });

  it('still takes a plain array', async () => {
    const app = await startApp({ secrets: [OLD_SECRET] });
    const body = await echoed(app.baseUrl, OLD_SECRET);
    expect(body).not.toContain(OLD_SECRET);
  });
});

describe('edge limiter on POST /mcp (OPS-06)', () => {
  const KEY = 'edge-test-key-0123456789abcdef0123456789abcdef';
  const FIXED_NOW = 1_700_000_000_000;
  const CLIENT = '203.0.113.7';
  const XFF_ADDRESSES = ['198.51.100.9', '34.1.1.1'];

  function edgeFor(proxyAuthOn: boolean, trustedHops = 1) {
    return {
      limiter: createEdgeLimiter({ now: () => FIXED_NOW }),
      identity: {
        trustedHops,
        proxyAuthOn,
        sharedEgress: createSharedEgressList(['160.79.104.0/21']),
      },
    };
  }

  function signed(
    headers: Record<string, string> = {}
  ): Record<string, string> {
    return {
      ...headers,
      [PROXY_AUTH_HEADER]: signProxyRequest({
        key: KEY,
        method: 'POST',
        path: '/mcp',
        headers,
      }),
    };
  }

  async function sendMany(
    baseUrl: string,
    headersFor: (index: number) => Record<string, string>,
    count: number
  ): Promise<Response[]> {
    const responses: Response[] = [];
    for (let index = 0; index < count; index += 1) {
      const res = await postMcp(baseUrl, toolsListBody(), headersFor(index));
      await res.text();
      responses.push(res);
    }
    return responses;
  }

  it('answers the 41st signed POST from one address with 429, Retry-After and the JSON-RPC body', async () => {
    const harness = await startApp({
      proxyAuth: { keys: () => [KEY] },
      edge: edgeFor(true),
    });
    const headers = signed({ 'x-mcp-auth-client-ip': CLIENT });
    const responses = await sendMany(harness.baseUrl, () => headers, 40);
    expect(responses.every((res) => res.status === 200)).toBe(true);

    const limited = await postMcp(harness.baseUrl, toolsListBody(), headers);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
    expect(await limited.json()).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message:
          'Too many requests. Next: wait 1 seconds, then repeat the request.',
      },
      id: null,
    });
    const logs = await waitForLogs(harness, 41);
    expect(logs.at(-1)?.limited_by).toBe('ip');
    expect(logs.at(-1)?.http_status).toBe(429);
  });

  it('does not limit 41 addresses inside 160.79.104.0/21, one pool', async () => {
    const harness = await startApp({
      proxyAuth: { keys: () => [KEY] },
      edge: edgeFor(true),
    });
    const responses = await sendMany(
      harness.baseUrl,
      (index) =>
        signed({
          'x-mcp-auth-client-ip': `160.79.${String(104 + (index % 8))}.${String(index + 1)}`,
        }),
      41
    );
    expect(responses.map((res) => res.status)).toEqual(
      Array<number>(41).fill(200)
    );
    const logs = await waitForLogs(harness, 41);
    expect(logs.every((line) => line.limited_by === null)).toBe(true);
  });

  it('refuses an unsigned request with a forged client address before the limiter runs', async () => {
    const reached = jest.fn();
    const harness = await startApp({
      proxyAuth: { keys: () => [KEY] },
      edge: {
        ...edgeFor(true),
        limiter: (_req, _res, next) => {
          reached();
          next();
        },
      },
    });
    const res = await postMcp(harness.baseUrl, toolsListBody(), {
      'x-mcp-auth-client-ip': CLIENT,
    });
    expect(res.status).toBe(401);
    expect(reached).not.toHaveBeenCalled();
  });

  it('limits a signed request that names no address under the single key unknown', async () => {
    const harness = await startApp({
      proxyAuth: { keys: () => [KEY] },
      edge: edgeFor(true),
    });
    const responses = await sendMany(harness.baseUrl, () => signed(), 41);
    expect(responses.slice(0, 40).every((res) => res.status === 200)).toBe(
      true
    );
    expect(responses[40]?.status).toBe(429);
  });

  it('with PROXY_AUTH off keys on the right-counted X-Forwarded-For entry and ignores a forged signed header', async () => {
    const harness = await startApp({ edge: edgeFor(false) });
    const responses = await sendMany(
      harness.baseUrl,
      (index) => ({
        'x-forwarded-for': `${String(index + 1)}.2.3.4, ${CLIENT}, 34.1.1.1`,
        'x-mcp-auth-client-ip': `198.51.100.${String(index + 1)}`,
      }),
      41
    );
    expect(responses[39]?.status).toBe(200);
    expect(responses[40]?.status).toBe(429);
  });

  it('records forwarded_for_count and writes no address to any log line', async () => {
    const harness = await startApp({
      proxyAuth: { keys: () => [KEY] },
      edge: edgeFor(true),
    });
    const withForwarded = signed({ 'x-mcp-auth-client-ip': CLIENT });
    for (let index = 0; index < 41; index += 1) {
      const res = await postMcp(harness.baseUrl, toolsListBody(), {
        ...withForwarded,
        'x-forwarded-for': `1.2.3.4, ${XFF_ADDRESSES.join(', ')}`,
      });
      await res.text();
    }
    const poolRes = await postMcp(
      harness.baseUrl,
      toolsListBody(),
      signed({ 'x-mcp-auth-client-ip': '160.79.104.9' })
    );
    await poolRes.text();

    const logs = await waitForLogs(harness, 42);
    expect(logs).toHaveLength(42);
    expect(
      logs.slice(0, 41).every((line) => line.forwarded_for_count === 3)
    ).toBe(true);
    expect(logs[41]?.forwarded_for_count).toBeNull();
    expect(logs.some((line) => line.limited_by === 'ip')).toBe(true);
    const text = JSON.stringify(logs);
    for (const address of [
      CLIENT,
      '1.2.3.4',
      '160.79.104.9',
      ...XFF_ADDRESSES,
    ]) {
      expect(text).not.toContain(address);
    }
  });
});

describe('Origin allow-list for the claude.ai connector (OPS-08)', () => {
  const PUBLIC_BASE_URL = 'https://mcp.alteg.io/me';
  const EXTRA = ['https://claude.ai', 'https://claude.com'];

  it('builds the list from the PUBLIC_BASE_URL origin and the extra origins', () => {
    expect(allowedOriginsFor(PUBLIC_BASE_URL, EXTRA)).toEqual([
      'https://mcp.alteg.io',
      'https://claude.ai',
      'https://claude.com',
    ]);
    expect(allowedOriginsFor('https://claude.ai/x', EXTRA)).toEqual([
      'https://claude.ai',
      'https://claude.com',
    ]);
  });

  it('serves claude.ai, claude.com, the public origin and a request without Origin', async () => {
    const harness = await startApp({
      allowedOrigins: allowedOriginsFor(PUBLIC_BASE_URL, EXTRA),
    });
    for (const origin of [
      'https://claude.ai',
      'https://claude.com',
      'https://mcp.alteg.io',
    ]) {
      const res = await postMcp(harness.baseUrl, toolsListBody(), { origin });
      expect(res.status).toBe(200);
    }
    expect((await postMcp(harness.baseUrl, toolsListBody())).status).toBe(200);
    const logs = await waitForLogs(harness, 4);
    expect(logs.every((line) => line.origin_host === null)).toBe(true);
  });

  it('refuses another origin with 403 and names its host in the log line', async () => {
    const harness = await startApp({
      allowedOrigins: allowedOriginsFor(PUBLIC_BASE_URL, EXTRA),
    });
    const res = await postMcp(harness.baseUrl, toolsListBody(), {
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    const logs = await waitForLogs(harness, 1);
    expect(logs[0]?.http_status).toBe(403);
    expect(logs[0]?.origin_host).toBe('untrusted');
  });

  it('cuts a long host at 100 characters and drops characters outside printable ASCII', async () => {
    const harness = await startApp({
      allowedOrigins: allowedOriginsFor(PUBLIC_BASE_URL, EXTRA),
    });
    await postMcp(harness.baseUrl, toolsListBody(), {
      origin: `https://${'a'.repeat(150)}.example`,
    });
    await postMcp(harness.baseUrl, toolsListBody(), {
      origin: 'bad\u00e9origin\u00ffvalue',
    });
    const logs = await waitForLogs(harness, 2);
    expect(logs[0]?.origin_host).toBe('untrusted');
    expect(logs[1]?.origin_host).toBe('untrusted');
  });
});

describe('client key into the tool context (IN-06)', () => {
  const KEY = 'clientkey-test-key-0123456789abcdef0123456789abcdef';
  const CLIENT = '203.0.113.7';

  const keyProbeTool = defineTool({
    name: 'demo_client_key',
    title: 'Client key probe',
    description: 'Reports whether the call carries a gate key.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    input: z.strictObject({}),
    output: z.strictObject({
      keyed: z.boolean(),
      isThisAddress: z.boolean(),
    }),
    render: (out) => `keyed=${String(out.keyed)}`,
    handler: ({ ctx }) =>
      Promise.resolve({
        keyed: ctx.clientKey !== null,
        isThisAddress: ctx.clientKey === `ip:${CLIENT}`,
      }),
  });

  function edge() {
    return {
      limiter: createEdgeLimiter(),
      identity: {
        trustedHops: 1,
        proxyAuthOn: true,
        sharedEgress: createSharedEgressList(['160.79.104.0/21']),
      },
    };
  }

  function signedFor(address: string): Record<string, string> {
    const headers = { 'x-mcp-auth-client-ip': address };
    return {
      ...headers,
      [PROXY_AUTH_HEADER]: signProxyRequest({
        key: KEY,
        method: 'POST',
        path: '/mcp',
        headers,
      }),
    };
  }

  async function probe(
    baseUrl: string,
    headers: Record<string, string>
  ): Promise<{ keyed: boolean; isThisAddress: boolean }> {
    const res = await postMcp(
      baseUrl,
      toolCallBody('demo_client_key', {}),
      headers
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { structuredContent: { keyed: boolean; isThisAddress: boolean } };
    };
    return body.result.structuredContent;
  }

  it('passes ip:<address> for a caller outside the pool, nothing for the pool, nothing without the edge', async () => {
    const harness = await startApp({
      tools: [keyProbeTool],
      proxyAuth: { keys: () => [KEY] },
      edge: edge(),
    });
    expect(await probe(harness.baseUrl, signedFor(CLIENT))).toEqual({
      keyed: true,
      isThisAddress: true,
    });
    expect(await probe(harness.baseUrl, signedFor('160.79.104.9'))).toEqual({
      keyed: false,
      isThisAddress: false,
    });

    const bare = await startApp({ tools: [keyProbeTool] });
    expect(await probe(bare.baseUrl, {})).toEqual({
      keyed: false,
      isThisAddress: false,
    });
    const text = JSON.stringify([...harness.logs, ...bare.logs]);
    expect(text).not.toContain(CLIENT);
    expect(text).not.toContain('160.79.104.9');
  });
});
