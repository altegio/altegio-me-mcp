import type { UpstreamCallOptions } from '../booking/http.js';

// Per-call tool context (WR-04, D-01): the abort signal every upstream wait
// listens to, the caller key the gate's per-key queue cap counts, and the
// caller's own partner token that upstream calls are signed with (ADR 0004).

/**
 * One tool call's budget. Sizing (03-RESEARCH Pattern 4): this deadline is
 * below the Cloud Run request timeout (60 s), which is below the proxy header
 * timeout (120 s), which is below Claude's tool-call timeout (240 s).
 */
export const TOOL_DEADLINE_MS = 25_000;

export interface ToolContext {
  /** Aborts when the client or proxy drops the call, or the deadline passes. */
  readonly signal: AbortSignal;
  /** Trusted caller identity for the gate's per-key cap; null when unknown. */
  readonly clientKey: string | null;
  /**
   * The caller's Altegio partner token, already validated; upstream calls are
   * signed with it. Null signs them with the server's own token (local runs,
   * and CALLER_AUTH=optional without a caller token).
   */
  readonly partnerToken: string | null;
  /**
   * A signal that aborts after `ms`: the budget of one step inside the call
   * (book_check's slot check). A seam, so tests need not wait out real time.
   */
  readonly timeout: (ms: number) => AbortSignal;
}

function stepTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/** A context that never aborts and has no caller key. */
export const NO_TOOL_CONTEXT: ToolContext = Object.freeze({
  signal: new AbortController().signal,
  clientKey: null,
  partnerToken: null,
  timeout: stepTimeout,
});

/**
 * One signal for a tool call: it aborts when `parent` does (the SDK aborts
 * extra.signal when the client cancels or the transport closes) or when the
 * deadline passes, whichever comes first. The reason is the parent's, or a
 * TimeoutError for the deadline.
 */
export function createToolContext(
  parent: AbortSignal | undefined,
  clientKey: string | null,
  deadlineMs: number = TOOL_DEADLINE_MS,
  partnerToken: string | null = null
): ToolContext {
  const deadline = AbortSignal.timeout(deadlineMs);
  const signal =
    parent === undefined ? deadline : AbortSignal.any([parent, deadline]);
  return { signal, clientKey, partnerToken, timeout: stepTimeout };
}

/** What every upstream call of a tool carries: its signal, gate key and token. */
export function upstreamCall(ctx: ToolContext): UpstreamCallOptions {
  return ctx.partnerToken === null
    ? { signal: ctx.signal, key: ctx.clientKey }
    : {
        signal: ctx.signal,
        key: ctx.clientKey,
        partnerToken: ctx.partnerToken,
      };
}

/**
 * True when the signal aborted because the deadline passed. Matched by name,
 * not instanceof: the DOMException of AbortSignal.timeout is not an Error of
 * every realm (Jest runs tests in its own).
 */
export function isDeadline(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason;
  return (
    typeof reason === 'object' &&
    reason !== null &&
    (reason as { name?: unknown }).name === 'TimeoutError'
  );
}
