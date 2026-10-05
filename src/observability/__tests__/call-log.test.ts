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
import type { ProxyAuthReason } from '../../security/proxy-auth.js';
import { defineTool } from '../../tools/factory.js';
import { createCallLogMiddleware, getCallRecord } from '../call-log.js';

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
// rule can be checked against bodies the SDK never produces. `settled(n)`
// resolves once n responses are fully closed on the server side, which is
// after the call log has seen them, so a test can tell "not written" from
// "not written yet".
async function startRaw(
  responder: RequestHandler,
  options?: { now?: () => number }
): Promise<{
  url: string;
  logs: RawLine[];
  settled: (count: number) => Promise<void>;
}> {
  const logs: RawLine[] = [];
  const logger = pino(
    { base: null, timestamp: false, messageKey: 'message', level: 'info' },
    {
      write(chunk: string): void {
        logs.push(JSON.parse(chunk) as RawLine);
      },
    }
  );
  let closed = 0;
  const countClosed: RequestHandler = (_req, res, next) => {
    // Registered after the call log's own listeners, so they ran first.
    res.once('close', () => {
      closed += 1;
    });
    next();
  };
  const app = express();
  app.post(
    '/mcp',
    createCallLogMiddleware(logger, new Set(), options),
    countClosed,
    express.json(),
    responder
  );
  const server: HttpServer = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  rawServers.push(server);
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    logs,
    settled: async (count: number): Promise<void> => {
      const deadline = Date.now() + 2000;
      while (closed < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(closed).toBeGreaterThanOrEqual(count);
    },
  };
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

  it('logs a closed client category without arbitrary client text', async () => {
    const harness = await startApp();
    const name = `bad\u0000\u001b[31m${'x'.repeat(300)}`;
    await postMcp(harness.baseUrl, initializeBody(name));
    const [line] = await waitForLogs(harness, 1);
    const client = String(line?.mcp_client);
    expect(client).toBe('other');
    expect(JSON.stringify(line)).not.toContain(name);
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
    expect(Object.keys(fields)).toHaveLength(17);
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

const NEW_FIELDS = [
  'auth_reason',
  'limited_by',
  'upstream_kind',
  'origin_host',
  'forwarded_for_count',
  'suppressed',
] as const;

describe('call log field set for the proxy check and the later limits (OPS-03)', () => {
  it('writes auth_reason, limited_by, upstream_kind, origin_host, forwarded_for_count and suppressed on every line, null by default', async () => {
    const harness = await startApp();
    await postMcp(harness.baseUrl, toolsListBody(1));
    await postMcp(
      harness.baseUrl,
      toolCallBody('demo_echo_items', { items: ['a'] }, 2)
    );
    const logs = await waitForLogs(harness, 2);
    expect(logs).toHaveLength(2);
    for (const line of logs) {
      for (const key of NEW_FIELDS) {
        expect(line).toHaveProperty(key, null);
      }
    }
  });

  it('writes what a later plan puts on the call record, and nothing else', async () => {
    const raw = await startRaw((_req, res) => {
      const record = getCallRecord(res);
      record.limited_by = 'gate';
      record.upstream_kind = 'rate_limited';
      record.origin_host = 'mcp.example.test';
      record.forwarded_for_count = 2;
      res.status(200).json({ jsonrpc: '2.0', id: 1, result: {} });
    });
    await postMcp(raw.url, toolsListBody(1));
    const [line] = await waitForRaw(raw.logs, 1);
    expect(line).toMatchObject({
      auth_reason: null,
      limited_by: 'gate',
      upstream_kind: 'rate_limited',
      origin_host: 'mcp.example.test',
      forwarded_for_count: 2,
      suppressed: null,
    });
  });
});

describe('throttled proxy-auth rejection lines (T-03-14)', () => {
  const rejectWith =
    (reason: ProxyAuthReason): RequestHandler =>
    (_req, res) => {
      getCallRecord(res).auth_reason = reason;
      res.status(401).json({ error: 'proxy_auth_required' });
    };

  function clock(startMs = 1_700_000_000_000): {
    now: () => number;
    advance: (ms: number) => void;
  } {
    let current = startMs;
    return {
      now: () => current,
      advance: (ms) => {
        current += ms;
      },
    };
  }

  it('writes 1 line for 5 rejections inside one second and 4 as suppressed on the next written one', async () => {
    const time = clock();
    const raw = await startRaw(rejectWith('missing'), { now: time.now });
    for (let call = 0; call < 5; call += 1) {
      await postMcp(raw.url, toolsListBody(call));
    }
    await raw.settled(5);
    expect(raw.logs).toHaveLength(1);
    expect(raw.logs[0]).toMatchObject({
      event: 'mcp_call',
      auth_reason: 'missing',
      http_status: 401,
      outcome: 'http_error',
      suppressed: 0,
    });

    time.advance(1000);
    await postMcp(raw.url, toolsListBody(6));
    await raw.settled(6);
    expect(raw.logs).toHaveLength(2);
    expect(raw.logs[1]).toMatchObject({
      auth_reason: 'missing',
      suppressed: 4,
    });

    // The count starts again after a written line.
    await postMcp(raw.url, toolsListBody(7));
    time.advance(1000);
    await postMcp(raw.url, toolsListBody(8));
    await raw.settled(8);
    expect(raw.logs).toHaveLength(3);
    expect(raw.logs[2]).toMatchObject({ suppressed: 1 });
  });

  it('suppresses at 999 ms and writes at 1000 ms', async () => {
    const time = clock();
    const raw = await startRaw(rejectWith('bad_signature'), {
      now: time.now,
    });
    await postMcp(raw.url, toolsListBody(1));
    time.advance(999);
    await postMcp(raw.url, toolsListBody(2));
    await raw.settled(2);
    expect(raw.logs).toHaveLength(1);
    time.advance(1);
    await postMcp(raw.url, toolsListBody(3));
    await raw.settled(3);
    expect(raw.logs).toHaveLength(2);
    expect(raw.logs[1]).toMatchObject({ suppressed: 1 });
  });

  it('throttles every reason together, as one stream', async () => {
    const time = clock();
    const reasons: ProxyAuthReason[] = [
      'missing',
      'malformed',
      'stale',
      'bad_signature',
    ];
    let next = 0;
    const raw = await startRaw(
      (req, res, nextHandler) => {
        const reason = reasons[next % reasons.length] ?? 'missing';
        next += 1;
        rejectWith(reason)(req, res, nextHandler);
      },
      { now: time.now }
    );
    for (let call = 0; call < 4; call += 1) {
      await postMcp(raw.url, toolsListBody(call));
    }
    await raw.settled(4);
    expect(raw.logs).toHaveLength(1);
    expect(raw.logs[0]).toMatchObject({ auth_reason: 'missing' });
    time.advance(1000);
    await postMcp(raw.url, toolsListBody(5));
    await raw.settled(5);
    // The fifth request starts the cycle again, so it is 'missing' once more;
    // the three suppressed ones were malformed, stale and bad_signature.
    expect(raw.logs[1]).toMatchObject({
      auth_reason: 'missing',
      suppressed: 3,
    });
  });

  it('never throttles a line without auth_reason and always gives it suppressed null', async () => {
    const time = clock();
    let rejectNext = true;
    const raw = await startRaw(
      (req, res, nextHandler) => {
        if (rejectNext) {
          rejectWith('missing')(req, res, nextHandler);
          return;
        }
        res.status(200).json({ jsonrpc: '2.0', id: 1, result: {} });
      },
      { now: time.now }
    );
    await postMcp(raw.url, toolsListBody(1));
    await postMcp(raw.url, toolsListBody(2));
    rejectNext = false;
    for (let call = 3; call < 6; call += 1) {
      await postMcp(raw.url, toolsListBody(call));
    }
    await raw.settled(5);
    expect(raw.logs).toHaveLength(4);
    expect(raw.logs.map((line) => line.suppressed)).toEqual([
      0,
      null,
      null,
      null,
    ]);
    expect(raw.logs.map((line) => line.auth_reason)).toEqual([
      'missing',
      null,
      null,
      null,
    ]);

    // The suppressed rejection is carried to the next written rejection.
    time.advance(1000);
    rejectNext = true;
    await postMcp(raw.url, toolsListBody(6));
    await raw.settled(6);
    expect(raw.logs[4]).toMatchObject({
      auth_reason: 'missing',
      suppressed: 1,
    });
  });

  it('does not stay silent when the clock steps backwards', async () => {
    const time = clock(10_000_000);
    const raw = await startRaw(rejectWith('missing'), { now: time.now });
    await postMcp(raw.url, toolsListBody(1));
    time.advance(-5_000_000);
    await postMcp(raw.url, toolsListBody(2));
    await raw.settled(2);
    expect(raw.logs).toHaveLength(2);
  });

  it('puts no header value, key or address on a rejection line', async () => {
    const secretHeader = 'v1:1700000000:' + 'ab'.repeat(32);
    const raw = await startRaw(rejectWith('malformed'));
    await postMcp(raw.url, toolsListBody(1), {
      'x-mcp-proxy-auth': secretHeader,
      'x-mcp-auth-client-ip': '203.0.113.77',
      'x-forwarded-for': '198.51.100.9',
    });
    const logs = await waitForRaw(raw.logs, 1);
    const text = JSON.stringify(logs);
    expect(text).not.toContain(secretHeader);
    expect(text).not.toContain('abab');
    expect(text).not.toContain('203.0.113.77');
    expect(text).not.toContain('198.51.100.9');
    expect(text).not.toContain('127.0.0.1');
  });
});
