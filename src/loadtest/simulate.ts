import { BookingClient } from '../booking/client.js';
import { PRODUCTION_GATE_OPTIONS, RequestGate } from '../booking/gate.js';
import {
  classifyClient,
  createSharedEgressList,
  gateKeyOf,
} from '../security/client-ip.js';
import { NO_TOOL_CONTEXT, type ToolContext } from '../tools/context.js';
import type { DefinedTool } from '../tools/factory.js';
import { productionTools, type ToolDeps } from '../tools/registry.js';
import {
  createSimFetch,
  createUpstreamCore,
  type UpstreamStats,
} from './mock-upstream.js';
import { PEAK_TOOL_CALLS_PER_SEC, meetsAnsweredShare } from './profile.js';
import { createSimClock } from './sim-clock.js';
import {
  createRng,
  exponentialGapMs,
  fixtureArguments,
  pickClientAddress,
  pickTool,
} from './workload.js';

// Tier 1 of the OPS-07 proof (D-03, 03-RESEARCH Pattern 9). The production
// tools, BookingClient, BookingHttp and RequestGate run on a discrete-event
// clock against an in-process upstream that measures its own start rate. No
// network and no real time, so the same seed gives the same numbers.

const START_MS = 1_700_000_000_000;
const SHARED_EGRESS = createSharedEgressList(['160.79.104.0/21']);

export interface SimulationResult {
  multiplier: number;
  minutes: number;
  toolCalls: number;
  /** Calls that returned a result. */
  ok: number;
  /** Calls our own gate turned away: the in-band "busy" tool error. */
  busy: number;
  /** Anything else that failed; empty in a healthy run. */
  unexpected: string[];
  upstream: UpstreamStats;
  /** Every upstream start time, in simulated milliseconds. */
  startTimes: number[];
}

const toolsByName = new Map<string, DefinedTool<ToolDeps>>(
  productionTools.map((tool) => [tool.name, tool])
);

export async function simulatePeak(opts: {
  /** Offered load as a multiple of the expected peak. */
  multiplier: number;
  minutes: number;
  seed?: number;
}): Promise<SimulationResult> {
  const clock = createSimClock(START_MS);
  const core = createUpstreamCore(clock.now);
  // The gate production runs (src/server.ts composes the same options). No gate
  // option is accepted here, so tier 1 cannot be run on any other gate (WR-57).
  const gate = new RequestGate({
    ...PRODUCTION_GATE_OPTIONS,
    now: clock.now,
    sleep: clock.sleep,
  });
  const booking = new BookingClient({
    base: 'http://sim.invalid/api/v1',
    token: 'sim-canary-token-0001',
    fetch: createSimFetch(core, clock.sleep),
    gate,
    now: clock.now,
  });
  const deps: ToolDeps = { booking };
  const rng = createRng(opts.seed ?? 1);
  const ratePerSec = PEAK_TOOL_CALLS_PER_SEC * opts.multiplier;
  const endMs = START_MS + opts.minutes * 60_000;

  let toolCalls = 0;
  let ok = 0;
  let busy = 0;
  const unexpected: string[] = [];
  const running: Promise<void>[] = [];

  const fire = (): void => {
    const name = pickTool(rng);
    const tool = toolsByName.get(name);
    if (tool === undefined) throw new Error(`Unknown tool ${name}`);
    const key = gateKeyOf(
      classifyClient(pickClientAddress(rng), SHARED_EGRESS)
    );
    // A signal per call: one long-lived signal would collect a dependent for
    // every AbortSignal.any() the client builds from it, tens of thousands at 10x.
    const signal = new AbortController().signal;
    const ctx: ToolContext = {
      ...NO_TOOL_CONTEXT,
      signal,
      clientKey: key,
      timeout: () => signal,
    };
    toolCalls += 1;
    running.push(
      tool.invoke(fixtureArguments(name), deps, ctx).then((invocation) => {
        if (invocation.outcome === 'ok') ok += 1;
        else if (invocation.gateLimited) busy += 1;
        else if (unexpected.length < 10) {
          unexpected.push(`${name}: ${String(invocation.errorType)}`);
        }
      })
    );
  };

  // Poisson arrivals, each scheduling the next, so the clock holds one arrival
  // at a time instead of every arrival of ten minutes.
  const scheduleNext = (from: number): void => {
    const at = from + exponentialGapMs(rng, ratePerSec);
    if (at >= endMs) return;
    clock.at(at, () => {
      fire();
      scheduleNext(at);
    });
  };
  scheduleNext(START_MS);

  await clock.drain();
  await Promise.all(running);

  return {
    multiplier: opts.multiplier,
    minutes: opts.minutes,
    toolCalls,
    ok,
    busy,
    unexpected,
    upstream: core.stats(),
    startTimes: core.startTimes(),
  };
}

export interface CapacityResult {
  /** The largest multiple of the expected peak that met the launch threshold. */
  multiplier: number;
  stepsPerUnit: number;
  /** The run at `multiplier`; null when even the first step did not meet it. */
  at: SimulationResult | null;
  /** The first run that did not meet it; null when none failed up to the maximum. */
  above: SimulationResult | null;
}

/**
 * The largest multiple of the expected peak, in steps of 1 / stepsPerUnit, at
 * which more than 80% of tool calls are answered under the production gate. The
 * sweep climbs one step at a time and stops at the first step that does not
 * meet the threshold, so `multiplier` is the last step that did.
 */
export async function capacityMultiplier(
  opts: {
    stepsPerUnit?: number;
    maxMultiplier?: number;
    minutes?: number;
    seed?: number;
  } = {}
): Promise<CapacityResult> {
  const stepsPerUnit = opts.stepsPerUnit ?? 20;
  const maxMultiplier = opts.maxMultiplier ?? 2;
  const minutes = opts.minutes ?? 10;
  const seed = opts.seed ?? 1;
  let multiplier = 0;
  let at: SimulationResult | null = null;
  for (let step = 1; step <= maxMultiplier * stepsPerUnit; step += 1) {
    const result = await simulatePeak({
      multiplier: step / stepsPerUnit,
      minutes,
      seed,
    });
    if (!meetsAnsweredShare(result.ok, result.toolCalls)) {
      return { multiplier, stepsPerUnit, at, above: result };
    }
    multiplier = step / stepsPerUnit;
    at = result;
  }
  return { multiplier, stepsPerUnit, at, above: null };
}
