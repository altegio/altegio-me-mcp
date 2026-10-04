import { EventEmitter } from 'node:events';
import { describe, expect, it } from '@jest/globals';
import type { Request, Response } from 'express';
import { createCallRecord } from '../../observability/call-log.js';
import {
  DEFAULT_EDGE_OPTIONS,
  TokenBucket,
  createEdgeLimiter,
  type EdgeOptions,
} from '../edge-limiter.js';

describe('DEFAULT_EDGE_OPTIONS', () => {
  it('holds the chosen numbers and is frozen', () => {
    expect(DEFAULT_EDGE_OPTIONS).toEqual({
      maxInflight: 60,
      maxInflightPerIp: 6,
      ipBurst: 40,
      ipRefillPerSec: 3,
      poolBurst: 200,
      poolRefillPerSec: 20,
      maxTrackedKeys: 10_000,
    });
    expect(Object.isFrozen(DEFAULT_EDGE_OPTIONS)).toBe(true);
  });
});

describe('TokenBucket', () => {
  it('admits a burst of capacity and then rejects, asking for at least one second', () => {
    const bucket = new TokenBucket(40, 3, 0);
    for (let i = 0; i < 40; i += 1) {
      expect(bucket.take(0)).toEqual({ ok: true });
    }
    expect(bucket.take(0)).toEqual({ ok: false, retryAfterSec: 1 });
  });

  it('refills at the given rate', () => {
    const bucket = new TokenBucket(40, 3, 0);
    for (let i = 0; i < 40; i += 1) bucket.take(0);
    for (let i = 0; i < 3; i += 1) {
      expect(bucket.take(1000)).toEqual({ ok: true });
    }
    expect(bucket.take(1000).ok).toBe(false);
  });

  it('admits at exactly one token and rejects the next', () => {
    const bucket = new TokenBucket(2, 1, 0);
    bucket.take(0);
    bucket.take(0);
    expect(bucket.take(1000)).toEqual({ ok: true });
    expect(bucket.take(1000).ok).toBe(false);
  });

  it('never refills past capacity', () => {
    const bucket = new TokenBucket(2, 1, 0);
    expect(bucket.take(1_000_000).ok).toBe(true);
    expect(bucket.take(1_000_000).ok).toBe(true);
    expect(bucket.take(1_000_000).ok).toBe(false);
  });

  it('rounds the wait up and never reports less than one second', () => {
    const slow = new TokenBucket(1, 0.25, 0);
    slow.take(0);
    expect(slow.take(0)).toEqual({ ok: false, retryAfterSec: 4 });
    const fast = new TokenBucket(1, 1000, 0);
    fast.take(0);
    expect(fast.take(0)).toEqual({ ok: false, retryAfterSec: 1 });
  });
});

interface FakeRes extends EventEmitter {
  locals: Record<string, unknown>;
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  status(code: number): FakeRes;
  set(name: string, value: string): FakeRes;
  json(body: unknown): FakeRes;
}

function fakeRes(kind: string | undefined, key: string | null): FakeRes {
  const res = new EventEmitter() as FakeRes;
  res.locals = { callRecord: createCallRecord() };
  if (kind !== undefined) {
    res.locals.clientKind = kind;
    res.locals.clientKey = key;
  }
  res.statusCode = 200;
  res.headers = {};
  res.body = undefined;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.set = (name, value) => {
    res.headers[name] = value;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

function harness(
  options: Partial<EdgeOptions> = {},
  startMs: number = 1_700_000_000_000
) {
  let now = startMs;
  const limiter = createEdgeLimiter({ ...options, now: () => now });
  return {
    advance(ms: number): void {
      now += ms;
    },
    send(kind: string | undefined, key: string | null) {
      const res = fakeRes(kind, key);
      let admitted = false;
      limiter({} as Request, res as unknown as Response, () => {
        admitted = true;
      });
      return { res, admitted };
    },
    ip(key = 'ip:203.0.113.7') {
      return this.send('ip', key);
    },
    pool() {
      return this.send('pool', null);
    },
  };
}

const limitedBy = (res: FakeRes): unknown =>
  (res.locals.callRecord as { limited_by: unknown }).limited_by;

describe('createEdgeLimiter: per-address bucket', () => {
  it('admits 40 requests in one instant and answers the 41st with 429, Retry-After and a JSON-RPC body', () => {
    const edge = harness();
    for (let i = 0; i < 40; i += 1) {
      const call = edge.ip();
      expect(call.admitted).toBe(true);
      call.res.emit('finish');
    }
    const rejected = edge.ip();
    expect(rejected.admitted).toBe(false);
    expect(rejected.res.statusCode).toBe(429);
    expect(rejected.res.headers['Retry-After']).toBe('1');
    expect(rejected.res.body).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message:
          'Too many requests. Next: wait 1 seconds, then repeat the request.',
      },
      id: null,
    });
    expect(limitedBy(rejected.res)).toBe('ip');
  });

  it('refills three tokens a second', () => {
    const edge = harness();
    for (let i = 0; i < 40; i += 1) edge.ip().res.emit('finish');
    edge.advance(1000);
    for (let i = 0; i < 3; i += 1) {
      const call = edge.ip();
      expect(call.admitted).toBe(true);
      call.res.emit('finish');
    }
    expect(edge.ip().admitted).toBe(false);
  });

  it('gives each address its own bucket', () => {
    const edge = harness({ ipBurst: 1 });
    expect(edge.ip('ip:198.51.100.1').admitted).toBe(true);
    expect(edge.ip('ip:198.51.100.1').admitted).toBe(false);
    expect(edge.ip('ip:198.51.100.2').admitted).toBe(true);
  });

  it('computes Retry-After from the refill rate', () => {
    const edge = harness({ ipBurst: 1, ipRefillPerSec: 0.25 });
    edge.ip().res.emit('finish');
    const rejected = edge.ip();
    expect(rejected.res.headers['Retry-After']).toBe('4');
    expect(
      (rejected.res.body as { error: { message: string } }).error.message
    ).toBe('Too many requests. Next: wait 4 seconds, then repeat the request.');
  });

  it('limits a request without a usable address under the single key unknown, never exempt', () => {
    const edge = harness();
    for (let i = 0; i < 40; i += 1) {
      const call = edge.send('unknown', 'unknown');
      expect(call.admitted).toBe(true);
      call.res.emit('finish');
    }
    const rejected = edge.send('unknown', 'unknown');
    expect(rejected.admitted).toBe(false);
    expect(limitedBy(rejected.res)).toBe('ip');
  });

  it('treats a request the identity step never classified as unknown', () => {
    const edge = harness({ ipBurst: 1 });
    expect(edge.send(undefined, null).admitted).toBe(true);
    expect(edge.send(undefined, null).admitted).toBe(false);
    expect(edge.send('unknown', 'unknown').admitted).toBe(false);
  });

  it('consumes one token for every POST, repeated or not', () => {
    const edge = harness({ ipBurst: 3 });
    const outcomes = [1, 2, 3, 4].map(() => {
      const call = edge.ip();
      call.res.emit('finish');
      return call.admitted;
    });
    expect(outcomes).toEqual([true, true, true, false]);
  });
});

describe('createEdgeLimiter: shared pool', () => {
  it('admits a pool burst of 200 and then answers 429 limited_by pool', () => {
    const edge = harness();
    for (let i = 0; i < 200; i += 1) {
      const call = edge.pool();
      expect(call.admitted).toBe(true);
      call.res.emit('finish');
    }
    const rejected = edge.pool();
    expect(rejected.admitted).toBe(false);
    expect(rejected.res.statusCode).toBe(429);
    expect(limitedBy(rejected.res)).toBe('pool');
    edge.advance(1000);
    expect(edge.pool().admitted).toBe(true);
  });

  it('is not capped per address and does not spend any address bucket', () => {
    const edge = harness();
    for (let i = 0; i < 50; i += 1) {
      expect(edge.pool().admitted).toBe(true);
    }
    expect(edge.ip().admitted).toBe(true);
  });
});

describe('createEdgeLimiter: in-flight caps', () => {
  it('answers the 61st concurrent request with 429 and Retry-After 1', () => {
    const edge = harness();
    for (let i = 0; i < 60; i += 1) {
      expect(edge.pool().admitted).toBe(true);
    }
    const rejected = edge.pool();
    expect(rejected.admitted).toBe(false);
    expect(rejected.res.statusCode).toBe(429);
    expect(rejected.res.headers['Retry-After']).toBe('1');
    expect(limitedBy(rejected.res)).toBe('inflight');
  });

  it('answers the 7th concurrent request from one address with 429', () => {
    const edge = harness();
    for (let i = 0; i < 6; i += 1) {
      expect(edge.ip().admitted).toBe(true);
    }
    const rejected = edge.ip();
    expect(rejected.admitted).toBe(false);
    expect(rejected.res.headers['Retry-After']).toBe('1');
    expect(limitedBy(rejected.res)).toBe('inflight');
    expect(edge.ip('ip:198.51.100.5').admitted).toBe(true);
  });

  it('does not spend a token on a request the in-flight cap turned away', () => {
    const edge = harness({ ipBurst: 7, maxInflightPerIp: 6 });
    const open = Array.from({ length: 6 }, () => edge.ip());
    expect(edge.ip().admitted).toBe(false);
    open.forEach((call) => call.res.emit('finish'));
    expect(edge.ip().admitted).toBe(true);
    expect(edge.ip().admitted).toBe(false);
  });

  it('returns the counters to zero after finish, after a client abort and after an error', () => {
    const edge = harness({ ipBurst: 1000 });
    const first = Array.from({ length: 6 }, () => edge.ip());
    first.forEach((call) => call.res.emit('finish'));
    const second = Array.from({ length: 6 }, () => edge.ip());
    expect(second.every((call) => call.admitted)).toBe(true);
    second.forEach((call) => call.res.emit('close'));
    const third = Array.from({ length: 6 }, () => edge.ip());
    expect(third.every((call) => call.admitted)).toBe(true);
    third.forEach((call) => {
      call.res.emit('error', new Error('socket hang up'));
      call.res.emit('close');
    });
    const fourth = Array.from({ length: 6 }, () => edge.ip());
    expect(fourth.every((call) => call.admitted)).toBe(true);
  });

  it('releases the global counter too', () => {
    const edge = harness({ maxInflight: 2 });
    const a = edge.pool();
    const b = edge.pool();
    expect(edge.pool().admitted).toBe(false);
    a.res.emit('close');
    expect(edge.pool().admitted).toBe(true);
    b.res.emit('finish');
  });

  it('releases once when a request emits both finish and close', () => {
    const edge = harness({ ipBurst: 1000 });
    const open = Array.from({ length: 6 }, () => edge.ip());
    open[0]?.res.emit('finish');
    open[0]?.res.emit('close');
    expect(edge.ip().admitted).toBe(true);
    expect(edge.ip().admitted).toBe(false);
  });
});

describe('createEdgeLimiter: bounded key map', () => {
  it('forgets the oldest key first and never tracks more than maxTrackedKeys', () => {
    const edge = harness({ ipBurst: 1, maxTrackedKeys: 2 });
    const keys = ['ip:198.51.100.1', 'ip:198.51.100.2', 'ip:198.51.100.3'];
    for (const key of keys) {
      const call = edge.ip(key);
      expect(call.admitted).toBe(true);
      call.res.emit('finish');
    }
    // The second and the third are still tracked and still empty.
    expect(edge.ip(keys[1]).admitted).toBe(false);
    expect(edge.ip(keys[2]).admitted).toBe(false);
    // The first was evicted, so it starts again with a full bucket.
    expect(edge.ip(keys[0]).admitted).toBe(true);
  });
});
