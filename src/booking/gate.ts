import type { GateLike, UpstreamCallOptions } from './http.js';

// Outbound throttle for the Altegio API (BAPI-02, D-03). The API blocks a
// caller over 5 requests/s or 200 requests/min, and the partner token of
// developer account 2630 is shared with Altegio.Pro MCP (D-02), so one server
// process stays below both: one start every 250 ms and at most 180 starts in
// any rolling 60 seconds. A 429 pauses every caller until the advised time. A
// caller that would wait past a host timeout is turned away at once.
//
// The gate is per process. A scale-out multiplies the effective rate; that
// limit is recorded for Phase 3 (OPS-06, OPS-07). No dependency: p-throttle is
// flagged suspicious and bottleneck is unmaintained (02-RESEARCH).

export interface RequestGateOptions {
  /** Minimum time between two starts. */
  minSpacingMs?: number;
  /** Maximum starts in any rolling 60 seconds. */
  perMinute?: number;
  /** A caller whose projected wait is longer is rejected at once. */
  maxWaitMs?: number;
  /** A caller arriving when this many callers wait is rejected at once. */
  maxQueue?: number;
  /** A keyed caller arriving when this many of its calls wait is rejected. */
  maxQueuePerKey?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_GATE_OPTIONS = Object.freeze({
  minSpacingMs: 250,
  perMinute: 180,
  maxWaitMs: 10_000,
  maxQueue: 40,
  maxQueuePerKey: 8,
} as const);

/** Wait after a 429 that names no time, in seconds. */
export const DEFAULT_RETRY_AFTER_SECONDS = 2;

/** A 429 is retried once inside the same call only for an advised wait up to this. */
export const INLINE_RETRY_MAX_SECONDS = 3;

/**
 * Upper bound on an advised wait. The partner limiter window is 60 seconds; a
 * larger or malformed value must not pause the whole process for hours.
 */
export const MAX_RETRY_AFTER_SECONDS = 300;

const WINDOW_MS = 60_000;

/** The gate turned a caller away; nothing was sent upstream. */
export class GateSaturatedError extends Error {
  /** Whole seconds, at least 1, until the caller's turn would have come. */
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`Request gate is saturated; retry in ${retryAfterSeconds} seconds`);
    this.name = 'GateSaturatedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface Waiter {
  start: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  /** Caller identity for the per-key cap; null is never capped. */
  key: string | null;
  /** Drops the abort listener; called once the waiter leaves the queue. */
  release: () => void;
}

/** The reason a signal aborted with, as an Error (the reason can be any value). */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new Error(`Call aborted: ${String(reason)}`);
}

function noop(): void {
  // No abort listener to drop.
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Start time allowed after `lastStart` and `starts`, never before `from`. */
function earliestStart(
  from: number,
  pausedUntil: number,
  lastStart: number | null,
  starts: readonly number[],
  minSpacingMs: number,
  perMinute: number
): number {
  let at = Math.max(from, pausedUntil);
  if (lastStart !== null) at = Math.max(at, lastStart + minSpacingMs);
  if (starts.length >= perMinute) {
    // The perMinute-th most recent start must have left the window.
    at = Math.max(at, starts[starts.length - perMinute]! + WINDOW_MS);
  }
  return at;
}

/**
 * Serialises request starts; completions run concurrently. Callers start in
 * FIFO order. No timer runs while the queue is empty, and there is never an
 * interval.
 */
export class RequestGate implements GateLike {
  private readonly minSpacingMs: number;
  private readonly perMinute: number;
  private readonly maxWaitMs: number;
  private readonly maxQueue: number;
  private readonly maxQueuePerKey: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly queue: Waiter[] = [];
  /** Start times inside the last 60 seconds, ascending. */
  private readonly starts: number[] = [];
  private lastStart: number | null = null;
  private pausedUntil = Number.NEGATIVE_INFINITY;
  private pumping = false;

  constructor(options: RequestGateOptions = {}) {
    this.minSpacingMs =
      options.minSpacingMs ?? DEFAULT_GATE_OPTIONS.minSpacingMs;
    this.perMinute = options.perMinute ?? DEFAULT_GATE_OPTIONS.perMinute;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_GATE_OPTIONS.maxWaitMs;
    this.maxQueue = options.maxQueue ?? DEFAULT_GATE_OPTIONS.maxQueue;
    this.maxQueuePerKey =
      options.maxQueuePerKey ?? DEFAULT_GATE_OPTIONS.maxQueuePerKey;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
  }

  /**
   * Queues `start` and runs it when its turn comes. `opts.signal` removes a
   * call that is still queued, so an abandoned call spends no upstream budget
   * and frees its place; a call already started is left to its own fetch
   * signal. `opts.key` caps how many calls one caller can have queued.
   */
  run<T>(start: () => Promise<T>, opts: UpstreamCallOptions = {}): Promise<T> {
    const { signal } = opts;
    const key = opts.key ?? null;
    if (signal?.aborted === true) return Promise.reject(abortReason(signal));

    const now = this.now();
    this.forgetOldStarts(now);
    const wait = this.projectedStart(now) - now;
    if (
      this.queue.length >= this.maxQueue ||
      wait > this.maxWaitMs ||
      (key !== null && this.queuedFor(key) >= this.maxQueuePerKey)
    ) {
      return Promise.reject(
        new GateSaturatedError(Math.max(1, Math.ceil(wait / 1000)))
      );
    }
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        start,
        resolve: resolve as (value: unknown) => void,
        reject,
        key,
        release: noop,
      };
      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = this.queue.indexOf(waiter);
          if (index === -1) return;
          this.queue.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.release = () => {
          signal.removeEventListener('abort', onAbort);
        };
      }
      this.queue.push(waiter);
      if (!this.pumping) void this.pump();
    });
  }

  /** Holds every start until `untilMs`; an earlier deadline never shortens a pause. */
  pauseUntil(untilMs: number): void {
    if (!Number.isFinite(untilMs)) return;
    this.pausedUntil = Math.max(this.pausedUntil, untilMs);
  }

  private queuedFor(key: string): number {
    let count = 0;
    for (const waiter of this.queue) if (waiter.key === key) count += 1;
    return count;
  }

  /** Start time of a caller joining the queue now, behind everyone queued. */
  private projectedStart(now: number): number {
    const starts = [...this.starts];
    let lastStart = this.lastStart;
    let at = now;
    for (let index = 0; index <= this.queue.length; index += 1) {
      at = earliestStart(
        now,
        this.pausedUntil,
        lastStart,
        starts,
        this.minSpacingMs,
        this.perMinute
      );
      starts.push(at);
      lastStart = at;
    }
    return at;
  }

  private forgetOldStarts(now: number): void {
    while (this.starts.length > 0 && this.starts[0]! <= now - WINDOW_MS) {
      this.starts.shift();
    }
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const now = this.now();
        this.forgetOldStarts(now);
        const at = earliestStart(
          now,
          this.pausedUntil,
          this.lastStart,
          this.starts,
          this.minSpacingMs,
          this.perMinute
        );
        if (at > now) {
          try {
            await this.sleep(at - now);
          } catch (error) {
            this.rejectAll(error);
            return;
          }
          // Re-check after waking: a pause may have arrived meanwhile.
          continue;
        }
        const waiter = this.queue.shift()!;
        waiter.release();
        this.starts.push(now);
        this.lastStart = now;
        this.begin(waiter);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Starts one call and settles its caller; the pump does not wait for it. */
  private begin(waiter: Waiter): void {
    let outcome: Promise<unknown>;
    try {
      outcome = waiter.start();
    } catch (error) {
      outcome = Promise.reject(
        error instanceof Error ? error : new Error(String(error))
      );
    }
    outcome.then(waiter.resolve, waiter.reject);
  }

  private rejectAll(error: unknown): void {
    for (const waiter of this.queue.splice(0)) {
      waiter.release();
      waiter.reject(error);
    }
  }
}

const DIGITS = /^\d+$/;

// IMF-fixdate, the HTTP-date form senders must use (RFC 9110 5.6.7). Other
// date strings are ignored: Date.parse accepts values such as '5.5'.
const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

function capped(seconds: number): number {
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

/**
 * Seconds the upstream asks a rate-limited caller to wait, or null when it
 * gives none. The partner limiter sends X-Rate-Limit-Reset (02-RESEARCH
 * Pitfall 10); other limiters may send Retry-After as seconds or an HTTP date.
 * Values are read only in their strict forms and capped at
 * MAX_RETRY_AFTER_SECONDS.
 */
export function retryAfterSeconds(
  headers: Headers,
  nowMs: number
): number | null {
  const reset = headers.get('X-Rate-Limit-Reset');
  if (reset !== null && DIGITS.test(reset)) return capped(Number(reset));

  const retry = headers.get('Retry-After');
  if (retry === null) return null;
  if (DIGITS.test(retry)) return capped(Number(retry));
  if (!IMF_FIXDATE.test(retry)) return null;
  const at = Date.parse(retry);
  if (Number.isNaN(at)) return null;
  return capped(Math.max(0, Math.ceil((at - nowMs) / 1000)));
}
