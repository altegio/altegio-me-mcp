import { describe, expect, it } from '@jest/globals';
import {
  NO_TOOL_CONTEXT,
  TOOL_DEADLINE_MS,
  createToolContext,
} from '../context.js';

// One signal per tools/call (WR-04, D-01): it fires when the client or proxy
// drops the call, or when the deadline passes, whichever comes first.

function abortedWithin(signal: AbortSignal, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true }
    );
  });
}

describe('tool deadline (WR-04)', () => {
  it('is 25 seconds, below the 60 s Cloud Run timeout', () => {
    expect(TOOL_DEADLINE_MS).toBe(25_000);
  });
});

describe('createToolContext', () => {
  it('aborts after the deadline with a TimeoutError reason', async () => {
    const context = createToolContext(undefined, null, 50);
    expect(context.signal.aborted).toBe(false);

    expect(await abortedWithin(context.signal, 2000)).toBe(true);
    expect((context.signal.reason as Error).name).toBe('TimeoutError');
  });

  it('aborts at once when the parent signal aborts, with the parent reason', () => {
    const parent = new AbortController();
    const context = createToolContext(parent.signal, null, 60_000);
    expect(context.signal.aborted).toBe(false);

    const reason = new Error('transport closed');
    parent.abort(reason);
    expect(context.signal.aborted).toBe(true);
    expect(context.signal.reason).toBe(reason);
  });

  it('is already aborted when the parent was aborted before it was created', () => {
    const parent = new AbortController();
    parent.abort();
    expect(createToolContext(parent.signal, null).signal.aborted).toBe(true);
  });

  it('does not abort early without a parent', async () => {
    const context = createToolContext(undefined, null, 60_000);
    expect(await abortedWithin(context.signal, 30)).toBe(false);
  });

  it('carries the client key through, and null when there is none', () => {
    expect(createToolContext(undefined, 'client-1').clientKey).toBe('client-1');
    expect(createToolContext(undefined, null).clientKey).toBeNull();
  });
});

describe('NO_TOOL_CONTEXT', () => {
  it('never aborts and has no client key', async () => {
    expect(NO_TOOL_CONTEXT.clientKey).toBeNull();
    expect(NO_TOOL_CONTEXT.signal.aborted).toBe(false);
    expect(await abortedWithin(NO_TOOL_CONTEXT.signal, 30)).toBe(false);
  });
});
