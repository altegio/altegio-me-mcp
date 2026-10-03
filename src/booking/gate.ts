import type { GateLike } from './http.js';

// Contract stub for the RED commit of plan 02-05; replaced in GREEN.

export interface RequestGateOptions {
  minSpacingMs?: number;
  perMinute?: number;
  maxWaitMs?: number;
  maxQueue?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_GATE_OPTIONS = Object.freeze({
  minSpacingMs: 250,
  perMinute: 180,
  maxWaitMs: 10_000,
  maxQueue: 40,
} as const);

export const DEFAULT_RETRY_AFTER_SECONDS = 2;
export const INLINE_RETRY_MAX_SECONDS = 3;
export const MAX_RETRY_AFTER_SECONDS = 300;

export class GateSaturatedError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('request gate saturated');
    this.name = 'GateSaturatedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class RequestGate implements GateLike {
  constructor(options: RequestGateOptions = {}) {
    void options;
  }

  run<T>(start: () => Promise<T>): Promise<T> {
    return start();
  }

  pauseUntil(untilMs: number): void {
    void untilMs;
  }
}

export function retryAfterSeconds(
  headers: Headers,
  nowMs: number
): number | null {
  void headers;
  void nowMs;
  return null;
}
