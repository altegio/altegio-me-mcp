import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  DEFAULT_GATE_OPTIONS,
  DEFAULT_RETRY_AFTER_SECONDS,
  GateSaturatedError,
  INLINE_RETRY_MAX_SECONDS,
  MAX_RETRY_AFTER_SECONDS,
  RequestGate,
  retryAfterSeconds,
  type RequestGateOptions,
} from '../gate.js';
import { PASS_THROUGH_GATE } from '../http.js';
import { createFakeClock, type FakeClock } from './helpers/fake-clock.js';

// The outbound throttle (BAPI-02, D-03): at most one start every 250 ms, at
// most 180 starts in any rolling 60 seconds, a shared pause after a 429, and a
// bounded wait. Every test runs on the auto-advancing fake clock, so a burst
// is instant and each start time is exact.

const T0 = 1_700_000_000_000;

function gateOn(
  clock: FakeClock,
  options: Omit<RequestGateOptions, 'now' | 'sleep'> = {}
): RequestGate {
  return new RequestGate({ ...options, now: clock.now, sleep: clock.sleep });
}

/** Starts `count` calls at once; each records its start time and returns its index. */
function burst(
  gate: RequestGate,
  clock: FakeClock,
  count: number
): { done: Promise<number[]>; starts: number[]; order: number[] } {
  const starts: number[] = [];
  const order: number[] = [];
  const done = Promise.all(
    Array.from({ length: count }, (_, index) =>
      gate.run(() => {
        order.push(index);
        starts.push(clock.now());
        return Promise.resolve(index);
      })
    )
  );
  return { done, starts, order };
}

async function saturation(
  promise: Promise<unknown>
): Promise<GateSaturatedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GateSaturatedError) return error;
    throw error;
  }
  throw new Error('expected the gate to reject with GateSaturatedError');
}

describe('throttle constants (D-03)', () => {
  it('stays below 5 requests per second and 200 per minute', () => {
    expect(DEFAULT_GATE_OPTIONS).toEqual({
      minSpacingMs: 250,
      perMinute: 180,
      maxWaitMs: 10_000,
      maxQueue: 40,
      maxQueuePerKey: 8,
    });
    expect(Object.isFrozen(DEFAULT_GATE_OPTIONS)).toBe(true);
    expect(DEFAULT_RETRY_AFTER_SECONDS).toBe(2);
    expect(INLINE_RETRY_MAX_SECONDS).toBe(3);
  });
});

describe('RequestGate spacing and window (BAPI-02)', () => {
  it('starts 30 concurrent calls in FIFO order, 250 ms apart, each with its own result', async () => {
    const clock = createFakeClock(T0);
    const { done, starts, order } = burst(gateOn(clock), clock, 30);
    const results = await done;

    const indexes = Array.from({ length: 30 }, (_, index) => index);
    expect(results).toEqual(indexes);
    expect(order).toEqual(indexes);
    expect(starts).toHaveLength(30);
    for (let index = 1; index < starts.length; index += 1) {
      expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(250);
    }
    expect(starts).toEqual(indexes.map((index) => T0 + index * 250));
  });

  it('holds the 4th start of a 3-per-minute window until the oldest start leaves it', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock, {
      minSpacingMs: 0,
      perMinute: 3,
      maxWaitMs: 120_000,
    });
    const { done, starts } = burst(gate, clock, 4);
    await done;
    expect(starts).toEqual([T0, T0, T0, T0 + 60_000]);
  });

  it('holds the 181st start inside a 60-second window until the oldest start leaves it', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock, {
      minSpacingMs: 0,
      maxWaitMs: 120_000,
      maxQueue: 500,
    });
    const { done, starts } = burst(gate, clock, 181);
    await done;
    expect(starts.slice(0, 180).every((start) => start === T0)).toBe(true);
    expect(starts[180]).toBe(T0 + 60_000);
  });

  it('allows a start exactly 250 ms after the previous one with no wait', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    await gate.run(() => Promise.resolve(clock.now()));
    await clock.sleep(250);
    const sleepsBefore = clock.sleeps.length;

    const second = await gate.run(() => Promise.resolve(clock.now()));
    expect(second).toBe(T0 + 250);
    expect(clock.sleeps).toHaveLength(sleepsBefore);
  });

  it('never starts two calls 249 ms apart', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    await gate.run(() => Promise.resolve(clock.now()));
    await clock.sleep(249);

    const second = await gate.run(() => Promise.resolve(clock.now()));
    expect(second).toBe(T0 + 250);
    expect(clock.sleeps.at(-1)).toBe(1);
  });

  it('starts a single call on an idle gate with no wait', async () => {
    const clock = createFakeClock(T0);
    const start = await gateOn(clock).run(() => Promise.resolve(clock.now()));
    expect(start).toBe(T0);
    expect(clock.sleeps).toEqual([]);
  });
});

describe('RequestGate pause (BAPI-02)', () => {
  it('holds the next start until the pause deadline', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    gate.pauseUntil(T0 + 5000);
    const start = await gate.run(() => Promise.resolve(clock.now()));
    expect(start).toBe(T0 + 5000);
  });

  it('keeps the later deadline when pauseUntil is called twice', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    gate.pauseUntil(T0 + 5000);
    gate.pauseUntil(T0 + 1000);
    const start = await gate.run(() => Promise.resolve(clock.now()));
    expect(start).toBe(T0 + 5000);
  });

  it('delays every queued caller when one caller pauses the gate', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    const starts: number[] = [];
    const first = gate.run(() => {
      starts.push(clock.now());
      gate.pauseUntil(clock.now() + 2000);
      return Promise.resolve();
    });
    const others = [1, 2].map(() =>
      gate.run(() => {
        starts.push(clock.now());
        return Promise.resolve();
      })
    );
    await Promise.all([first, ...others]);
    expect(starts).toEqual([T0, T0 + 2000, T0 + 2250]);
  });

  it('re-checks the deadline after waking, so a pause set while a caller waits still holds it', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    await gate.run(() => Promise.resolve());
    const second = gate.run(() => Promise.resolve(clock.now()));
    // The gate is now waiting 250 ms for the second caller.
    gate.pauseUntil(T0 + 3000);
    expect(await second).toBe(T0 + 3000);
  });

  it('ignores a deadline that is not a finite number', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    gate.pauseUntil(Number.NaN);
    gate.pauseUntil(Number.POSITIVE_INFINITY);
    const start = await gate.run(() => Promise.resolve(clock.now()));
    expect(start).toBe(T0);
  });
});

describe('RequestGate bounded wait (BAPI-02, T-02-19)', () => {
  it('rejects at once, without starting, a caller that would wait more than 10 seconds', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    gate.pauseUntil(T0 + 30_000);
    const start = jest.fn(() => Promise.resolve('started'));

    const error = await saturation(gate.run(start));
    expect(error.retryAfterSeconds).toBe(30);
    expect(start).not.toHaveBeenCalled();
    expect(clock.sleeps).toEqual([]);
  });

  it('accepts a caller whose projected wait is exactly 10 seconds', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    gate.pauseUntil(T0 + 10_000);
    const start = await gate.run(() => Promise.resolve(clock.now()));
    expect(start).toBe(T0 + 10_000);
  });

  it('rejects the 41st caller at once when 40 callers are already queued', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock, { maxWaitMs: 60_000 });
    gate.pauseUntil(T0 + 1000);
    const { done, starts } = burst(gate, clock, 40);
    const start = jest.fn(() => Promise.resolve(-1));

    const error = await saturation(gate.run(start));
    expect(error).toBeInstanceOf(GateSaturatedError);
    expect(Number.isInteger(error.retryAfterSeconds)).toBe(true);
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(start).not.toHaveBeenCalled();

    await done;
    expect(starts).toHaveLength(40);
  });

  it('rejects only the caller whose start function fails; the next caller still starts', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    const failing = gate.run(() => Promise.reject(new Error('upstream down')));
    const next = gate.run(() => Promise.resolve('ok'));

    await expect(failing).rejects.toThrow('upstream down');
    await expect(next).resolves.toBe('ok');
  });

  it('rejects only its own caller when the start function throws synchronously', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    const failing = gate.run((): Promise<string> => {
      throw new Error('sync failure');
    });
    const next = gate.run(() => Promise.resolve('ok'));

    await expect(failing).rejects.toThrow('sync failure');
    await expect(next).resolves.toBe('ok');
  });

  it('starts the next caller without waiting for the previous call to finish', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    let release: () => void = () => undefined;
    const slow = gate.run(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('slow');
        })
    );
    const fast = await gate.run(() => Promise.resolve(clock.now()));
    expect(fast).toBe(T0 + 250);
    release();
    await expect(slow).resolves.toBe('slow');
  });
});

describe('RequestGate abortable waiters (WR-04, T-03-16)', () => {
  it('rejects at once with the signal reason, and starts nothing, for an already aborted signal', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    const reason = new Error('client went away');
    const controller = new AbortController();
    controller.abort(reason);
    const start = jest.fn(() => Promise.resolve('started'));

    await expect(gate.run(start, { signal: controller.signal })).rejects.toBe(
      reason
    );
    expect(start).not.toHaveBeenCalled();
    expect(clock.sleeps).toEqual([]);
    // The gate is untouched: the next caller starts with no wait.
    expect(await gate.run(() => Promise.resolve(clock.now()))).toBe(T0);
  });

  it('checks the signal before the saturation checks', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    gate.pauseUntil(T0 + 30_000);
    const reason = new Error('gone');
    const controller = new AbortController();
    controller.abort(reason);

    await expect(
      gate.run(() => Promise.resolve(1), { signal: controller.signal })
    ).rejects.toBe(reason);
  });

  it('removes a waiter whose signal aborts while queued and never starts it', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    gate.pauseUntil(T0 + 1000);
    const starts: string[] = [];
    const run = (name: string, signal?: AbortSignal): Promise<number> =>
      gate.run(
        () => {
          starts.push(name);
          return Promise.resolve(clock.now());
        },
        { signal }
      );
    const controller = new AbortController();
    const reason = new Error('client went away');

    const first = run('first');
    const abandoned = run('abandoned', controller.signal);
    const third = run('third');
    controller.abort(reason);

    await expect(abandoned).rejects.toBe(reason);
    // The abandoned call frees its place at once: the third caller starts one
    // spacing after the first, not two.
    expect(await first).toBe(T0 + 1000);
    expect(await third).toBe(T0 + 1250);
    expect(starts).toEqual(['first', 'third']);
  });

  it('shrinks the projected wait of the next caller when a queued call is abandoned', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock, { maxWaitMs: 1400 });
    gate.pauseUntil(T0 + 1000);
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const queued = controllers.map((controller) =>
      gate.run(() => Promise.resolve(clock.now()), {
        signal: controller.signal,
      })
    );
    // The clock sits at the pause end once the gate sleeps; a seventh caller
    // would start 1500 ms later, past the 1400 ms bound.
    const late = gate.run(() => Promise.resolve(0));
    await expect(late).rejects.toBeInstanceOf(GateSaturatedError);

    for (const controller of controllers.slice(1)) controller.abort();
    await Promise.allSettled(queued);
    const admitted = await gate.run(() => Promise.resolve(clock.now()));
    expect(admitted).toBe(T0 + 1250);
  });

  it('does not cancel a start the gate already admitted when its signal aborts later', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    const controller = new AbortController();
    let release: () => void = () => undefined;
    const call = gate.run(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('finished');
        }),
      { signal: controller.signal }
    );
    controller.abort(new Error('late'));
    release();
    await expect(call).resolves.toBe('finished');
  });

  it('leaves no abort listener on the signal after the waiter started or was removed', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    gate.pauseUntil(T0 + 1000);
    const started = new AbortController();
    const removed = new AbortController();

    const first = gate.run(() => Promise.resolve(1), {
      signal: started.signal,
    });
    const second = gate.run(() => Promise.resolve(2), {
      signal: removed.signal,
    });
    expect(getEventListeners(started.signal, 'abort')).toHaveLength(1);
    removed.abort();
    await expect(second).rejects.toBeDefined();
    await first;
    expect(getEventListeners(started.signal, 'abort')).toHaveLength(0);
    expect(getEventListeners(removed.signal, 'abort')).toHaveLength(0);
  });

  it('keeps FIFO order for the callers that stay when others abandon', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    gate.pauseUntil(T0 + 500);
    const order: number[] = [];
    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const calls = controllers.map((controller, index) =>
      gate.run(
        () => {
          order.push(index);
          return Promise.resolve(index);
        },
        { signal: controller.signal }
      )
    );
    controllers[1]!.abort();
    controllers[3]!.abort();
    await Promise.allSettled(calls);
    expect(order).toEqual([0, 2, 4]);
  });
});

describe('RequestGate per-key queue cap (IN-06, T-03-17)', () => {
  it('turns away the 9th queued call of one key while other keys and unkeyed calls are admitted', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    gate.pauseUntil(T0 + 1000);
    const queuedA = Array.from({ length: 8 }, (_, index) =>
      gate.run(() => Promise.resolve(index), { key: 'a' })
    );
    const start = jest.fn(() => Promise.resolve(-1));

    const error = await saturation(gate.run(start, { key: 'a' }));
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(start).not.toHaveBeenCalled();

    const other = gate.run(() => Promise.resolve('b'), { key: 'b' });
    const unkeyed = gate.run(() => Promise.resolve('none'));
    const nullKey = gate.run(() => Promise.resolve('null'), { key: null });
    expect(await Promise.all([...queuedA, other, unkeyed, nullKey])).toEqual([
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      'b',
      'none',
      'null',
    ]);
  });

  it('admits a new call of the key again once one of its calls has started', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    gate.pauseUntil(T0 + 1000);
    let again: Promise<string> | null = null;
    const calls = Array.from({ length: 8 }, (_, index) =>
      gate.run(
        () => {
          if (index === 0) {
            again = gate.run(() => Promise.resolve('again'), { key: 'a' });
          }
          return Promise.resolve(String(index));
        },
        { key: 'a' }
      )
    );
    await Promise.all(calls);
    expect(again).not.toBeNull();
    await expect(again).resolves.toBe('again');
  });

  it('frees a place when a queued call of the key is abandoned', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    gate.pauseUntil(T0 + 1000);
    const controller = new AbortController();
    const calls = Array.from({ length: 8 }, (_, index) =>
      gate.run(() => Promise.resolve(index), {
        key: 'a',
        signal: index === 7 ? controller.signal : undefined,
      })
    );
    controller.abort();
    const replacement = gate.run(() => Promise.resolve('replacement'), {
      key: 'a',
    });
    await Promise.allSettled(calls);
    await expect(replacement).resolves.toBe('replacement');
  });

  it('honours a custom maxQueuePerKey', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock, { maxQueuePerKey: 2 });
    gate.pauseUntil(T0 + 1000);
    const queued = [1, 2].map(() =>
      gate.run(() => Promise.resolve('ok'), { key: 'a' })
    );
    await saturation(gate.run(() => Promise.resolve('no'), { key: 'a' }));
    await Promise.all(queued);
  });

  it('starts keyed and unkeyed calls in arrival order; the cap never reorders the queue', async () => {
    const clock = createFakeClock(T0);
    const gate = gateOn(clock);
    gate.pauseUntil(T0 + 500);
    const order: string[] = [];
    const run = (name: string, key: string | null): Promise<unknown> =>
      gate.run(
        () => {
          order.push(name);
          return Promise.resolve(name);
        },
        { key }
      );
    const calls = [
      run('a1', 'a'),
      run('b1', 'b'),
      run('n1', null),
      run('a2', 'a'),
      run('b2', 'b'),
    ];
    await Promise.all(calls);
    expect(order).toEqual(['a1', 'b1', 'n1', 'a2', 'b2']);
  });
});

describe('PASS_THROUGH_GATE with a call signal (WR-04)', () => {
  it('rejects an already aborted signal without starting', async () => {
    const reason = new Error('gone');
    const controller = new AbortController();
    controller.abort(reason);
    const start = jest.fn(() => Promise.resolve('started'));

    await expect(
      PASS_THROUGH_GATE.run(start, { signal: controller.signal })
    ).rejects.toBe(reason);
    expect(start).not.toHaveBeenCalled();
  });

  it('runs the start at once otherwise', async () => {
    await expect(
      PASS_THROUGH_GATE.run(() => Promise.resolve('ok'), {
        signal: new AbortController().signal,
        key: 'a',
      })
    ).resolves.toBe('ok');
    await expect(
      PASS_THROUGH_GATE.run(() => Promise.resolve('ok'))
    ).resolves.toBe('ok');
  });
});

describe('RequestGate timers (BAPI-02 concurrency)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('leaves no pending sleep once every call has settled', async () => {
    const clock = createFakeClock(T0);
    const { done } = burst(gateOn(clock), clock, 5);
    await done;
    const sleeps = clock.sleeps.length;
    await Promise.resolve();
    await Promise.resolve();
    expect(clock.pending).toBe(0);
    expect(clock.sleeps).toHaveLength(sleeps);
  });

  it('never creates an interval and sets no timer for a call on an idle gate', async () => {
    const setInterval = jest.spyOn(globalThis, 'setInterval');
    const setTimeout = jest.spyOn(globalThis, 'setTimeout');
    const gate = new RequestGate();
    await gate.run(() => Promise.resolve('ok'));
    expect(setTimeout).not.toHaveBeenCalled();
    expect(setInterval).not.toHaveBeenCalled();
  });

  it('holds no timer after a spaced burst on real time has settled', async () => {
    const setInterval = jest.spyOn(globalThis, 'setInterval');
    const timersBefore = process
      .getActiveResourcesInfo()
      .filter((name) => name === 'Timeout').length;
    const gate = new RequestGate({ minSpacingMs: 5 });
    await Promise.all(
      [1, 2, 3].map((value) => gate.run(() => Promise.resolve(value)))
    );
    const timersAfter = process
      .getActiveResourcesInfo()
      .filter((name) => name === 'Timeout').length;
    expect(timersAfter).toBeLessThanOrEqual(timersBefore);
    expect(setInterval).not.toHaveBeenCalled();
  });
});

describe('retryAfterSeconds (BAPI-02, 02-RESEARCH Pitfall 10)', () => {
  const NOW = T0 + 800;

  function read(headers: Record<string, string>): number | null {
    return retryAfterSeconds(new Headers(headers), NOW);
  }

  it('reads X-Rate-Limit-Reset as seconds', () => {
    expect(read({ 'X-Rate-Limit-Reset': '7' })).toBe(7);
  });

  it('prefers X-Rate-Limit-Reset when both headers are present', () => {
    expect(read({ 'X-Rate-Limit-Reset': '7', 'Retry-After': '30' })).toBe(7);
  });

  it('reads Retry-After as seconds', () => {
    expect(read({ 'Retry-After': '4' })).toBe(4);
  });

  it('rounds an HTTP-date Retry-After 4.2 s ahead up to 5', () => {
    const at = new Date(T0 + 5000).toUTCString();
    expect(read({ 'Retry-After': at })).toBe(5);
  });

  it('gives 0 for an HTTP-date Retry-After in the past', () => {
    const at = new Date(T0 - 60_000).toUTCString();
    expect(read({ 'Retry-After': at })).toBe(0);
  });

  it('gives null when neither header is present', () => {
    expect(read({})).toBeNull();
    expect(read({ 'X-Rate-Limit-Policy': '200;w=60' })).toBeNull();
  });

  // The Fetch standard strips surrounding whitespace from header values, so
  // ' 5' arrives as '5'; whitespace inside a value is kept and rejected.
  it.each(['5 0', '+5', '5.5', '-1', 'soon', '0x10', '1e3', ''])(
    'ignores X-Rate-Limit-Reset %p and falls through to Retry-After',
    (value) => {
      expect(read({ 'X-Rate-Limit-Reset': value })).toBeNull();
      expect(read({ 'X-Rate-Limit-Reset': value, 'Retry-After': '4' })).toBe(4);
    }
  );

  it.each(['5 0', '+5', '5.5', '-1', 'soon', '0x10', '1e3', ''])(
    'ignores Retry-After %p',
    (value) => {
      expect(read({ 'Retry-After': value })).toBeNull();
    }
  );

  it('ignores a Retry-After date that is not an IMF-fixdate', () => {
    expect(read({ 'Retry-After': '2023-11-14T22:13:25Z' })).toBeNull();
    expect(
      read({ 'Retry-After': 'Tue, 14 Nov 2023 22:13:25 +0000' })
    ).toBeNull();
  });

  it('caps an advised wait at MAX_RETRY_AFTER_SECONDS', () => {
    expect(MAX_RETRY_AFTER_SECONDS).toBe(300);
    expect(read({ 'X-Rate-Limit-Reset': '86400' })).toBe(300);
    expect(read({ 'Retry-After': '9'.repeat(400) })).toBe(300);
    const far = new Date(T0 + 86_400_000).toUTCString();
    expect(read({ 'Retry-After': far })).toBe(300);
  });
});
