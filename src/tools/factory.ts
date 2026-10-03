import { z } from 'zod';
import { textResult, toolErrorResult } from './result.js';

// Tool factory. SDK-free on purpose: tools return plain objects, and only
// src/mcp translates them to the MCP SDK (D-04, ADR-0001-D6).

export type ReadHints = {
  readOnlyHint: true;
  destructiveHint: false;
  openWorldHint: boolean;
  idempotentHint?: boolean;
};

export type WriteHints = {
  readOnlyHint: false;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint: boolean;
};

export type ToolHints = ReadHints | WriteHints;

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type ToolOutcome = 'ok' | 'tool_error' | 'invalid_params';

export interface ToolInvocation {
  result: ToolResult;
  outcome: ToolOutcome;
  errorType: string | null;
}

/** Rendered text per call is capped here (research Pitfall 16, A11). */
export const TEXT_BUDGET_CHARS = 40_000;

const TRUNCATION_NOTE = `\n\n[Output truncated at ${TEXT_BUDGET_CHARS} characters. Next: request the next page or a smaller page_size, or narrow the request.]`;

/** One upstream (Altegio API) call a tool may make; checked by compliance rule R7. */
export interface UpstreamCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  route: string;
}

export interface ToolMeta {
  kind: 'single' | 'list';
  upstream: readonly UpstreamCall[];
}

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: { title: string } & ToolHints;
}

export interface ToolDefinition<
  I extends z.ZodObject,
  O extends z.ZodObject,
  D,
> {
  name: string;
  title: string;
  description: string;
  annotations: ToolHints;
  /** 'list' makes the compliance suite require the pagination shape (R11). */
  kind?: 'list';
  /** Upstream calls this tool makes, for the read-only route check (R7). */
  upstream?: readonly UpstreamCall[];
  input: I;
  output: O;
  render: (out: z.infer<O>) => string;
  handler: (ctx: { input: z.infer<I>; deps: D }) => Promise<z.infer<O>>;
}

export interface DefinedTool<D> {
  readonly name: string;
  readonly meta: ToolMeta;
  readonly spec: ToolSpec;
  invoke(args: unknown, deps: D): Promise<ToolInvocation>;
}

function withoutSchemaKey(
  json: Record<string, unknown>
): Record<string, unknown> {
  delete json.$schema;
  return json;
}

// Keeps at most TEXT_BUDGET_CHARS UTF-16 units without leaving half of a
// surrogate pair at the cut.
function capText(text: string): string {
  if (text.length <= TEXT_BUDGET_CHARS) {
    return text;
  }
  let end = TEXT_BUDGET_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return `${text.slice(0, end)}${TRUNCATION_NOTE}`;
}

export function defineTool<
  I extends z.ZodObject,
  O extends z.ZodObject,
  D = unknown,
>(def: ToolDefinition<I, O, D>): DefinedTool<D> {
  const spec: ToolSpec = {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: withoutSchemaKey(z.toJSONSchema(def.input, { io: 'input' })),
    outputSchema: withoutSchemaKey(
      z.toJSONSchema(def.output, { io: 'output' })
    ),
    // The title is mirrored into the annotations (ADR-0001-D7).
    annotations: { title: def.title, ...def.annotations },
  };

  const meta: ToolMeta = Object.freeze({
    kind: def.kind ?? 'single',
    upstream: Object.freeze([...(def.upstream ?? [])]),
  });

  return {
    name: def.name,
    meta,
    spec,
    async invoke(args: unknown, deps: D): Promise<ToolInvocation> {
      const parsedInput = def.input.safeParse(args ?? {});
      if (!parsedInput.success) {
        return toolErrorResult(def.name, parsedInput.error, 'input');
      }

      let output: z.infer<O>;
      try {
        output = await def.handler({
          input: parsedInput.data,
          deps,
        });
      } catch (error) {
        return toolErrorResult(def.name, error, 'handler');
      }

      const parsedOutput = def.output.safeParse(output);
      if (!parsedOutput.success) {
        return toolErrorResult(def.name, parsedOutput.error, 'output');
      }

      const data = parsedOutput.data;
      let text: string;
      try {
        text = def.render(data);
      } catch (error) {
        return toolErrorResult(def.name, error, 'handler');
      }
      return {
        result: textResult(capText(text), data),
        outcome: 'ok',
        errorType: null,
      };
    },
  };
}
