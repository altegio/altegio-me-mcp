import { z } from 'zod';
import { NO_TOOL_CONTEXT, type ToolContext } from './context.js';
import { textResult, toolErrorResult } from './result.js';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from './untrusted.js';

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

/**
 * structuredContent per call is capped here, measured as the length of
 * JSON.stringify(data). Phase 2 tools also cap every business-authored field
 * through sanitizeUntrusted, so this budget is a backstop, not the main bound.
 */
export const STRUCTURED_BUDGET_CHARS = 100_000;

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
  handler: (ctx: {
    input: z.infer<I>;
    deps: D;
    ctx: ToolContext;
  }) => Promise<z.infer<O>>;
}

export interface DefinedTool<D> {
  readonly name: string;
  readonly meta: ToolMeta;
  readonly spec: ToolSpec;
  invoke(args: unknown, deps: D, ctx?: ToolContext): Promise<ToolInvocation>;
}

function withoutSchemaKey(
  json: Record<string, unknown>
): Record<string, unknown> {
  delete json.$schema;
  return json;
}

// The first `end` UTF-16 units, without leaving half of a surrogate pair.
function headUnits(text: string, end: number): string {
  const last = text.charCodeAt(end - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

// Keeps at most TEXT_BUDGET_CHARS UTF-16 units without leaving half of a
// surrogate pair at the cut. The cut is fence-aware (WR-05): the business
// controls how long its fields are, so a cut that lands inside an untrusted
// block must not drop UNTRUSTED_CLOSE, or the note would read as part of the
// block. The block body is cut instead, then the fence is closed, then the note
// follows. A block whose opening marker does not fit is dropped whole.
function capText(text: string): string {
  if (text.length <= TEXT_BUDGET_CHARS) {
    return text;
  }

  const openAt = text.lastIndexOf(UNTRUSTED_OPEN, TEXT_BUDGET_CHARS - 1);
  if (openAt !== -1) {
    const closeAt = text.indexOf(
      UNTRUSTED_CLOSE,
      openAt + UNTRUSTED_OPEN.length
    );
    const closedBeforeCut =
      closeAt !== -1 && closeAt + UNTRUSTED_CLOSE.length <= TEXT_BUDGET_CHARS;
    if (!closedBeforeCut) {
      const bodyStart = openAt + UNTRUSTED_OPEN.length;
      // Room for the body: the budget minus a line break and the closing fence.
      const bodyEnd = TEXT_BUDGET_CHARS - UNTRUSTED_CLOSE.length - 1;
      if (bodyEnd <= bodyStart) {
        return `${text.slice(0, openAt).trimEnd()}${TRUNCATION_NOTE}`;
      }
      const body = headUnits(text, bodyEnd).trimEnd();
      return `${body}\n${UNTRUSTED_CLOSE}${TRUNCATION_NOTE}`;
    }
  }

  return `${headUnits(text, TEXT_BUDGET_CHARS)}${TRUNCATION_NOTE}`;
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
    async invoke(
      args: unknown,
      deps: D,
      ctx: ToolContext = NO_TOOL_CONTEXT
    ): Promise<ToolInvocation> {
      const parsedInput = def.input.safeParse(args ?? {});
      if (!parsedInput.success) {
        return toolErrorResult(def.name, parsedInput.error, 'input');
      }

      let output: z.infer<O>;
      try {
        output = await def.handler({
          input: parsedInput.data,
          deps,
          ctx,
        });
      } catch (error) {
        return toolErrorResult(def.name, error, 'handler');
      }

      const parsedOutput = def.output.safeParse(output);
      if (!parsedOutput.success) {
        return toolErrorResult(def.name, parsedOutput.error, 'output');
      }

      const data = parsedOutput.data;
      // An oversized payload is never returned, not even cut: a cut JSON
      // object is not valid against the output schema.
      if (JSON.stringify(data).length > STRUCTURED_BUDGET_CHARS) {
        return {
          result: {
            content: [
              {
                type: 'text',
                text: `${def.name} produced more data than one result can carry. Next: request a smaller page_size or narrow the request.`,
              },
            ],
            isError: true,
          },
          outcome: 'tool_error',
          errorType: 'OutputTooLarge',
        };
      }

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
