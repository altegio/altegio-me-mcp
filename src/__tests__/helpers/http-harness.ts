import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { z } from 'zod';
import { createApp, type AppDeps } from '../../app.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../../util/package-metadata.js';
import { defineTool, type DefinedTool } from '../../tools/factory.js';
import type { PartnerTokenValidator } from '../../security/partner-token.js';

// Shared by the HTTP-level tests: starts createApp on an ephemeral port with an
// in-memory log destination, and closes everything after each test so Jest exits.

export const CANARY_SECRET = 'canary-secret-token-0001';
export const ALLOWED_ORIGIN = 'http://localhost:8080';

/** A partner token the stub validator accepts. */
export const PARTNER_TOKEN = 'partner-token-valid-0001';
/** A partner token whose check cannot be completed (Altegio down). */
export const PARTNER_TOKEN_UNCHECKABLE = 'partner-token-uncheckable-0001';

/** Accepts PARTNER_TOKEN only; counts its checks. */
export function stubPartnerValidator(): PartnerTokenValidator & {
  checked: string[];
} {
  const checked: string[] = [];
  return {
    checked,
    validate(token: string) {
      checked.push(token);
      if (token === PARTNER_TOKEN) return Promise.resolve('valid');
      if (token === PARTNER_TOKEN_UNCHECKABLE) {
        return Promise.resolve('unavailable');
      }
      return Promise.resolve('invalid');
    },
  };
}

export type LogLine = Record<string, unknown>;

export interface Harness {
  baseUrl: string;
  logs: LogLine[];
  close(): Promise<void>;
}

export function namedEchoTool(name: string): DefinedTool<unknown> {
  return defineTool({
    name,
    title: `Echo ${name}`,
    description: 'Returns the items it receives, with their count.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    input: z.strictObject({ items: z.array(z.string()).max(10).default([]) }),
    output: z.strictObject({
      items: z.array(z.string()),
      count: z.number().int(),
    }),
    render: (out) => `Items (${out.count}): ${out.items.join(', ')}`,
    handler: ({ input }) =>
      Promise.resolve({ items: input.items, count: input.items.length }),
  });
}

export const echoItemsTool: DefinedTool<unknown> =
  namedEchoTool('demo_echo_items');

const open: Harness[] = [];

export async function startApp(
  overrides: Partial<AppDeps<unknown>> = {}
): Promise<Harness> {
  const logs: LogLine[] = [];
  const logger = pino(
    { base: null, timestamp: false, messageKey: 'message', level: 'info' },
    {
      write(chunk: string): void {
        logs.push(JSON.parse(chunk) as LogLine);
      },
    }
  );
  const app = createApp<unknown>({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    tools: [echoItemsTool],
    toolDeps: undefined,
    logger,
    secrets: [CANARY_SECRET],
    allowedOrigins: [ALLOWED_ORIGIN],
    allowLoopbackOrigins: false,
    // Optional by default, so the transport tests need no token; the caller
    // tests set 'required' and send PARTNER_TOKEN.
    callerAuth: { mode: 'optional', validator: stubPartnerValidator() },
    ...overrides,
  });
  const server: HttpServer = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  const harness: Harness = {
    baseUrl: `http://127.0.0.1:${port}`,
    logs,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  open.push(harness);
  return harness;
}

export async function closeAllApps(): Promise<void> {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
}

export function postMcp(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal
): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  });
}

export function initializeBody(
  clientName = 'jest-raw'
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: clientName, version: '0.0.0' },
    },
  };
}

export function toolCallBody(
  name: string,
  args: Record<string, unknown>,
  id: number = 1
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  };
}

export function toolsListBody(id: number = 1): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'tools/list', params: {} };
}

/** The log line is written when the response finishes, which can trail the client by a tick. */
export async function waitForLogs(
  harness: Harness,
  count: number
): Promise<LogLine[]> {
  const deadline = Date.now() + 2000;
  while (harness.logs.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return harness.logs;
}
