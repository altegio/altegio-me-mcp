import { afterEach, describe, expect, it } from '@jest/globals';
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

afterEach(closeAllApps);

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
