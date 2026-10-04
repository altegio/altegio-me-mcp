import { afterEach, describe, expect, it } from '@jest/globals';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import pino from 'pino';
import { z } from 'zod';
import {
  CANARY_SECRET,
  closeAllApps,
  initializeBody,
  postMcp,
  startApp,
  toolCallBody,
  toolsListBody,
  waitForLogs,
} from '../../__tests__/helpers/http-harness.js';
import { defineTool } from '../../tools/factory.js';
import { createCallLogMiddleware } from '../call-log.js';

const rawServers: HttpServer[] = [];

afterEach(async () => {
  await closeAllApps();
  await Promise.all(
    rawServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        })
    )
  );
});

type RawLine = Record<string, unknown>;

// The call-log middleware alone in front of a fixed responder, so the outcome
// rule can be checked against bodies the SDK never produces.
async function startRaw(
  responder: RequestHandler
): Promise<{ url: string; logs: RawLine[] }> {
  const logs: RawLine[] = [];
  const logger = pino(
    { base: null, timestamp: false, messageKey: 'message', level: 'info' },
    {
      write(chunk: string): void {
        logs.push(JSON.parse(chunk) as RawLine);
      },
    }
  );
  const app = express();
  app.post(
    '/mcp',
    createCallLogMiddleware(logger, new Set()),
    express.json(),
    responder
  );
  const server: HttpServer = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  rawServers.push(server);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, logs };
}

async function waitForRaw(logs: RawLine[], count: number): Promise<RawLine[]> {
  const deadline = Date.now() + 2000;
  while (logs.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return logs;
}

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const leakyTool = defineTool({
  name: 'demo_leak',
  title: 'Leak',
  description: 'Returns text that contains a secret.',
  annotations: readOnly,
  input: z.strictObject({}),
  output: z.strictObject({ note: z.string() }),
  render: (out) => `note: ${out.note}`,
  handler: () => Promise.resolve({ note: `token is ${CANARY_SECRET}` }),
});

const throwingTool = defineTool({
  name: 'demo_throw',
  title: 'Throw',
  description: 'Always fails with an internal error.',
  annotations: readOnly,
  input: z.strictObject({}),
  output: z.strictObject({ ok: z.boolean() }),
  render: () => 'unreachable',
  handler: () => Promise.reject(new TypeError('internal detail 42')),
});

interface ToolCallBody {
  result?: {
    content: { text: string }[];
    structuredContent?: unknown;
    isError?: boolean;
  };
}

describe('secret scrubbing at the result boundary', () => {
  it('keeps a canary token out of the HTTP response and the logs', async () => {
    const harness = await startApp({ tools: [leakyTool] });
    const res = await postMcp(harness.baseUrl, toolCallBody('demo_leak', {}));
    const text = await res.text();
    expect(text).toContain('[redacted]');
    expect(text).not.toContain(CANARY_SECRET);
    const logs = await waitForLogs(harness, 1);
    expect(JSON.stringify(logs)).not.toContain(CANARY_SECRET);
  });
});

describe('call log fields', () => {
  it('logs tool "unknown" for an unregistered tool name', async () => {
    const harness = await startApp();
    const requested = 'injected\nname-that-is-not-registered';
    await postMcp(harness.baseUrl, toolCallBody(requested, {}));
    const [line] = await waitForLogs(harness, 1);
    expect(line?.tool).toBe('unknown');
    expect(line?.outcome).toBe('protocol_error');
    expect(JSON.stringify(line)).not.toContain('injected');
  });

  it('logs a printable mcp_client of at most 100 characters', async () => {
    const harness = await startApp();
    const name = `bad\u0000\u001b[31m${'x'.repeat(300)}`;
    await postMcp(harness.baseUrl, initializeBody(name));
    const [line] = await waitForLogs(harness, 1);
    const client = String(line?.mcp_client);
    expect(client.length).toBeLessThanOrEqual(100);
    expect(client).toMatch(/^[\x20-\x7E]+$/);
  });

  it('logs protocol_version null for a garbage header', async () => {
    const harness = await startApp();
    await postMcp(harness.baseUrl, toolsListBody(), {
      'mcp-protocol-version': 'not-a-version',
    });
    const [line] = await waitForLogs(harness, 1);
    expect(line?.protocol_version).toBeNull();
  });

  it('logs the protocol version when the header is well formed', async () => {
    const harness = await startApp();
    await postMcp(harness.baseUrl, toolsListBody(), {
      'mcp-protocol-version': '2025-11-25',
    });
    const [line] = await waitForLogs(harness, 1);
    expect(line?.protocol_version).toBe('2025-11-25');
  });

  it('logs "other" for an unknown rpc method and "batch" for an array body', async () => {
    const harness = await startApp();
    await postMcp(harness.baseUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/list',
    });
    await postMcp(harness.baseUrl, [toolsListBody(1), toolsListBody(2)]);
    const logs = await waitForLogs(harness, 2);
    expect(logs.map((line) => line.rpc_method)).toEqual(['other', 'batch']);
  });

  it('logs a thrown TypeError as tool_error / TypeError without leaking its message', async () => {
    const harness = await startApp({ tools: [throwingTool] });
    const res = await postMcp(harness.baseUrl, toolCallBody('demo_throw', {}));
    const body = (await res.json()) as ToolCallBody;
    expect(body.result?.isError).toBe(true);
    const text = body.result?.content[0]?.text ?? '';
    expect(text).not.toContain('TypeError');
    expect(text).not.toContain('internal detail');
    const [line] = await waitForLogs(harness, 1);
    expect(line?.outcome).toBe('tool_error');
    expect(line?.error_type).toBe('TypeError');
    expect(line?.tool).toBe('demo_throw');
    expect(JSON.stringify(line)).not.toContain('internal detail');
  });

  it('logs outcome "aborted" once when the client disconnects mid-request', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const slowTool = defineTool({
      name: 'demo_slow',
      title: 'Slow',
      description: 'Waits until released.',
      annotations: readOnly,
      input: z.strictObject({}),
      output: z.strictObject({ done: z.boolean() }),
      render: () => 'done',
      handler: async () => {
        markStarted();
        await gate;
        return { done: true };
      },
    });
    const harness = await startApp({ tools: [slowTool] });
    const controller = new AbortController();
    const pending = postMcp(
      harness.baseUrl,
      toolCallBody('demo_slow', {}),
      {},
      controller.signal
    ).catch(() => undefined);

    await started;
    controller.abort();
    await pending;
    const logs = await waitForLogs(harness, 1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(logs).toHaveLength(1);
    expect(logs[0]?.outcome).toBe('aborted');
    expect(harness.logs).toHaveLength(1);
  });
});

describe('outcome from the JSON-RPC response body (WR-05)', () => {
  const PINO_WARN = 40;

  it('logs an unknown method answered with HTTP 200 as protocol_error at WARN', async () => {
    const harness = await startApp();
    const res = await postMcp(harness.baseUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'nope',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { error?: unknown }).error).toBeDefined();
    const [line] = await waitForLogs(harness, 1);
    expect(line?.http_status).toBe(200);
    expect(line?.outcome).toBe('protocol_error');
    expect(line?.level).toBe(PINO_WARN);
  });

  it('logs tools/call with params missing name as protocol_error', async () => {
    const harness = await startApp();
    const res = await postMcp(harness.baseUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { arguments: {} },
    });
    expect(res.status).toBe(200);
    const [line] = await waitForLogs(harness, 1);
    expect(line?.rpc_method).toBe('tools/call');
    expect(line?.outcome).toBe('protocol_error');
  });

  it('keeps tools/list, a successful tools/call and notifications/initialized ok', async () => {
    const harness = await startApp();
    await postMcp(harness.baseUrl, toolsListBody(1));
    await postMcp(
      harness.baseUrl,
      toolCallBody('demo_echo_items', { items: ['a'] }, 2)
    );
    const notified = await postMcp(harness.baseUrl, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(notified.status).toBe(202);
    const logs = await waitForLogs(harness, 3);
    expect(logs.map((line) => line.outcome)).toEqual(['ok', 'ok', 'ok']);
  });

  it('counts a JSON-RPC error and never logs its message', async () => {
    const canary = 'canary-error-message-5e2a';
    const raw = await startRaw((_req, res) => {
      res.status(200).json({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: canary },
      });
    });
    await postMcp(raw.url, toolsListBody(1));
    const logs = await waitForRaw(raw.logs, 1);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.outcome).toBe('protocol_error');
    expect(JSON.stringify(logs)).not.toContain(canary);
    const { level: _level, message: _message, ...fields } = logs[0] ?? {};
    expect(Object.keys(fields)).toHaveLength(9);
  });

  it('counts an array response that contains an error member', async () => {
    const raw = await startRaw((_req, res) => {
      res.status(200).json([
        { jsonrpc: '2.0', id: 1, result: {} },
        { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'x' } },
      ]);
    });
    await postMcp(raw.url, toolsListBody(1));
    const [line] = await waitForRaw(raw.logs, 1);
    expect(line?.outcome).toBe('protocol_error');
  });

  it('keeps ok for a body written in chunks that carries only a result', async () => {
    const raw = await startRaw((_req, res) => {
      res.status(200).set('content-type', 'application/json');
      res.write('{"jsonrpc":"2.0","id":1,');
      res.end(Buffer.from('"result":{"error":"inside result"}}'));
    });
    await postMcp(raw.url, toolsListBody(1));
    const [line] = await waitForRaw(raw.logs, 1);
    expect(line?.outcome).toBe('ok');
  });

  it('keeps ok for a non-JSON body and for a body that does not parse', async () => {
    const plain = await startRaw((_req, res) => {
      res.status(200).type('text/plain').send('{"error":{"code":1}}');
    });
    await postMcp(plain.url, toolsListBody(1));
    const broken = await startRaw((_req, res) => {
      res.status(200).type('application/json').send('{"error":');
    });
    await postMcp(broken.url, toolsListBody(1));
    const [plainLine] = await waitForRaw(plain.logs, 1);
    const [brokenLine] = await waitForRaw(broken.logs, 1);
    expect(plainLine?.outcome).toBe('ok');
    expect(brokenLine?.outcome).toBe('ok');
  });
});
