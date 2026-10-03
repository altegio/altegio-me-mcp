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
  input: I;
  output: O;
  render: (out: z.infer<O>) => string;
  handler: (ctx: { input: z.infer<I>; deps: D }) => Promise<z.infer<O>>;
}

export interface DefinedTool<D> {
  readonly name: string;
  readonly spec: ToolSpec;
  invoke(args: unknown, deps: D): Promise<ToolInvocation>;
}

function withoutSchemaKey(
  json: Record<string, unknown>
): Record<string, unknown> {
  delete json.$schema;
  return json;
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

  return {
    name: def.name,
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
        result: textResult(text, data),
        outcome: 'ok',
        errorType: null,
      };
    },
  };
}
