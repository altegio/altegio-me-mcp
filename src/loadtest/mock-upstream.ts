import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  loadFixture,
  type FixtureResponse,
} from '../booking/__tests__/helpers/fake-fetch.js';

// A mock of the six Altegio booking routes that measures its own start rate
// (OPS-07 precision, D-03). The gate must not grade its own homework: the mock
// timestamps every request it receives, in milliseconds, and counts starts over
// closed sliding intervals of 1,000 ms and 60,000 ms, not wall-clock seconds,
// so a burst that straddles a second boundary is counted. It answers 429 itself
// when an admitted start would exceed the standard partner limits (5 a second,
// 200 a minute), so a gate that lets too much through shows up twice: in the
// maxima and in served429.
//
// The same core runs behind an HTTP server (tier 2, the real container) and
// behind an in-process fetch on the simulated clock (tier 1, CI).

/** Standard partner limits (D-03, assumption A1). */
export const LIMIT_PER_SECOND = 5;
export const LIMIT_PER_MINUTE = 200;

const SECOND_MS = 1000;
const MINUTE_MS = 60_000;

export type RouteName =
  | 'company'
  | 'book_services'
  | 'book_staff'
  | 'book_dates'
  | 'book_times'
  | 'book_check';

export interface UpstreamStats {
  /** Most starts in any closed 1,000 ms interval, refused ones included. */
  max1s: number;
  /** Most starts in any closed 60,000 ms interval, refused ones included. */
  max60s: number;
  /** Starts the mock refused with 429 because they would exceed a limit. */
  served429: number;
  /** Every request received. */
  starts: number;
  /** Requests the client dropped before the reply. */
  aborted: number;
}

/**
 * The most times that fall inside any closed interval of `windowMs` (a start at
 * 0 and one at 1,000 share a 1,000 ms interval). Input order does not matter.
 */
export function slidingMax(times: readonly number[], windowMs: number): number {
  const sorted = [...times].sort((a, b) => a - b);
  let best = 0;
  let from = 0;
  for (let to = 0; to < sorted.length; to += 1) {
    while (sorted[to]! - sorted[from]! > windowMs) from += 1;
    best = Math.max(best, to - from + 1);
  }
  return best;
}

/** Not implemented yet (RED scaffolding). */
export function slidingMaxHalfOpen(
  _times: readonly number[],
  _windowMs: number
): number {
  throw new Error('slidingMaxHalfOpen is not implemented');
}

/** Not implemented yet (RED scaffolding). */
export function smallestGap(_times: readonly number[]): number | null {
  throw new Error('smallestGap is not implemented');
}

/** How many of the ascending `times` lie within `windowMs` before `at`, `at` included. */
function countWithin(
  times: readonly number[],
  at: number,
  windowMs: number
): number {
  let count = 0;
  for (let index = times.length - 1; index >= 0; index -= 1) {
    if (times[index]! < at - windowMs) break;
    count += 1;
  }
  return count;
}

interface RouteSpec {
  name: RouteName;
  method: 'GET' | 'POST';
  pattern: RegExp;
  scenario: (match: RegExpExecArray) => string;
}

const ROUTES: readonly RouteSpec[] = [
  {
    name: 'company',
    method: 'GET',
    pattern: /^\/company\/\d+$/,
    scenario: () => 'default',
  },
  {
    name: 'book_services',
    method: 'GET',
    pattern: /^\/book_services\/\d+$/,
    scenario: () => 'default',
  },
  {
    name: 'book_staff',
    method: 'GET',
    pattern: /^\/book_staff\/\d+$/,
    scenario: () => 'default',
  },
  {
    name: 'book_dates',
    method: 'GET',
    pattern: /^\/book_dates\/\d+$/,
    scenario: () => 'default',
  },
  {
    name: 'book_times',
    method: 'GET',
    pattern: /^\/book_times\/\d+\/(\d+)\/\d{4}-\d{2}-\d{2}$/,
    scenario: (match) => (match[1] === '0' ? 'any_member' : 'named_member'),
  },
  {
    name: 'book_check',
    method: 'POST',
    pattern: /^\/book_check\/\d+$/,
    scenario: () => 'created_empty',
  },
];

const API_PREFIX = '/api/v1';

const NOT_FOUND: FixtureResponse = {
  status: 404,
  body: { success: false, data: null, meta: { message: 'Not found' } },
};

const RATE_LIMITED: FixtureResponse = {
  status: 429,
  headers: { 'X-Rate-Limit-Reset': '1' },
  body: { success: false, data: null, meta: { message: 'Too many requests' } },
};

export interface UpstreamStart {
  route: RouteName | null;
  startedAt: number;
  reply: FixtureResponse;
}

export interface UpstreamCore {
  /** Records one request start at the injected time and answers it. */
  start(method: string, path: string): UpstreamStart;
  recordAborted(): void;
  stats(): UpstreamStats;
  startTimes(): number[];
}

export function createUpstreamCore(now: () => number): UpstreamCore {
  const everyStart: number[] = [];
  const admitted: number[] = [];
  let served429 = 0;
  let aborted = 0;
  const cache = new Map<string, FixtureResponse>();

  const fixture = (route: RouteName, scenario: string): FixtureResponse => {
    const key = `${route}/${scenario}`;
    let found = cache.get(key);
    if (found === undefined) {
      found = loadFixture(route, scenario);
      cache.set(key, found);
    }
    return found;
  };

  return {
    start(method, rawPath) {
      const startedAt = now();
      everyStart.push(startedAt);
      const path = rawPath.startsWith(API_PREFIX)
        ? rawPath.slice(API_PREFIX.length)
        : rawPath;

      // Admit only a start that keeps both closed intervals within the limits.
      const wouldExceed =
        countWithin(admitted, startedAt, SECOND_MS) + 1 > LIMIT_PER_SECOND ||
        countWithin(admitted, startedAt, MINUTE_MS) + 1 > LIMIT_PER_MINUTE;
      if (wouldExceed) {
        served429 += 1;
        return { route: null, startedAt, reply: RATE_LIMITED };
      }
      admitted.push(startedAt);

      for (const spec of ROUTES) {
        if (spec.method !== method) continue;
        const match = spec.pattern.exec(path);
        if (match !== null) {
          return {
            route: spec.name,
            startedAt,
            reply: fixture(spec.name, spec.scenario(match)),
          };
        }
      }
      return { route: null, startedAt, reply: NOT_FOUND };
    },
    recordAborted() {
      aborted += 1;
    },
    startTimes() {
      throw new Error('startTimes is not implemented');
    },
    stats: () => ({
      max1s: slidingMax(everyStart, SECOND_MS),
      max60s: slidingMax(everyStart, MINUTE_MS),
      served429,
      starts: everyStart.length,
      aborted,
    }),
  };
}

function bodyText(reply: FixtureResponse): string {
  return typeof reply.body === 'string'
    ? reply.body
    : JSON.stringify(reply.body);
}

/**
 * A fetch that answers from the core without a network. The start is recorded
 * when the call begins; the reply follows after `latencyMs` of simulated time.
 * Its Response is a plain object so no stream machinery needs real ticks.
 */
export function createSimFetch(
  core: UpstreamCore,
  sleep: (ms: number) => Promise<void>,
  latencyMs = 120
): typeof fetch {
  const simFetch = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const { reply } = core.start(
      (init.method ?? 'GET').toUpperCase(),
      url.pathname
    );
    await sleep(latencyMs);
    const text = bodyText(reply);
    return {
      status: reply.status,
      headers: new Headers(reply.headers),
      text: () => Promise.resolve(text),
    } as unknown as Response;
  };
  return simFetch;
}

export interface MockUpstreamOptions {
  /** 0 picks a free port. */
  port: number;
  /** Interface to listen on; 127.0.0.1 unless a container must reach it. */
  host?: string;
  /** Clock for start timestamps; Date.now by default. */
  now?: () => number;
  /** Holds the reply of a route, in milliseconds, for the deadline scenario. */
  stallMs?: Partial<Record<RouteName, number>>;
}

export interface MockUpstream {
  /** The API base, for example http://127.0.0.1:41234/api/v1. */
  url: string;
  port: number;
  stats(): UpstreamStats;
  startTimes(): number[];
  close(): Promise<void>;
}

export async function startMockUpstream(
  opts: MockUpstreamOptions
): Promise<MockUpstream> {
  const core = createUpstreamCore(opts.now ?? Date.now);
  const stalls = opts.stallMs ?? {};
  const host = opts.host ?? '127.0.0.1';

  const server = createServer((req, res) => {
    req.resume();
    const path = new URL(req.url ?? '/', 'http://mock.invalid').pathname;
    const started = core.start(req.method ?? 'GET', path);
    let timer: NodeJS.Timeout | undefined;
    res.on('close', () => {
      if (timer !== undefined) clearTimeout(timer);
      if (!res.writableFinished) core.recordAborted();
    });
    const reply = (): void => {
      res.writeHead(started.reply.status, {
        'content-type': 'application/json',
        ...started.reply.headers,
      });
      res.end(bodyText(started.reply));
    };
    const stall = started.route === null ? 0 : (stalls[started.route] ?? 0);
    if (stall > 0) timer = setTimeout(reply, stall);
    else reply();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const shownHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  return {
    url: `http://${shownHost}:${port}${API_PREFIX}`,
    port,
    stats: () => core.stats(),
    startTimes: () => core.startTimes(),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
