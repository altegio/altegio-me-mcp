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
import type { Caller } from '../security/caller-auth.js';
import { createToolContext, TOOL_DEADLINE_MS } from '../tools/context.js';
import type { DefinedTool, ToolSpec } from '../tools/factory.js';
import { missingScopes, scopeRefusalText } from '../tools/scopes.js';
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
  /**
   * Who was admitted (ADR 0004): their scopes gate each tool call and their
   * partner token signs the upstream calls. Null grants nothing.
   */
  caller?: Caller | null;
}

// A fresh low-level Server per request: nothing is shared between requests
// except the immutable tool registry (stateless, ADR-0001-D6).
export function createMcpServer<D>(options: CreateMcpServerOptions<D>): Server {
  const { name, version, specs, toolsByName, toolDeps, record } = options;
  const caller = options.caller ?? null;
  // A partner caller brings a partner token; a client may bring one too.
  const partnerToken =
    caller?.kind === 'partner' || caller?.kind === 'client'
      ? caller.partnerToken
      : null;
  const userToken = caller?.kind === 'client' ? caller.userToken : null;
  // The caller's own tokens are scrubbed from results like ours.
  const secrets = [
    ...options.secrets,
    ...(partnerToken === null ? [] : [partnerToken]),
    ...(userToken === null ? [] : [userToken]),
  ];
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
      // Checked before the arguments: a call the grant does not cover never
      // reaches the handler, and nothing is sent upstream (ADR 0004).
      const missing = missingScopes(
        tool.meta.scopes,
        caller?.scopes ?? new Set()
      );
      if (missing.length > 0) {
        record.outcome = 'tool_error';
        record.error_type = 'InsufficientScope';
        return {
          content: [
            { type: 'text', text: scopeRefusalText(tool.name, missing) },
          ],
          isError: true,
        };
      }
      // extra.signal aborts when the client cancels or the transport closes;
      // the context adds the one deadline every call runs under (WR-04).
      const invocation = await tool.invoke(
        request.params.arguments ?? {},
        toolDeps,
        createToolContext(
          extra.signal,
          options.clientKey ?? null,
          TOOL_DEADLINE_MS,
          partnerToken,
          userToken
        )
      );
      record.outcome = invocation.outcome;
      record.error_type = invocation.errorType;
      // Log-based alerts (OPS-05) read these two: an API failure by kind, and
      // our own gate turning a call away, which is not upstream throttling.
      record.upstream_kind = invocation.upstreamKind;
      if (invocation.gateLimited) record.limited_by = 'gate';
      return { ...scrubSecrets(invocation.result, secrets) };
    }
  );

  return server;
}
