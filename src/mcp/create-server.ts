import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallRecord } from '../observability/call-log.js';
import { scrubSecrets } from '../observability/redact.js';
import { createToolContext } from '../tools/context.js';
import type { DefinedTool, ToolSpec } from '../tools/factory.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';

export interface CreateMcpServerOptions<D> {
  name: string;
  version: string;
  /** Precomputed and already sorted by name. */
  specs: readonly ToolSpec[];
  toolsByName: ReadonlyMap<string, DefinedTool<D>>;
  toolDeps: D;
  secrets: readonly string[];
  record: CallRecord;
  /** Trusted caller identity for the gate's per-key cap; wired in 03-09. */
  clientKey?: string | null;
}

// A fresh low-level Server per request: nothing is shared between requests
// except the immutable tool registry (stateless, ADR-0001-D6).
export function createMcpServer<D>(options: CreateMcpServerOptions<D>): Server {
  const { name, version, specs, toolsByName, toolDeps, secrets, record } =
    options;
  const server = new Server(
    { name, version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, (): ListToolsResult => ({
    tools: [...specs] as unknown as ListToolsResult['tools'],
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const tool = toolsByName.get(request.params.name);
      if (tool === undefined) {
        record.outcome = 'protocol_error';
        throw new McpError(
          ErrorCode.InvalidParams,
          'Unknown tool. Next: call tools/list and use one of the listed names.'
        );
      }
      record.tool = tool.name;
      // extra.signal aborts when the client cancels or the transport closes;
      // the context adds the one deadline every call runs under (WR-04).
      const invocation = await tool.invoke(
        request.params.arguments ?? {},
        toolDeps,
        createToolContext(extra.signal, options.clientKey ?? null)
      );
      record.outcome = invocation.outcome;
      record.error_type = invocation.errorType;
      return { ...scrubSecrets(invocation.result, secrets) };
    }
  );

  return server;
}
