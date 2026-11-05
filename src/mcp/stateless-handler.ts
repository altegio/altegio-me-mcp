import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { RequestHandler } from 'express';
import { getCallRecord } from '../observability/call-log.js';
import { getCaller } from '../security/caller-auth.js';
import type { DefinedTool } from '../tools/factory.js';
import { createMcpServer } from './create-server.js';

// A function is evaluated once per request, so a secret that rotated since the
// last request is already in the list (OPS-04, SEC-03).
export type SecretList = readonly string[] | (() => readonly string[]);

export interface McpRequestHandlerOptions<D> {
  name: string;
  version: string;
  tools: readonly DefinedTool<D>[];
  toolDeps: D;
  secrets: SecretList;
}

const swallow = (): undefined => undefined;

// Stateless Streamable HTTP: a new Server and transport per POST, no session
// id, one JSON body per response, both closed when the response closes.
export function createMcpRequestHandler<D>(
  opts: McpRequestHandlerOptions<D>
): RequestHandler {
  const sorted = [...opts.tools].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  const toolsByName = new Map<string, DefinedTool<D>>();
  for (const tool of sorted) {
    if (toolsByName.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }
    toolsByName.set(tool.name, tool);
  }
  const specs = sorted.map((tool) => tool.spec);

  return async (req, res) => {
    const server = createMcpServer({
      name: opts.name,
      version: opts.version,
      specs,
      toolsByName,
      toolDeps: opts.toolDeps,
      secrets:
        typeof opts.secrets === 'function' ? opts.secrets() : opts.secrets,
      record: getCallRecord(res),
      // Set by the client identity step (OPS-06); null for the shared pool and
      // when the edge is off, so the gate's per-key cap never applies to them.
      clientKey: (res.locals.clientKey as string | null | undefined) ?? null,
      caller: getCaller(res),
    });
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close().catch(swallow);
      void server.close().catch(swallow);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
