import { afterEach, describe, expect, it } from '@jest/globals';
import { BookingClient } from '../../booking/client.js';
import { PRODUCTION_GATE_OPTIONS, RequestGate } from '../../booking/gate.js';
import {
  closeAllApps,
  startApp,
  waitForLogs,
  type Harness,
} from '../../__tests__/helpers/http-harness.js';
import type { DefinedTool } from '../../tools/factory.js';
import { productionTools, type ToolDeps } from '../../tools/registry.js';
import type { LoadtestArgs } from '../args.js';
import { LIVE_TOOLS, runLive, type LiveDeps } from '../live.js';
import { startMockUpstream, type MockUpstream } from '../mock-upstream.js';
import { FIXTURE_LOCATION_ID } from '../workload.js';

// The live runner against the real app, the six production tools, the
// production gate and BookingClient in front of the measuring mock upstream
// (WR-59). Everything is on 127.0.0.1: no remote target, no partner token.

const CANARY_TOKEN = 'canary-live-e2e-token-0001';

const realDeps: LiveDeps = {
  fetch: globalThis.fetch.bind(globalThis),
  now: Date.now,
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
};

let mock: MockUpstream | null = null;

afterEach(async () => {
  await closeAllApps();
  if (mock !== null) await mock.close();
  mock = null;
});

async function startTopology(
  proxyKeys: string[] | null
): Promise<{ app: Harness; mock: MockUpstream }> {
  const upstream = await startMockUpstream({ port: 0 });
  mock = upstream;
  const booking = new BookingClient({
    base: upstream.url,
    token: CANARY_TOKEN,
    gate: new RequestGate({ ...PRODUCTION_GATE_OPTIONS }),
  });
  const app = await startApp({
    tools: productionTools as unknown as readonly DefinedTool<unknown>[],
    toolDeps: { booking } satisfies ToolDeps,
    ...(proxyKeys === null ? {} : { proxyAuth: { keys: () => proxyKeys } }),
  });
  return { app, mock: upstream };
}

function liveArgs(target: string, durationSec: number): LoadtestArgs {
  // Built by hand: parseArgs refuses plain http by design.
  return {
    scenario: 'live',
    target,
    startContainer: null,
    durationSec,
    out: null,
    location: FIXTURE_LOCATION_ID,
    rate: 1.35,
    confirmAnnounced: true,
    notes: [],
  };
}

describe('runLive against the real app and the measuring mock', () => {
  it('public-route topology: every call is HTTP 200, the upstream calls are counted per tool, PASS', async () => {
    const topology = await startTopology(null);
    const outcome = await runLive(
      liveArgs(`${topology.app.baseUrl}/mcp`, 6),
      realDeps
    );

    expect(outcome.status).toBe('PASS');
    expect(outcome.stoppedBy).toBeNull();
    expect(outcome.requests).toBeGreaterThanOrEqual(5);
    expect(Object.keys(outcome.perTool).sort()).toEqual([...LIVE_TOOLS].sort());
    expect(outcome.httpStatuses).toEqual({ '200': outcome.requests });
    expect(outcome.toolErrors).toBe(0);

    // Four of the five live tools make one upstream call; business_list_services
    // makes two (the business card for the currency, and the services), so a
    // cycle of five tool calls is six upstream calls.
    const stats = topology.mock.stats();
    const servicesCalls = outcome.perTool.business_list_services ?? 0;
    expect(stats.starts).toBe(outcome.requests + servicesCalls);
    expect(stats.served429).toBe(0);

    const logs = await waitForLogs(topology.app, outcome.requests);
    const calls = logs.filter((line) => line.event === 'mcp_call');
    expect(calls).toHaveLength(outcome.requests);
    for (const line of calls) expect(line.http_status).toBe(200);
  }, 30_000);

  it('signature-required topology: stops at the first HTTP 401 with zero upstream calls', async () => {
    const topology = await startTopology(['a'.repeat(64)]);
    const outcome = await runLive(
      liveArgs(`${topology.app.baseUrl}/mcp`, 6),
      realDeps
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.stoppedBy).toBe('HTTP 401');
    expect(outcome.requests).toBe(1);
    expect(topology.mock.stats().starts).toBe(0);
  }, 30_000);
});
