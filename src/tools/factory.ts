import { z } from 'zod';

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

const MAX_ISSUES_CHARS = 300;

function withoutSchemaKey(
  json: Record<string, unknown>
): Record<string, unknown> {
  delete json.$schema;
  return json;
}

function formatIssues(error: z.ZodError): string {
  const text = error.issues
    .map((issue) => {
      const path =
        issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
  return text.slice(0, MAX_ISSUES_CHARS);
}

function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
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

  const failure = (
    outcome: ToolOutcome,
    errorType: string | null,
    text: string
  ): ToolInvocation => ({
    result: { content: [{ type: 'text', text }], isError: true },
    outcome,
    errorType,
  });

  const unexpected = (errorType: string): ToolInvocation =>
    failure(
      'tool_error',
      errorType,
      `${def.name} failed unexpectedly. Next: retry once; if it fails again, tell the user the service is temporarily unavailable.`
    );

  return {
    name: def.name,
    spec,
    async invoke(args: unknown, deps: D): Promise<ToolInvocation> {
      const parsedInput = def.input.safeParse(args ?? {});
      if (!parsedInput.success) {
        return failure(
          'invalid_params',
          null,
          `Invalid parameters for ${def.name}: ${formatIssues(parsedInput.error)}. Next: fix the listed parameters and call ${def.name} again.`
        );
      }

      let output: z.infer<O>;
      try {
        output = await def.handler({
          input: parsedInput.data,
          deps,
        });
      } catch (error) {
        // Never put the error message or stack into the result.
        return unexpected(errorTypeOf(error));
      }

      const parsedOutput = def.output.safeParse(output);
      if (!parsedOutput.success) {
        return unexpected('OutputSchemaMismatch');
      }

      const data = parsedOutput.data;
      return {
        result: {
          content: [{ type: 'text', text: def.render(data) }],
          structuredContent: data,
        },
        outcome: 'ok',
        errorType: null,
      };
    },
  };
}
