// Load script for OPS-07 (D-03). Run it through npm:
//
//   npm run loadtest -- --scenario=peak     --start-container=IMAGE [--duration-sec=180]
//   npm run loadtest -- --scenario=edge     --start-container=IMAGE
//   npm run loadtest -- --scenario=deadline --start-container=IMAGE
//   npm run loadtest -- --scenario=live     --target=BASE_URL --confirm-announced
//
// Flags:
//   --scenario=peak|edge|deadline|live  what to run (required)
//   --start-container=IMAGE   peak, edge, deadline: start IMAGE with NODE_ENV=test,
//                             PROXY_AUTH=required, a random 64-hex proxy key, a canary
//                             partner token and ALTEGIO_API_BASE pointing at the mock
//                             upstream on this host (--add-host=host.docker.internal:
//                             host-gateway), and stop it afterwards
//   --target=URL              peak, edge, deadline: the loopback port to publish the
//                             container on (default: a free port). live: base URL of
//                             the service; requests go to <URL>/mcp
//   --duration-sec=N          peak: seconds at the expected peak (default 180; a 2x step
//                             of up to 60 s and a 10x step of up to 20 s follow). live: default 120, at most 180
//   --out=DIR                 where results.json and container.log go
//                             (default loadtest-output/<timestamp>/, git-ignored)
//   --location=ID             live only: the location to read (default 726120)
//   --rate=N                  live only: tool calls a second (default 1, at most 2.7,
//                             90% of the gate's 3 upstream calls a second)
//   --confirm-announced       live only: required. The owner must have announced the
//                             run first; it spends partner-token budget shared with
//                             Altegio.Pro MCP
//
// The first three scenarios never leave this machine: they drive a local container
// and a mock upstream that measures its own start rate, with a random test key and a
// canary token (T-03-39). The live scenario is for plan 03-16 only and stops at the
// first sign of throttling or rejection (T-03-38); see live.ts.
//
// Output: one line "PASS <scenario>: ..." or "FAIL <scenario>: ..." on stdout, a
// results.json in the output directory, and for local scenarios the container log.
// Exit code 0 on PASS, 1 on FAIL, 2 on a usage error.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { signProxyRequest } from '../__tests__/helpers/sign-request.js';
import { UsageError, USAGE, parseArgs, type LoadtestArgs } from './args.js';
import { runLive } from './live.js';
import {
  LIMIT_PER_MINUTE,
  LIMIT_PER_SECOND,
  startMockUpstream,
  type MockUpstream,
  type RouteName,
  type UpstreamStats,
} from './mock-upstream.js';
import { PEAK_TOOL_CALLS_PER_SEC, type LoadToolName } from './profile.js';
import {
  FIXTURE_DATE,
  FIXTURE_LOCATION_ID,
  FIXTURE_SERVICE_ID,
  FIXTURE_TEAM_MEMBER_ID,
  createRng,
  exponentialGapMs,
  fixtureArguments,
  pickClientAddress,
  pickTool,
  poolAddress,
} from './workload.js';

const CONTAINER_PORT = 8080;
/** Not a pool address and not the platform's: an arbitrary egress hop for the X-Forwarded-For chain. */
const EGRESS_HOP = '34.96.0.1';
const DEADLINE_LIMIT_MS = 26_000;

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

function check(name: string, pass: boolean, detail: string): Check {
  return { name, pass, detail };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function docker(args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const run = spawnSync('docker', args, { encoding: 'utf8' });
  return {
    status: run.status ?? 1,
    stdout: run.stdout,
    stderr: run.stderr,
  };
}

function git(args: string[]): string {
  const run = spawnSync('git', args, { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : 'unknown';
}

// ---------------------------------------------------------------------------
// The local harness: mock upstream + container with the proxy signature on
// ---------------------------------------------------------------------------

interface LogSummary {
  lines: number;
  mcpCalls: number;
  httpStatus: Record<string, number>;
  limitedBy: Record<string, number>;
  outcome: Record<string, number>;
  upstreamKind: Record<string, number>;
  errorType: Record<string, number>;
}

function bump(
  table: Record<string, number>,
  key: string | number | null | undefined
): void {
  const name = key === null || key === undefined ? 'null' : String(key);
  table[name] = (table[name] ?? 0) + 1;
}

function scalar(value: unknown): string | number | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function summariseLog(text: string): LogSummary {
  const summary: LogSummary = {
    lines: 0,
    mcpCalls: 0,
    httpStatus: {},
    limitedBy: {},
    outcome: {},
    upstreamKind: {},
    errorType: {},
  };
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    summary.lines += 1;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.event !== 'mcp_call') continue;
    summary.mcpCalls += 1;
    bump(summary.httpStatus, scalar(entry.http_status));
    bump(summary.limitedBy, scalar(entry.limited_by));
    bump(summary.outcome, scalar(entry.outcome));
    bump(summary.upstreamKind, scalar(entry.upstream_kind));
    bump(summary.errorType, scalar(entry.error_type));
  }
  return summary;
}

interface Harness {
  target: string;
  key: string;
  mock: MockUpstream;
  outDir: string;
  image: string;
  imageId: string;
  /** Stops the container, writes container.log and returns its summary. */
  stop(): Promise<LogSummary>;
}

async function startHarness(
  args: LoadtestArgs,
  stallMs: Partial<Record<RouteName, number>> = {}
): Promise<Harness> {
  const image = args.startContainer;
  if (image === null) throw new UsageError('--start-container is required');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = args.out ?? join('loadtest-output', stamp);
  await mkdir(outDir, { recursive: true });

  // The container reaches the mock through the host gateway, so the mock
  // listens on every interface for the length of the run. It serves synthetic
  // fixtures only.
  const mock = await startMockUpstream({ port: 0, host: '0.0.0.0', stallMs });
  const hostPort =
    args.target === null
      ? await freePort()
      : Number(new URL(args.target).port) || (await freePort());
  const target = args.target ?? `http://127.0.0.1:${hostPort}`;
  const key = randomBytes(32).toString('hex');
  const canaryToken = `loadtest-canary-${randomBytes(12).toString('hex')}`;
  const name = `altegio-loadtest-${randomBytes(4).toString('hex')}`;

  const started = docker([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '-p',
    `127.0.0.1:${hostPort}:${CONTAINER_PORT}`,
    '--add-host=host.docker.internal:host-gateway',
    '-e',
    'NODE_ENV=test',
    '-e',
    'PROXY_AUTH=required',
    '-e',
    `MCP_PROXY_BACKEND_KEY=${key}`,
    '-e',
    `ALTEGIO_API_TOKEN=${canaryToken}`,
    '-e',
    `ALTEGIO_API_BASE=http://host.docker.internal:${mock.port}/api/v1`,
    '-e',
    `PUBLIC_BASE_URL=${target}`,
    '-e',
    'LOG_LEVEL=info',
    image,
  ]);
  if (started.status !== 0) {
    await mock.close();
    throw new Error(`docker run failed: ${started.stderr.trim()}`);
  }
  const imageId = docker(['image', 'inspect', '--format', '{{.Id}}', image])
    .stdout.trim()
    .replace(/^sha256:/, '')
    .slice(0, 12);

  let stopped: Promise<LogSummary> | null = null;
  const stop = (): Promise<LogSummary> => {
    stopped ??= (async () => {
      const logs = docker(['logs', name]);
      const text = `${logs.stdout}${logs.stderr}`;
      await writeFile(join(outDir, 'container.log'), text);
      docker(['rm', '-f', name]);
      await mock.close();
      return summariseLog(text);
    })();
    return stopped;
  };

  const harness: Harness = { target, key, mock, outDir, image, imageId, stop };
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 80 && !healthy; attempt += 1) {
      try {
        healthy = (await fetch(`${target}/health`)).status === 200;
      } catch {
        healthy = false;
      }
      if (!healthy) await sleepMs(500);
    }
    if (!healthy)
      throw new Error('the container did not become healthy in 40 s');
  } catch (error) {
    await stop();
    throw error;
  }
  return harness;
}

// ---------------------------------------------------------------------------
// Requests the way the platform proxy sends them
// ---------------------------------------------------------------------------

interface Posted {
  status: number;
  retryAfter: string | null;
  body: unknown;
  ms: number;
}

interface PostOptions {
  /** Client address; sent signed in x-mcp-auth-client-ip unless signedIp is false. */
  ip?: string;
  signedIp?: boolean;
  /** Full X-Forwarded-For value. */
  forwardedFor?: string;
  /** false sends no signature at all. */
  sign?: boolean;
  /** Sign with this key instead of the container's (a wrong key). */
  key?: string;
  signal?: AbortSignal;
}

function toolCall(
  name: string,
  args: Record<string, unknown>,
  id: number
): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  };
}

const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

async function post(
  harness: Harness,
  rpc: unknown,
  opts: PostOptions = {}
): Promise<Posted> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  const identity: Record<string, string> = {};
  if (opts.ip !== undefined && opts.signedIp !== false) {
    identity['x-mcp-auth-client-ip'] = opts.ip;
    headers['x-mcp-auth-client-ip'] = opts.ip;
  }
  if (opts.forwardedFor !== undefined) {
    headers['x-forwarded-for'] = opts.forwardedFor;
  }
  if (opts.sign !== false) {
    headers['x-mcp-proxy-auth'] = signProxyRequest({
      key: opts.key ?? harness.key,
      method: 'POST',
      path: '/mcp',
      headers: identity,
    });
  }
  const began = performance.now();
  const res = await fetch(`${harness.target}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(rpc),
    signal: opts.signal,
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return {
    status: res.status,
    retryAfter: res.headers.get('retry-after'),
    body,
    ms: performance.now() - began,
  };
}

interface ToolReply {
  isError: boolean;
  text: string;
}

function toolReply(posted: Posted): ToolReply | null {
  const body = posted.body as {
    result?: { isError?: boolean; content?: { text?: string }[] };
  } | null;
  const result = body?.result;
  if (result === undefined) return null;
  return {
    isError: result.isError === true,
    text: (result.content ?? []).map((part) => part.text ?? '').join('\n'),
  };
}

function isBusy(reply: ToolReply | null): boolean {
  return reply?.isError === true && /busy/i.test(reply.text);
}

/** X-Forwarded-For as the platform proxy and Cloud Run produce it: <caller-chosen junk>, <client>, <egress>. */
function chain(ip: string, junk: string): string {
  return `${junk}, ${ip}, ${EGRESS_HOP}`;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[
    Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  ]!;
}

// ---------------------------------------------------------------------------
// peak
// ---------------------------------------------------------------------------

interface PhaseResult {
  name: string;
  multiplier: number;
  seconds: number;
  offeredPerSec: number;
  sent: number;
  httpStatus: Record<string, number>;
  ok: number;
  busy: number;
  otherToolErrors: number;
  http429Pool: number;
  http429Single: number;
  latencyMs: { p50: number; p95: number; max: number };
  upstreamAfter: UpstreamStats;
}

function isPoolAddress(ip: string): boolean {
  return ip.startsWith('160.79.104.');
}

async function runPhase(
  harness: Harness,
  name: string,
  multiplier: number,
  seconds: number,
  seed: number
): Promise<PhaseResult> {
  const rng = createRng(seed);
  const offeredPerSec = PEAK_TOOL_CALLS_PER_SEC * multiplier;
  const result: PhaseResult = {
    name,
    multiplier,
    seconds,
    offeredPerSec,
    sent: 0,
    httpStatus: {},
    ok: 0,
    busy: 0,
    otherToolErrors: 0,
    http429Pool: 0,
    http429Single: 0,
    latencyMs: { p50: 0, p95: 0, max: 0 },
    upstreamAfter: harness.mock.stats(),
  };
  const latencies: number[] = [];
  const inflight: Promise<void>[] = [];

  const fire = async (
    tool: LoadToolName,
    ip: string,
    id: number
  ): Promise<void> => {
    const junk = `198.51.100.${1 + Math.floor(rng() * 200)}`;
    const posted = await post(
      harness,
      toolCall(tool, fixtureArguments(tool), id),
      { ip, forwardedFor: chain(ip, junk) }
    );
    latencies.push(posted.ms);
    bump(result.httpStatus, posted.status);
    if (posted.status === 429) {
      if (isPoolAddress(ip)) result.http429Pool += 1;
      else result.http429Single += 1;
      return;
    }
    const reply = toolReply(posted);
    if (posted.status !== 200 || reply === null) return;
    if (!reply.isError) result.ok += 1;
    else if (isBusy(reply)) result.busy += 1;
    else result.otherToolErrors += 1;
  };

  const began = performance.now();
  let at = 0;
  for (;;) {
    at += exponentialGapMs(rng, offeredPerSec);
    if (at >= seconds * 1000) break;
    const wait = began + at - performance.now();
    if (wait > 0) await sleepMs(wait);
    result.sent += 1;
    inflight.push(fire(pickTool(rng), pickClientAddress(rng), result.sent));
  }
  await Promise.all(inflight);

  latencies.sort((a, b) => a - b);
  result.latencyMs = {
    p50: Math.round(percentile(latencies, 0.5)),
    p95: Math.round(percentile(latencies, 0.95)),
    max: Math.round(latencies[latencies.length - 1] ?? 0),
  };
  result.upstreamAfter = harness.mock.stats();
  return result;
}

function upstreamChecks(label: string, stats: UpstreamStats): Check[] {
  return [
    check(
      `${label}: upstream starts in any 1 s <= ${LIMIT_PER_SECOND}`,
      stats.max1s <= LIMIT_PER_SECOND,
      `Max upstream starts in any 1 s: ${stats.max1s} (limit ${LIMIT_PER_SECOND})`
    ),
    check(
      `${label}: upstream starts in any 60 s <= ${LIMIT_PER_MINUTE}`,
      stats.max60s <= LIMIT_PER_MINUTE,
      `Max upstream starts in any 60 s: ${stats.max60s} (limit ${LIMIT_PER_MINUTE})`
    ),
    check(
      `${label}: no upstream 429`,
      stats.served429 === 0,
      `Upstream 429 responses: ${stats.served429}`
    ),
  ];
}

async function scenarioPeak(
  args: LoadtestArgs,
  harness: Harness
): Promise<{ checks: Check[]; extra: unknown }> {
  const one = await runPhase(harness, '1x', 1, args.durationSec, 20261004);
  say(
    `peak 1x: ${one.sent} tool calls in ${one.seconds} s, ok ${one.ok}, busy ${one.busy}, HTTP ${JSON.stringify(one.httpStatus)}`
  );
  const two = await runPhase(
    harness,
    '2x',
    2,
    Math.min(60, args.durationSec),
    20261005
  );
  say(
    `peak 2x: ${two.sent} tool calls in ${two.seconds} s, ok ${two.ok}, busy ${two.busy}, HTTP ${JSON.stringify(two.httpStatus)}`
  );
  const ten = await runPhase(
    harness,
    '10x',
    10,
    Math.min(20, args.durationSec),
    20261006
  );
  say(
    `peak 10x: ${ten.sent} tool calls in ${ten.seconds} s, ok ${ten.ok}, busy ${ten.busy}, HTTP ${JSON.stringify(ten.httpStatus)}`
  );

  const shedInBand = (phase: PhaseResult): Check =>
    check(
      `${phase.name}: the excess is shed in band or by 429, never as 5xx, 401 or another tool error`,
      Object.keys(phase.httpStatus).every(
        (status) => status === '200' || status === '429'
      ) && phase.otherToolErrors === 0,
      `HTTP ${JSON.stringify(phase.httpStatus)}, other tool errors ${phase.otherToolErrors}, busy ${phase.busy}`
    );
  const checks: Check[] = [
    ...upstreamChecks('1x', one.upstreamAfter),
    check(
      '1x: no HTTP 429 for the 30 pool addresses',
      one.http429Pool === 0,
      `HTTP 429 for pool addresses: ${one.http429Pool}`
    ),
    check(
      '1x: every request answered 200 and no tool error but busy',
      Object.keys(one.httpStatus).every((status) => status === '200') &&
        one.otherToolErrors === 0,
      `HTTP ${JSON.stringify(one.httpStatus)}, other tool errors ${one.otherToolErrors}`
    ),
    ...upstreamChecks('2x', two.upstreamAfter),
    shedInBand(two),
    ...upstreamChecks('10x', ten.upstreamAfter),
    shedInBand(ten),
  ];
  return { checks, extra: { phases: [one, two, ten] } };
}

// ---------------------------------------------------------------------------
// edge
// ---------------------------------------------------------------------------

async function burst(
  harness: Harness,
  count: number,
  optsFor: (index: number) => PostOptions
): Promise<Posted[]> {
  const replies: Posted[] = [];
  for (let index = 0; index < count; index += 1) {
    replies.push(await post(harness, TOOLS_LIST, optsFor(index)));
  }
  return replies;
}

function limited(replies: Posted[]): {
  count: number;
  first: number;
  wellFormed: boolean;
} {
  let count = 0;
  let first = -1;
  let wellFormed = true;
  replies.forEach((reply, index) => {
    if (reply.status !== 429) return;
    count += 1;
    if (first === -1) first = index;
    const wait = Number(reply.retryAfter);
    const code = (reply.body as { error?: { code?: number } } | null)?.error
      ?.code;
    if (
      reply.retryAfter === null ||
      !Number.isInteger(wait) ||
      wait < 1 ||
      code !== -32000
    ) {
      wellFormed = false;
    }
  });
  return { count, first, wellFormed };
}

async function scenarioEdge(
  harness: Harness
): Promise<{ checks: Check[]; extra: unknown }> {
  const checks: Check[] = [];

  const unsigned = await post(harness, TOOLS_LIST, {
    ip: '203.0.113.60',
    sign: false,
  });
  checks.push(
    check(
      'an unsigned request gets 401',
      unsigned.status === 401,
      `status ${unsigned.status}`
    )
  );
  const wrongKey = await post(harness, TOOLS_LIST, {
    ip: '203.0.113.60',
    key: randomBytes(32).toString('hex'),
  });
  checks.push(
    check(
      'a request signed with another key gets 401',
      wrongKey.status === 401,
      `status ${wrongKey.status}`
    )
  );

  const single = await burst(harness, 60, () => ({
    ip: '203.0.113.61',
    forwardedFor: chain('203.0.113.61', '198.51.100.9'),
  }));
  const singleLimited = limited(single);
  checks.push(
    check(
      '60 rapid POSTs from one address: the first is served, the bucket then empties into 429',
      single[0]?.status === 200 &&
        singleLimited.count >= 1 &&
        singleLimited.first >= 30,
      `served first: ${single[0]?.status}, 429 count ${singleLimited.count}, first 429 at request ${singleLimited.first + 1}`
    ),
    check(
      'each 429 carries a whole-second Retry-After and the JSON-RPC error body (-32000)',
      singleLimited.count >= 1 && singleLimited.wellFormed,
      `429 count ${singleLimited.count}, well formed: ${singleLimited.wellFormed}`
    )
  );

  const pool = await burst(harness, 60, (index) => {
    const ip = poolAddress(index);
    return { ip, forwardedFor: chain(ip, '198.51.100.9') };
  });
  checks.push(
    check(
      '60 POSTs from 30 pool addresses: no 429 (one shared pool budget)',
      pool.every((reply) => reply.status === 200),
      `statuses ${JSON.stringify(Object.fromEntries([...new Set(pool.map((r) => r.status))].map((s) => [s, pool.filter((r) => r.status === s).length])))}`
    )
  );

  const forgedSigned = await burst(harness, 60, (index) => ({
    ip: '203.0.113.62',
    forwardedFor: chain('203.0.113.62', `10.${index}.${index}.${index}`),
  }));
  const forgedSignedLimited = limited(forgedSigned);
  checks.push(
    check(
      'a forged leftmost X-Forwarded-For does not change the key (signed client address)',
      forgedSignedLimited.count >= 1,
      `429 count ${forgedSignedLimited.count} of 60`
    )
  );

  const forgedFallback = await burst(harness, 60, (index) => ({
    ip: '203.0.113.63',
    signedIp: false,
    forwardedFor: chain('203.0.113.63', `10.${index}.${index}.${index}`),
  }));
  const forgedFallbackLimited = limited(forgedFallback);
  checks.push(
    check(
      'a forged leftmost X-Forwarded-For does not change the key (no signed address: counted from the right)',
      forgedFallbackLimited.count >= 1,
      `429 count ${forgedFallbackLimited.count} of 60`
    )
  );

  const fresh = await post(harness, TOOLS_LIST, {
    ip: '203.0.113.64',
    forwardedFor: chain('203.0.113.64', '198.51.100.9'),
  });
  checks.push(
    check(
      'another address is not affected by the limited ones',
      fresh.status === 200,
      `status ${fresh.status}`
    )
  );

  return {
    checks,
    extra: {
      singleAddress: singleLimited,
      forgedSigned: forgedSignedLimited,
      forgedFallback: forgedFallbackLimited,
    },
  };
}

// ---------------------------------------------------------------------------
// deadline
// ---------------------------------------------------------------------------

const STALLED_ROUTE: RouteName = 'book_times';
const STALL_MS = 30_000;

function slotsCall(id: number): unknown {
  return toolCall(
    'business_list_time_slots',
    {
      location_id: FIXTURE_LOCATION_ID,
      service_ids: [FIXTURE_SERVICE_ID],
      team_member_id: FIXTURE_TEAM_MEMBER_ID,
      date: FIXTURE_DATE,
    },
    id
  );
}

async function scenarioDeadline(
  harness: Harness
): Promise<{ checks: Check[]; extra: unknown }> {
  const checks: Check[] = [];

  // A mock that stalls the route for 30 s: the call must come back in band
  // within 26 s (the tool deadline is 25 s; the per-fetch timeout is 10 s).
  const stalled = await post(harness, slotsCall(1), { ip: '203.0.113.70' });
  const reply = toolReply(stalled);
  checks.push(
    check(
      `a route that stalls ${STALL_MS / 1000} s gets an in-band tool error within ${DEADLINE_LIMIT_MS / 1000} s`,
      stalled.status === 200 &&
        reply?.isError === true &&
        stalled.ms < DEADLINE_LIMIT_MS,
      `HTTP ${stalled.status}, isError ${reply?.isError}, took ${Math.round(stalled.ms)} ms`
    )
  );
  const afterStall = harness.mock.stats();
  checks.push(
    check(
      'the stalled call was started upstream once and not retried',
      afterStall.starts === 1,
      `upstream starts ${afterStall.starts}`
    )
  );

  // A client that hangs up after 1 s: the mock must see the request dropped,
  // and no later start may follow for it.
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 1000);
  let clientSawAbort = false;
  try {
    await post(harness, slotsCall(2), {
      ip: '203.0.113.71',
      signal: controller.signal,
    });
  } catch {
    clientSawAbort = true;
  } finally {
    clearTimeout(abortTimer);
  }
  let aborted = harness.mock.stats().aborted;
  for (let waited = 0; aborted < 1 && waited < 8000; waited += 250) {
    await sleepMs(250);
    aborted = harness.mock.stats().aborted;
  }
  const startsAtAbort = harness.mock.stats().starts;
  await sleepMs(3000);
  const finalStats = harness.mock.stats();
  checks.push(
    check(
      'a client abort after 1 s reaches the upstream call: the mock records it as aborted',
      clientSawAbort && aborted >= 1,
      `client saw abort ${clientSawAbort}, mock aborted ${aborted}`
    ),
    check(
      'no later upstream start follows the abort',
      finalStats.starts === startsAtAbort && finalStats.starts === 2,
      `starts at abort ${startsAtAbort}, 3 s later ${finalStats.starts}`
    )
  );
  return {
    checks,
    extra: {
      stalledRouteMs: Math.round(stalled.ms),
      toolText: reply?.text.slice(0, 200) ?? null,
      mock: finalStats,
    },
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

interface ScenarioOutcome {
  scenario: string;
  pass: boolean;
  checks: Check[];
  [key: string]: unknown;
}

async function runLocal(
  args: LoadtestArgs
): Promise<{ outcome: ScenarioOutcome; outDir: string }> {
  const stalls: Partial<Record<RouteName, number>> =
    args.scenario === 'deadline' ? { [STALLED_ROUTE]: STALL_MS } : {};
  const harness = await startHarness(args, stalls);
  const onSignal = (): void => {
    void harness.stop().finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const startedAt = new Date().toISOString();
  let ran: { checks: Check[]; extra: unknown };
  try {
    if (args.scenario === 'peak') ran = await scenarioPeak(args, harness);
    else if (args.scenario === 'edge') ran = await scenarioEdge(harness);
    else ran = await scenarioDeadline(harness);
  } catch (error) {
    await harness.stop();
    throw error;
  }
  const mock = harness.mock.stats();
  const container = await harness.stop();
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  return {
    outDir: harness.outDir,
    outcome: {
      scenario: args.scenario,
      pass: ran.checks.every((entry) => entry.pass),
      startedAt,
      finishedAt: new Date().toISOString(),
      commit: git(['rev-parse', '--short', 'HEAD']),
      image: harness.image,
      imageId: harness.imageId,
      checks: ran.checks,
      mock,
      container,
      ...(ran.extra as Record<string, unknown>),
    },
  };
}

async function main(argv: string[]): Promise<number> {
  let args: LoadtestArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }
  for (const note of args.notes) say(`note: ${note}`);

  if (args.scenario === 'live') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = args.out ?? join('loadtest-output', stamp);
    await mkdir(outDir, { recursive: true });
    const result = await runLive(args, {
      fetch: globalThis.fetch,
      now: () => Date.now(),
      sleep: sleepMs,
    });
    const file = join(outDir, 'results.json');
    await writeFile(
      file,
      `${JSON.stringify({ scenario: 'live', commit: git(['rev-parse', '--short', 'HEAD']), ...result }, null, 2)}\n`
    );
    say(
      result.status === 'PASS'
        ? `PASS live: ${result.requests} read-only calls in ${Math.round(result.elapsedMs / 1000)} s (${result.averageRate.toFixed(2)} a second), no busy or rejected reply (${file})`
        : `FAIL live: stopped after ${result.requests} calls: ${result.stoppedBy} (${file})`
    );
    return result.status === 'PASS' ? 0 : 1;
  }

  const { outcome, outDir } = await runLocal(args);
  const file = join(outDir, 'results.json');
  await writeFile(file, `${JSON.stringify(outcome, null, 2)}\n`);
  const failed = outcome.checks.filter((entry) => !entry.pass);
  for (const entry of outcome.checks) {
    say(`${entry.pass ? 'ok  ' : 'FAIL'} ${entry.name}: ${entry.detail}`);
  }
  say(
    outcome.pass
      ? `PASS ${args.scenario}: ${outcome.checks.length} checks passed (${file})`
      : `FAIL ${args.scenario}: ${failed.length} of ${outcome.checks.length} checks failed, first: ${failed[0]?.name ?? ''} (${file})`
  );
  return outcome.pass ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (error: unknown) => {
    process.stderr.write(
      `FAIL: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
);
