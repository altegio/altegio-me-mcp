import type { UpstreamStats } from './mock-upstream.js';

// STUB for the RED commit of plan 03-12; replaced in the GREEN commit.
export interface SimulationResult {
  multiplier: number;
  minutes: number;
  toolCalls: number;
  ok: number;
  busy: number;
  unexpected: string[];
  upstream: UpstreamStats;
}

export function simulatePeak(opts: {
  multiplier: number;
  minutes: number;
  seed?: number;
}): Promise<SimulationResult> {
  return Promise.resolve({
    multiplier: opts.multiplier,
    minutes: opts.minutes,
    toolCalls: 0,
    ok: 0,
    busy: 0,
    unexpected: [],
    upstream: { max1s: 0, max60s: 0, served429: 0, starts: 0, aborted: 0 },
  });
}
