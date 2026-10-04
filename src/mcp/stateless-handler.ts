import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RequestHandler } from 'express';
import { getCallRecord } from '../observability/call-log.js';
import type { DefinedTool } from '../tools/factory.js';
import { createMcpServer } from './create-server.js';

export interface McpRequestHandlerOptions<D> {
  name: string;
  version: string;
  tools: readonly DefinedTool<D>[];
  toolDeps: D;
  secrets: readonly string[] | (() => readonly string[]);
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
      secrets: opts.secrets as readonly string[],
      record: getCallRecord(res),
    });
    const transport = new StreamableHTTPServerTransport({
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
