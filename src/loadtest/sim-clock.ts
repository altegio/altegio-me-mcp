// STUB for the RED commit of plan 03-12; replaced in the GREEN commit.
export interface SimClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  at: (atMs: number, fn: () => void) => void;
  runUntil: (untilMs: number) => Promise<void>;
  drain: () => Promise<void>;
  readonly pending: number;
}

export function createSimClock(startMs: number): SimClock {
  return {
    now: () => startMs,
    sleep: () => Promise.resolve(),
    at: () => undefined,
    runUntil: () => Promise.resolve(),
    drain: () => Promise.resolve(),
    pending: 0,
  };
}
