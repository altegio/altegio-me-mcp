import { describe, expect, it } from '@jest/globals';
import { DEFAULT_GATE_OPTIONS } from '../../booking/gate.js';
import {
  PEAK_HOUR_FACTOR,
  PEAK_MONTHLY_TOOL_CALLS,
  PEAK_TOOL_CALLS_PER_SEC,
  SECONDS_PER_MONTH,
  TOOL_MIX,
  UPSTREAM_CALLS_PER_TOOL_CALL,
  UPSTREAM_PEAK_CALLS_PER_SEC,
} from '../profile.js';
import { createSimClock } from '../sim-clock.js';
import { simulatePeak } from '../simulate.js';

// Tier 1 of the OPS-07 proof (D-03, 03-RESEARCH Pattern 9): the production
// tools, BookingClient, BookingHttp and RequestGate run on a discrete-event
// clock against an in-process upstream that measures its own start rate. No
// network and no real time, so it is deterministic and runs in CI.

const GATE_CEILING_PER_SEC = DEFAULT_GATE_OPTIONS.perMinute / 60;

describe('peak profile (README estimate, A2)', () => {
  it('turns 1,000,000 tool calls a month into 0.386 calls/s on average and 1.93 in a 5x hour', () => {
    expect(PEAK_MONTHLY_TOOL_CALLS).toBe(1_000_000);
    expect(SECONDS_PER_MONTH).toBe(2_592_000);
    expect(PEAK_HOUR_FACTOR).toBe(5);
    expect(PEAK_TOOL_CALLS_PER_SEC).toBeCloseTo((1_000_000 / 2_592_000) * 5, 2);
    expect(PEAK_TOOL_CALLS_PER_SEC).toBeCloseTo(1.93, 2);
  });

  it('has a tool mix that sums to 1 and puts book_check at 17%', () => {
    const total = Object.values(TOOL_MIX).reduce((sum, w) => sum + w, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(TOOL_MIX.book_check).toBe(0.17);
    expect(Object.keys(TOOL_MIX)).toHaveLength(6);
  });

  it('costs 1.4 to 1.6 upstream calls per tool call, about 97% of the gate ceiling', () => {
    expect(UPSTREAM_CALLS_PER_TOOL_CALL).toBeGreaterThanOrEqual(1.4);
    expect(UPSTREAM_CALLS_PER_TOOL_CALL).toBeLessThanOrEqual(1.6);
    expect(UPSTREAM_PEAK_CALLS_PER_SEC).toBeCloseTo(
      PEAK_TOOL_CALLS_PER_SEC * UPSTREAM_CALLS_PER_TOOL_CALL,
      10
    );
    expect(UPSTREAM_PEAK_CALLS_PER_SEC / GATE_CEILING_PER_SEC).toBeGreaterThan(
      0.95
    );
    expect(UPSTREAM_PEAK_CALLS_PER_SEC / GATE_CEILING_PER_SEC).toBeLessThan(1);
  });
});

describe('discrete-event clock', () => {
  it('resolves two sleepers at their own times, not one after the other', async () => {
    const clock = createSimClock(1_000);
    const woke: [string, number][] = [];
    void clock.sleep(300).then(() => woke.push(['slow', clock.now()]));
    void clock.sleep(100).then(() => woke.push(['fast', clock.now()]));
    await clock.runUntil(1_000 + 500);
    expect(woke).toEqual([
      ['fast', 1_100],
      ['slow', 1_300],
    ]);
    expect(clock.now()).toBe(1_500);
  });

  it('runs a callback scheduled with at() in time order with the sleepers', async () => {
    const clock = createSimClock(0);
    const seen: string[] = [];
    void clock.sleep(50).then(() => seen.push('sleep50'));
    clock.at(20, () => seen.push('at20'));
    clock.at(80, () => seen.push('at80'));
    await clock.runUntil(100);
    expect(seen).toEqual(['at20', 'sleep50', 'at80']);
  });

  it('flushes the work a wake-up starts before the next timer fires', async () => {
    const clock = createSimClock(0);
    const seen: number[] = [];
    void clock.sleep(10).then(async () => {
      await Promise.resolve();
      await clock.sleep(10);
      seen.push(clock.now());
    });
    await clock.runUntil(100);
    expect(seen).toEqual([20]);
  });

  it('does not move past runUntil and leaves later timers pending', async () => {
    const clock = createSimClock(0);
    let fired = false;
    void clock.sleep(200).then(() => {
      fired = true;
    });
    await clock.runUntil(100);
    expect(fired).toBe(false);
    expect(clock.pending).toBe(1);
    await clock.drain();
    expect(fired).toBe(true);
    expect(clock.now()).toBe(200);
  });
});

describe('tier 1 simulation: the gate against the measuring upstream (OPS-07)', () => {
  const MINUTES = 10;
  // One minute of window slack: the rolling window can hold 180 starts that
  // began in the minute before the first one counted.
  const MAX_STARTS = DEFAULT_GATE_OPTIONS.perMinute * (MINUTES + 1);
  // The simulation takes about a second alone, but a cold ts-jest cache and
  // parallel suites on a two-core runner stretched the 10x step past Jest's
  // default 5 s once. The limit is only a hang guard.
  const SIMULATION_TIMEOUT_MS = 30_000;

  it(
    'at the expected peak for 10 simulated minutes: at most 5 starts per second, 200 per minute, no upstream 429',
    async () => {
      const result = await simulatePeak({ multiplier: 1, minutes: MINUTES });
      expect(result.toolCalls).toBeGreaterThan(1000);
      expect(result.upstream.starts).toBeGreaterThan(1000);
      expect(result.upstream.max1s).toBeLessThanOrEqual(5);
      expect(result.upstream.max60s).toBeLessThanOrEqual(200);
      expect(result.upstream.served429).toBe(0);
      expect(result.unexpected).toEqual([]);
      expect(result.ok + result.busy).toBe(result.toolCalls);
      // The peak sits at about 97% of the ceiling, so most calls are answered.
      expect(result.ok / result.toolCalls).toBeGreaterThan(0.8);
    },
    SIMULATION_TIMEOUT_MS
  );

  it.each([2, 10])(
    'at %ix the peak the excess is shed as busy tool errors and adds no upstream starts',
    async (multiplier) => {
      const result = await simulatePeak({ multiplier, minutes: MINUTES });
      expect(result.toolCalls).toBeGreaterThan(
        1000 * multiplier * 0.9 // the offered load really scaled
      );
      expect(result.upstream.max1s).toBeLessThanOrEqual(5);
      expect(result.upstream.max60s).toBeLessThanOrEqual(200);
      expect(result.upstream.served429).toBe(0);
      expect(result.upstream.starts).toBeLessThanOrEqual(MAX_STARTS);
      expect(result.busy).toBeGreaterThan(0);
      expect(result.ok).toBeGreaterThan(0);
      expect(result.unexpected).toEqual([]);
      expect(result.ok + result.busy).toBe(result.toolCalls);
    },
    SIMULATION_TIMEOUT_MS
  );

  it(
    'is deterministic for one seed',
    async () => {
      const first = await simulatePeak({ multiplier: 2, minutes: 2, seed: 7 });
      const second = await simulatePeak({ multiplier: 2, minutes: 2, seed: 7 });
      expect(second).toEqual(first);
    },
    SIMULATION_TIMEOUT_MS
  );
});
