// Per-call tool context (WR-04, D-01): the abort signal every upstream wait
// listens to, and the caller key the gate's per-key queue cap counts.

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
}

/** A context that never aborts and has no caller key. */
export const NO_TOOL_CONTEXT: ToolContext = Object.freeze({
  signal: new AbortController().signal,
  clientKey: null,
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
  deadlineMs: number = TOOL_DEADLINE_MS
): ToolContext {
  const deadline = AbortSignal.timeout(deadlineMs);
  const signal =
    parent === undefined ? deadline : AbortSignal.any([parent, deadline]);
  return { signal, clientKey };
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
