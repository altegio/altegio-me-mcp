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

export function createToolContext(
  parent: AbortSignal | undefined,
  clientKey: string | null,
  deadlineMs: number = TOOL_DEADLINE_MS
): ToolContext {
  void parent;
  void deadlineMs;
  return { signal: new AbortController().signal, clientKey };
}
