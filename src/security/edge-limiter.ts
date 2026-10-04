import type { RequestHandler, Response } from 'express';
import { getCallRecord } from '../observability/call-log.js';

// Our own edge abuse protection for POST /mcp (OPS-06, research Pattern 3):
// express middleware, in memory, exact because the service runs one instance.
// Checks run cheapest first: global in-flight cap, per-address in-flight cap,
// then a token bucket (the shared pool's, or the address's own). The client
// class comes from res.locals, put there by the identity step; this module
// never sees an address and writes none to a record or a log.

export interface EdgeOptions {
  /** Below the Cloud Run concurrency of 80, so we shed before Google does. */
  maxInflight: number;
  maxInflightPerIp: number;
  ipBurst: number;
  ipRefillPerSec: number;
  /** Sized above the gate's capacity on purpose: the gate's in-band busy error is friendlier to the model than an HTTP 429. */
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

export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly refillPerSec: number;

  constructor(capacity: number, refillPerSec: number, now: number) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.last = now;
  }

  take(now: number): { ok: true } | { ok: false; retryAfterSec: number } {
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.last) / 1000) * this.refillPerSec
    );
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true };
    }
    return {
      ok: false,
      retryAfterSec: Math.max(
        1,
        Math.ceil((1 - this.tokens) / this.refillPerSec)
      ),
    };
  }
}

type LimitedBy = 'inflight' | 'ip' | 'pool';

function rejectWith429(
  res: Response,
  limitedBy: LimitedBy,
  retryAfterSec: number
): void {
  getCallRecord(res).limited_by = limitedBy;
  res
    .status(429)
    .set('Retry-After', String(retryAfterSec))
    .json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: `Too many requests. Next: wait ${String(retryAfterSec)} seconds, then repeat the request.`,
      },
      id: null,
    });
}

// The pool is the shared-egress class (many users behind one range); every
// other request is limited under its own key. A request the identity step did
// not classify is limited as 'unknown', never exempt.
function limiterKeyOf(res: Response): string | null {
  const locals = res.locals as { clientKind?: unknown; clientKey?: unknown };
  if (locals.clientKind === 'pool') return null;
  return typeof locals.clientKey === 'string' ? locals.clientKey : 'unknown';
}

export function createEdgeLimiter(
  opts: Partial<EdgeOptions> & { now?: () => number } = {}
): RequestHandler {
  const clock = opts.now ?? Date.now;
  const limits: EdgeOptions = {
    maxInflight: opts.maxInflight ?? DEFAULT_EDGE_OPTIONS.maxInflight,
    maxInflightPerIp:
      opts.maxInflightPerIp ?? DEFAULT_EDGE_OPTIONS.maxInflightPerIp,
    ipBurst: opts.ipBurst ?? DEFAULT_EDGE_OPTIONS.ipBurst,
    ipRefillPerSec: opts.ipRefillPerSec ?? DEFAULT_EDGE_OPTIONS.ipRefillPerSec,
    poolBurst: opts.poolBurst ?? DEFAULT_EDGE_OPTIONS.poolBurst,
    poolRefillPerSec:
      opts.poolRefillPerSec ?? DEFAULT_EDGE_OPTIONS.poolRefillPerSec,
    maxTrackedKeys: opts.maxTrackedKeys ?? DEFAULT_EDGE_OPTIONS.maxTrackedKeys,
  };

  let inflight = 0;
  const inflightByKey = new Map<string, number>();
  // Insertion order is recency order (an access re-inserts), so the first key
  // is the least recently used. Rotating IPv6 prefixes cannot grow this past
  // maxTrackedKeys; the global caps bound that case.
  const buckets = new Map<string, TokenBucket>();
  const pool = new TokenBucket(
    limits.poolBurst,
    limits.poolRefillPerSec,
    clock()
  );

  function bucketFor(key: string, now: number): TokenBucket {
    const existing = buckets.get(key);
    buckets.delete(key);
    const bucket =
      existing ?? new TokenBucket(limits.ipBurst, limits.ipRefillPerSec, now);
    buckets.set(key, bucket);
    while (buckets.size > limits.maxTrackedKeys) {
      const oldest = buckets.keys().next();
      if (oldest.done === true) break;
      buckets.delete(oldest.value);
    }
    return bucket;
  }

  return (_req, res, next) => {
    const key = limiterKeyOf(res);

    if (inflight >= limits.maxInflight) {
      rejectWith429(res, 'inflight', 1);
      return;
    }
    if (
      key !== null &&
      (inflightByKey.get(key) ?? 0) >= limits.maxInflightPerIp
    ) {
      rejectWith429(res, 'inflight', 1);
      return;
    }
    const now = clock();
    const taken = key === null ? pool.take(now) : bucketFor(key, now).take(now);
    if (!taken.ok) {
      rejectWith429(res, key === null ? 'pool' : 'ip', taken.retryAfterSec);
      return;
    }

    inflight += 1;
    if (key !== null) inflightByKey.set(key, (inflightByKey.get(key) ?? 0) + 1);
    // 'finish' and 'close' can both fire; the first one releases the slot.
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      inflight -= 1;
      if (key === null) return;
      const remaining = (inflightByKey.get(key) ?? 1) - 1;
      if (remaining <= 0) inflightByKey.delete(key);
      else inflightByKey.set(key, remaining);
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}
