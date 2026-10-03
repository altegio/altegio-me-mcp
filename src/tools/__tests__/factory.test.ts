import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { defineTool, TEXT_BUDGET_CHARS } from '../factory.js';

const readHints = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
} as const;

const countInput = z.strictObject({ count: z.number().int().default(3) });
const countOutput = z.strictObject({ count: z.number().int() });

function countTool(
  extra: {
    kind?: 'list';
    upstream?: readonly { method: 'GET' | 'POST'; route: string }[];
  } = {}
): ReturnType<typeof defineTool<typeof countInput, typeof countOutput>> {
  return defineTool({
    name: 'demo_count',
    title: 'Count demo',
    description: 'Returns the count it was given.',
    annotations: readHints,
    input: countInput,
    output: countOutput,
    render: (out) => `Count: ${out.count}`,
    handler: ({ input }) => Promise.resolve({ count: input.count }),
    ...extra,
  });
}

const textOutput = z.strictObject({ text: z.string() });

function textTool(
  produce: () => string
): ReturnType<typeof defineTool<z.ZodObject, typeof textOutput>> {
  return defineTool({
    name: 'demo_text',
    title: 'Text demo',
    description: 'Returns text of a chosen length.',
    annotations: readHints,
    input: z.strictObject({}),
    output: textOutput,
    render: (out) => out.text,
    handler: () => Promise.resolve({ text: produce() }),
  });
}

describe('defineTool spec', () => {
  it('mirrors the title into annotations and carries all three hints', () => {
    const { spec } = countTool();
    expect(spec.annotations.title).toBe(spec.title);
    expect(typeof spec.annotations.readOnlyHint).toBe('boolean');
    expect(typeof spec.annotations.destructiveHint).toBe('boolean');
    expect(typeof spec.annotations.openWorldHint).toBe('boolean');
  });

  it('generates strict JSON Schemas without a $schema key', () => {
    const { spec } = countTool();
    expect(spec.inputSchema.additionalProperties).toBe(false);
    expect(spec.outputSchema.type).toBe('object');
    expect(spec.inputSchema).not.toHaveProperty('$schema');
    expect(spec.outputSchema).not.toHaveProperty('$schema');
  });

  it('parses undefined arguments as an empty object and applies defaults', async () => {
    const invocation = await countTool().invoke(undefined, undefined);
    expect(invocation.outcome).toBe('ok');
    expect(invocation.result.structuredContent).toEqual({ count: 3 });
  });
});

describe('defineTool meta', () => {
  it('defaults to a single-result tool with no declared upstream calls', () => {
    const { meta } = countTool();
    expect(meta.kind).toBe('single');
    expect(meta.upstream).toEqual([]);
    expect(Object.isFrozen(meta.upstream)).toBe(true);
  });

  it('exposes a declared kind and upstream list', () => {
    const { meta } = countTool({
      kind: 'list',
      upstream: [{ method: 'GET', route: '/companies' }],
    });
    expect(meta.kind).toBe('list');
    expect(meta.upstream).toEqual([{ method: 'GET', route: '/companies' }]);
  });
});

describe('rendered text budget', () => {
  it('uses a budget of 40000 characters', () => {
    expect(TEXT_BUDGET_CHARS).toBe(40_000);
  });

  it('keeps a text of exactly the budget whole', async () => {
    const text = 'a'.repeat(TEXT_BUDGET_CHARS);
    const { result } = await textTool(() => text).invoke({}, undefined);
    expect(result.content[0]?.text).toBe(text);
  });

  it('truncates one character over the budget and names the next page', async () => {
    const text = 'a'.repeat(TEXT_BUDGET_CHARS + 1);
    const { result } = await textTool(() => text).invoke({}, undefined);
    const rendered = result.content[0]?.text ?? '';
    expect(rendered.startsWith('a'.repeat(TEXT_BUDGET_CHARS))).toBe(true);
    expect(rendered.charAt(TEXT_BUDGET_CHARS)).not.toBe('a');
    expect(rendered).toContain('Next:');
    expect(rendered).toContain('page');
  });

  it('does not split a surrogate pair at the cut', async () => {
    const text = `${'a'.repeat(TEXT_BUDGET_CHARS - 1)}\u{1F600}tail`;
    const { result } = await textTool(() => text).invoke({}, undefined);
    const rendered = result.content[0]?.text ?? '';
    expect(rendered.startsWith('a'.repeat(TEXT_BUDGET_CHARS - 1))).toBe(true);
    // The emoji does not fit whole, so neither half of it may remain.
    expect(rendered.codePointAt(TEXT_BUDGET_CHARS - 1)).not.toBe(0xd83d);
    expect(rendered).not.toContain('\u{1F600}');
    expect(rendered).not.toContain('\ud83d');
  });

  it('returns structuredContent unchanged when the text is cut', async () => {
    const text = 'b'.repeat(TEXT_BUDGET_CHARS + 10);
    const { result } = await textTool(() => text).invoke({}, undefined);
    expect(result.structuredContent).toEqual({ text });
  });
});

describe('compile-time contract', () => {
  it('rejects incomplete or contradictory definitions at type-check time', () => {
    const base = {
      name: 'demo_types',
      description: 'Type-level checks only.',
      input: z.strictObject({}),
      output: z.strictObject({}),
      render: () => 'ok',
      handler: () => Promise.resolve({}),
    };

    // @ts-expect-error a definition without a title does not compile
    defineTool({ ...base, annotations: readHints });

    defineTool({
      ...base,
      title: 'Types',
      // @ts-expect-error openWorldHint is required
      annotations: { readOnlyHint: true, destructiveHint: false },
    });

    defineTool({
      ...base,
      title: 'Types',
      // @ts-expect-error a read-only tool cannot also be destructive
      annotations: {
        readOnlyHint: true,
        destructiveHint: true,
        openWorldHint: false,
      },
    });

    // The three hints and a title compile.
    expect(() =>
      defineTool({ ...base, title: 'Types', annotations: readHints })
    ).not.toThrow();
  });
});
