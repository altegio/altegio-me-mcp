import type { RequestHandler } from 'express';

export interface EdgeOptions {
  maxInflight: number;
  maxInflightPerIp: number;
  ipBurst: number;
  ipRefillPerSec: number;
  poolBurst: number;
  poolRefillPerSec: number;
  maxTrackedKeys: number;
}

export const DEFAULT_EDGE_OPTIONS: Readonly<EdgeOptions> = Object.freeze({
  maxInflight: 60,
  maxInflightPerIp: 6,
  ipBurst: 40,
  ipRefillPerSec: 3,
  poolBurst: 200,
  poolRefillPerSec: 20,
  maxTrackedKeys: 10_000,
});

// Stub: replaced by the implementation in the next commit.
export class TokenBucket {
  constructor(_capacity: number, _refillPerSec: number, _now: number) {}

  take(_now: number): { ok: true } | { ok: false; retryAfterSec: number } {
    return { ok: true };
  }
}

export function createEdgeLimiter(
  _opts: Partial<EdgeOptions> & { now?: () => number } = {}
): RequestHandler {
  return (_req, _res, next) => {
    next();
  };
}
