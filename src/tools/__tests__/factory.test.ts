import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { BookingClient } from '../../booking/client.js';
import {
  fakeFetch,
  loadFixture,
} from '../../booking/__tests__/helpers/fake-fetch.js';
import { businessGet } from '../business.js';
import { createToolContext } from '../context.js';
import type { ToolDeps } from '../registry.js';
import {
  defineTool,
  STRUCTURED_BUDGET_CHARS,
  TEXT_BUDGET_CHARS,
} from '../factory.js';
import {
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  withUntrustedBlock,
} from '../untrusted.js';

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

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('rendered text budget and the untrusted fence', () => {
  const emoji200 = String.fromCodePoint(0x1f600).repeat(200);

  // 50 items with three 200-code-point emoji fields each: about 63 000 UTF-16
  // units of fenced text, which is over TEXT_BUDGET_CHARS but far below the
  // structured budget (WR-05).
  function emojiListTool(): ReturnType<
    typeof defineTool<z.ZodObject, typeof textOutput>
  > {
    const fields: Record<string, string> = {};
    for (let item = 0; item < 50; item += 1) {
      for (const field of ['first', 'second', 'third']) {
        fields[`item ${item} ${field}`] = emoji200;
      }
    }
    return defineTool({
      name: 'demo_emoji_list',
      title: 'Emoji list demo',
      description: 'Renders 50 items of emoji-heavy business text.',
      annotations: readHints,
      kind: 'list',
      input: z.strictObject({}),
      output: textOutput,
      render: () => withUntrustedBlock('Found 50 items.', fields),
      handler: () => Promise.resolve({ text: 'ok' }),
    });
  }

  function expectClosedFenceThenNote(rendered: string): void {
    const closeAt = rendered.lastIndexOf(UNTRUSTED_CLOSE);
    expect(closeAt).toBeGreaterThan(-1);
    const afterClose = rendered.slice(closeAt + UNTRUSTED_CLOSE.length);
    expect(afterClose.startsWith('\n\n[Output truncated')).toBe(true);
    expect(afterClose).toContain('Next:');
    // Nothing but the note follows the closing fence, and the note is the end.
    expect(afterClose.endsWith(']')).toBe(true);
    expect(rendered.length).toBeLessThanOrEqual(
      TEXT_BUDGET_CHARS + UNTRUSTED_CLOSE.length + afterClose.length
    );
  }

  it('closes the fence of a cut list of 50 emoji-heavy items before the note', async () => {
    const { result } = await emojiListTool().invoke({}, undefined);
    const rendered = result.content[0]?.text ?? '';
    expect(rendered).toContain('[Output truncated');
    expect(occurrences(rendered, UNTRUSTED_OPEN)).toBe(1);
    expect(occurrences(rendered, UNTRUSTED_CLOSE)).toBe(
      occurrences(rendered, UNTRUSTED_OPEN)
    );
    expectClosedFenceThenNote(rendered);
    // The cut never leaves half of a surrogate pair before the closing fence.
    const closeAt = rendered.lastIndexOf(UNTRUSTED_CLOSE);
    const beforeClose = rendered.slice(0, closeAt).trimEnd();
    const lastUnit = beforeClose.charCodeAt(beforeClose.length - 1);
    expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false);
  });

  it('closes the fence of a plain long block body', async () => {
    const text = `Summary.\n\n${UNTRUSTED_OPEN}\n${'x'.repeat(
      TEXT_BUDGET_CHARS * 2
    )}\n${UNTRUSTED_CLOSE}`;
    const { result } = await textTool(() => text).invoke({}, undefined);
    const rendered = result.content[0]?.text ?? '';
    expect(occurrences(rendered, UNTRUSTED_CLOSE)).toBe(1);
    expectClosedFenceThenNote(rendered);
  });

  it('closes the fence when the cut falls inside its closing marker', async () => {
    const body = 'y'.repeat(100);
    const head = `${UNTRUSTED_OPEN}\n${body}\n`;
    // The closing marker straddles the budget: its first half is kept.
    const pad = 'z'.repeat(TEXT_BUDGET_CHARS - head.length - 5);
    const text = `${head}${pad}\n${UNTRUSTED_CLOSE}\nafter`;
    const { result } = await textTool(() => text).invoke({}, undefined);
    const rendered = result.content[0]?.text ?? '';
    expect(occurrences(rendered, UNTRUSTED_CLOSE)).toBe(1);
    expect(occurrences(rendered, '<<<END')).toBe(1);
    expectClosedFenceThenNote(rendered);
  });

  it('drops a block whose opening marker does not fit before the cut', async () => {
    const lead = 'a'.repeat(TEXT_BUDGET_CHARS - 10);
    const text = `${lead}\n\n${UNTRUSTED_OPEN}\nsecret field\n${UNTRUSTED_CLOSE}`;
    const { result } = await textTool(() => text).invoke({}, undefined);
    const rendered = result.content[0]?.text ?? '';
    expect(occurrences(rendered, UNTRUSTED_OPEN)).toBe(0);
    expect(occurrences(rendered, UNTRUSTED_CLOSE)).toBe(0);
    expect(rendered).not.toContain('<<<');
    expect(rendered.startsWith(lead)).toBe(true);
    expect(rendered).toContain('[Output truncated');
  });

  it('keeps an already closed fence as it is and cuts the text after it', async () => {
    const text = `${UNTRUSTED_OPEN}\nfield\n${UNTRUSTED_CLOSE}\n${'t'.repeat(
      TEXT_BUDGET_CHARS
    )}`;
    const { result } = await textTool(() => text).invoke({}, undefined);
    const rendered = result.content[0]?.text ?? '';
    expect(occurrences(rendered, UNTRUSTED_OPEN)).toBe(1);
    expect(occurrences(rendered, UNTRUSTED_CLOSE)).toBe(1);
    expect(rendered.startsWith(text.slice(0, TEXT_BUDGET_CHARS))).toBe(true);
    expect(rendered).toContain('[Output truncated');
  });

  it('leaves a text over the budget without any fence cut as before', async () => {
    const text = 'n'.repeat(TEXT_BUDGET_CHARS + 500);
    const { result } = await textTool(() => text).invoke({}, undefined);
    const rendered = result.content[0]?.text ?? '';
    expect(rendered.startsWith('n'.repeat(TEXT_BUDGET_CHARS))).toBe(true);
    expect(rendered).not.toContain(UNTRUSTED_CLOSE);
    expect(rendered).toContain('[Output truncated');
  });
});

// Mirrors STRUCTURED_BUDGET_CHARS in factory.ts.
const STRUCTURED_BUDGET = 100_000;
// JSON.stringify({ text }) adds {"text":"..."} around an ASCII text: 11 characters.
const TEXT_ENVELOPE_CHARS = JSON.stringify({ text: '' }).length;

describe('structuredContent budget', () => {
  it('uses a budget of 100000 characters', () => {
    expect(STRUCTURED_BUDGET_CHARS).toBe(STRUCTURED_BUDGET);
  });

  it('returns an output of exactly the budget with its structuredContent', async () => {
    const text = 'c'.repeat(STRUCTURED_BUDGET - TEXT_ENVELOPE_CHARS);
    expect(JSON.stringify({ text })).toHaveLength(STRUCTURED_BUDGET);
    const invocation = await textTool(() => text).invoke({}, undefined);
    expect(invocation.outcome).toBe('ok');
    expect(invocation.result.isError).toBeUndefined();
    expect(invocation.result.structuredContent).toEqual({ text });
  });

  it('fails an output one character over the budget with OutputTooLarge', async () => {
    const text = 'c'.repeat(STRUCTURED_BUDGET - TEXT_ENVELOPE_CHARS + 1);
    expect(JSON.stringify({ text })).toHaveLength(STRUCTURED_BUDGET + 1);
    const invocation = await textTool(() => text).invoke({}, undefined);
    expect(invocation.outcome).toBe('tool_error');
    expect(invocation.errorType).toBe('OutputTooLarge');
    expect(invocation.result.isError).toBe(true);
    expect(invocation.result).not.toHaveProperty('structuredContent');
    const rendered = invocation.result.content[0]?.text ?? '';
    expect(rendered).toContain('demo_text');
    expect(rendered).toContain('Next:');
    expect(rendered).toContain('page_size');
    expect(rendered).not.toContain('ccccc');
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

describe('tool context (WR-04, D-01)', () => {
  const stalledDeps = (): ToolDeps => ({
    booking: new BookingClient({
      base: 'https://api.alteg.io/api/v1',
      token: 'partner-token-0123456789abcdef',
      // A reply that never comes; fakeFetch rejects when init.signal aborts.
      fetch: fakeFetch([
        {
          method: 'GET',
          path: '/company/722227',
          reply: () => new Promise<never>(() => undefined),
        },
      ]).fetch,
    }),
  });

  it('returns DeadlineExceeded when the deadline passes while the handler awaits an upstream that never answers', async () => {
    const invocation = await businessGet.invoke(
      { location_id: 722227 },
      stalledDeps(),
      createToolContext(undefined, null, 50)
    );
    expect(invocation.outcome).toBe('tool_error');
    expect(invocation.errorType).toBe('DeadlineExceeded');
    expect(invocation.result.isError).toBe(true);
    expect(invocation.result.structuredContent).toBeUndefined();
    expect(invocation.result.content[0]?.text).toContain('Next:');
  });

  it('returns ClientGone when the parent signal aborts', async () => {
    const parent = new AbortController();
    const pending = businessGet.invoke(
      { location_id: 722227 },
      stalledDeps(),
      createToolContext(parent.signal, null, 60_000)
    );
    parent.abort(new Error('transport closed'));

    const invocation = await pending;
    expect(invocation.outcome).toBe('tool_error');
    expect(invocation.errorType).toBe('ClientGone');
  });

  it('keeps the error type of an ordinary failure when the signal never aborted', async () => {
    const deps: ToolDeps = {
      booking: new BookingClient({
        base: 'https://api.alteg.io/api/v1',
        token: 'partner-token-0123456789abcdef',
        fetch: fakeFetch([
          {
            method: 'GET',
            path: '/company/722227',
            reply: { status: 404, body: { success: false, data: null } },
          },
        ]).fetch,
      }),
    };
    const invocation = await businessGet.invoke(
      { location_id: 722227 },
      deps,
      createToolContext(undefined, null, 60_000)
    );
    expect(invocation.errorType).toBe('ToolError');
  });

  it('succeeds under a live context', async () => {
    const deps: ToolDeps = {
      booking: new BookingClient({
        base: 'https://api.alteg.io/api/v1',
        token: 'partner-token-0123456789abcdef',
        fetch: fakeFetch([
          {
            method: 'GET',
            path: '/company/722227',
            reply: loadFixture('company', 'default'),
          },
        ]).fetch,
      }),
    };
    const invocation = await businessGet.invoke(
      { location_id: 722227 },
      deps,
      createToolContext(undefined, null)
    );
    expect(invocation.outcome).toBe('ok');
    expect(invocation.errorType).toBeNull();
  });

  it('hands the context to the handler', async () => {
    const seen: (string | null)[] = [];
    const tool = defineTool({
      name: 'demo_ctx',
      title: 'Context demo',
      description: 'Records the caller key.',
      annotations: readHints,
      input: z.strictObject({}),
      output: z.strictObject({ ok: z.boolean() }),
      render: () => 'ok',
      handler: ({ ctx }) => {
        seen.push(ctx.clientKey);
        return Promise.resolve({ ok: true });
      },
    });
    await tool.invoke({}, undefined, createToolContext(undefined, 'client-9'));
    await tool.invoke({}, undefined);
    expect(seen).toEqual(['client-9', null]);
  });
});
