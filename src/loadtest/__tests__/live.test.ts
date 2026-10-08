import { describe, expect, it } from '@jest/globals';
import {
  LIVE_MAX_RATE_PER_SEC,
  LIVE_MIN_RATE_PER_SEC,
  LIVE_REQUEST_TIMEOUT_MS,
  UsageError,
  parseArgs,
  type LoadtestArgs,
} from '../args.js';
import { LIVE_TOOLS, runLive, type LiveDeps } from '../live.js';

// The live runner against a fake fetch and a fake clock (T-03-38): the hard
// stops, the pacing, the tool set and the refusal to run unannounced. No
// network, no real time.

const TARGET = 'https://svc.example/me';

function liveArgs(extra: string[] = []): LoadtestArgs {
  return parseArgs([
    '--scenario=live',
    `--target=${TARGET}`,
    '--confirm-announced',
    ...extra,
  ]);
}

interface Sent {
  at: number;
  url: string;
  tool: string;
  args: Record<string, unknown>;
  headers: Headers;
}

type Reply = {
  status?: number;
  body?: unknown;
  text?: string;
  /** The fake clock moves by this much while the request is in flight. */
  delayMs?: number;
  /** The fetch itself rejects. */
  fetchError?: Error;
  /** The reply arrives but reading its body rejects. */
  bodyError?: Error;
};

type TestDeps = LiveDeps & { requestSignal?: (ms: number) => AbortSignal };

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** A fake service: `reply(sent, index)` answers each request; the clock moves only on sleep. */
function fakeService(reply: (sent: Sent, index: number) => Reply) {
  let clock = 1_000_000;
  const sent: Sent[] = [];
  const sleeps: number[] = [];
  const signalRequests: number[] = [];
  const fetchSignals: (AbortSignal | null | undefined)[] = [];
  const handedOut: AbortSignal[] = [];
  const deps: TestDeps = {
    now: () => clock,
    requestSignal: (ms) => {
      signalRequests.push(ms);
      const signal = new AbortController().signal;
      handedOut.push(signal);
      return signal;
    },
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    fetch: (url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(
        typeof init?.body === 'string' ? init.body : '{}'
      ) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const entry: Sent = {
        at: clock,
        url:
          typeof url === 'string'
            ? url
            : url instanceof URL
              ? url.href
              : url.url,
        tool: payload.params.name,
        args: payload.params.arguments,
        headers: new Headers(init?.headers),
      };
      sent.push(entry);
      fetchSignals.push(init?.signal);
      const answer = reply(entry, sent.length - 1);
      clock += answer.delayMs ?? 0;
      if (answer.fetchError !== undefined) {
        return Promise.reject(answer.fetchError);
      }
      if (answer.bodyError !== undefined) {
        const failing = answer.bodyError;
        return Promise.resolve({
          status: 200,
          text: () => Promise.reject(failing),
        } as unknown as Response);
      }
      const text = answer.text ?? JSON.stringify(answer.body ?? okBody(entry));
      return Promise.resolve(
        new Response(text, { status: answer.status ?? 200 })
      );
    },
  };
  return { deps, sent, sleeps, signalRequests, fetchSignals, handedOut };
}

function result(structuredContent: unknown, isError = false, text = 'ok') {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text }], structuredContent, isError },
  };
}

function okBody(entry: Sent): unknown {
  switch (entry.tool) {
    case 'business_list_services':
      return result({ items: [{ id: 111 }] });
    case 'business_list_team_members':
      return result({ items: [{ id: 222 }] });
    case 'business_list_dates':
      return result({ items: [{ date: '2026-10-12' }] });
    default:
      return result({ items: [] });
  }
}

function refusedMessage(extra: string[]): string {
  try {
    liveArgs(extra);
  } catch (error) {
    if (error instanceof UsageError) return error.message;
    throw error;
  }
  throw new Error(`expected ${extra.join(' ')} to be refused`);
}

describe('runLive refusal', () => {
  it('sends nothing and throws when the run was not announced', async () => {
    const service = fakeService(() => ({}));
    const unannounced: LoadtestArgs = {
      ...liveArgs(),
      confirmAnnounced: false,
    };
    await expect(runLive(unannounced, service.deps)).rejects.toThrow(
      UsageError
    );
    await expect(runLive(unannounced, service.deps)).rejects.toThrow(
      '--confirm-announced'
    );
    expect(service.sent).toHaveLength(0);
  });

  it('refuses a scenario other than live', async () => {
    const service = fakeService(() => ({}));
    const peak: LoadtestArgs = { ...liveArgs(), scenario: 'peak' };
    await expect(runLive(peak, service.deps)).rejects.toThrow(UsageError);
    expect(service.sent).toHaveLength(0);
  });
});

describe('runLive target refusal (WR-59)', () => {
  it.each([
    ['a run.app host', 'https://svc-abc.a.run.app/mcp'],
    ['a query', 'https://svc.example/me?x=1'],
    ['a fragment', 'https://svc.example/me#a'],
    ['plain http on a remote host', 'http://svc.example/me'],
  ])('sends nothing and throws for %s', async (_label, target) => {
    const service = fakeService(() => ({}));
    await expect(
      runLive({ ...liveArgs(), target }, service.deps)
    ).rejects.toThrow(UsageError);
    expect(service.sent).toHaveLength(0);
  });

  it.each(['http://127.0.0.1:8080/mcp', 'http://localhost:8080/mcp'])(
    'allows plain http for the loopback target %s',
    async (target) => {
      const service = fakeService(() => ({}));
      const outcome = await runLive(
        { ...liveArgs(['--duration-sec=3']), target },
        service.deps
      );
      expect(outcome.status).toBe('PASS');
      expect(service.sent.length).toBeGreaterThan(0);
      for (const entry of service.sent) expect(entry.url).toBe(target);
    }
  );
});

describe('runLive behaviour', () => {
  it('reads only the five read-only tools, never book_check, at exactly the target URL, unsigned', async () => {
    const service = fakeService(() => ({}));
    const outcome = await runLive(
      liveArgs(['--duration-sec=20']),
      service.deps
    );
    expect(outcome.status).toBe('PASS');
    expect(outcome.stoppedBy).toBeNull();
    const tools = new Set(service.sent.map((entry) => entry.tool));
    expect([...tools].sort()).toEqual([...LIVE_TOOLS].sort());
    expect(tools.has('book_check')).toBe(false);
    for (const entry of service.sent) {
      expect(entry.url).toBe(TARGET);
      expect(entry.headers.get('x-mcp-proxy-auth')).toBeNull();
      expect(entry.headers.get('authorization')).toBeNull();
    }
  });

  it('asks about the location and passes on the ids it found', async () => {
    const service = fakeService(() => ({}));
    await runLive(
      liveArgs(['--duration-sec=10', '--location=726120']),
      service.deps
    );
    for (const entry of service.sent) {
      expect(entry.args.location_id).toBe(726120);
    }
    const slots = service.sent.find(
      (e) => e.tool === 'business_list_time_slots'
    );
    expect(slots?.args).toMatchObject({
      service_ids: [111],
      team_member_id: 222,
      date: '2026-10-12',
    });
  });

  it('never exceeds 1.35 calls a second, even when asked for more', async () => {
    const service = fakeService(() => ({}));
    const outcome = await runLive(
      liveArgs(['--duration-sec=60', '--rate=50']),
      service.deps
    );
    expect(outcome.status).toBe('PASS');
    expect(outcome.averageRate).toBeLessThanOrEqual(
      LIVE_MAX_RATE_PER_SEC + 0.05
    );
    // Any closed one-second window holds at most 2 starts at 1.35 a second.
    const times = service.sent.map((entry) => entry.at);
    for (let index = 0; index + 2 < times.length; index += 1) {
      expect(times[index + 2]! - times[index]!).toBeGreaterThan(1000);
    }
  });

  it('stops after the duration cap of 180 s however long was asked', async () => {
    const service = fakeService(() => ({}));
    const outcome = await runLive(
      liveArgs(['--duration-sec=3600', '--rate=1']),
      service.deps
    );
    expect(outcome.elapsedMs).toBeLessThanOrEqual(181_000);
    expect(outcome.requests).toBeLessThanOrEqual(181);
  });

  it.each([
    ['HTTP 401', { status: 401, text: '{}' }],
    ['HTTP 429', { status: 429, text: '{}' }],
    ['HTTP 500', { status: 500, text: '' }],
    ['HTTP 503', { status: 503, text: '' }],
    ['HTTP 403', { status: 403, text: '' }],
  ] as [string, Reply][])(
    'stops at the first %s and sends nothing more',
    async (label, answer) => {
      const service = fakeService((_sent, index) =>
        index === 2 ? answer : {}
      );
      const outcome = await runLive(liveArgs(), service.deps);
      expect(outcome.status).toBe('FAIL');
      expect(outcome.stoppedBy).toBe(label);
      expect(service.sent).toHaveLength(3);
    }
  );

  it.each([
    'The booking service is busy right now.',
    "The booking service did not accept this server's access.",
  ])('stops at the first tool error that says "%s"', async (text) => {
    const service = fakeService((_sent, index) =>
      index === 1 ? { body: result({}, true, text) } : {}
    );
    const outcome = await runLive(liveArgs(), service.deps);
    expect(outcome.status).toBe('FAIL');
    expect(outcome.stoppedBy).toContain('busy or did not accept');
    expect(service.sent).toHaveLength(2);
  });

  it('stops at a JSON-RPC error', async () => {
    const service = fakeService((_sent, index) =>
      index === 0
        ? {
            body: {
              jsonrpc: '2.0',
              id: 1,
              error: { code: -32000, message: 'x' },
            },
          }
        : {}
    );
    const outcome = await runLive(liveArgs(), service.deps);
    expect(outcome.status).toBe('FAIL');
    expect(outcome.stoppedBy).toBe('JSON-RPC error');
    expect(service.sent).toHaveLength(1);
  });

  it('stops when the location has no service to ask about', async () => {
    const service = fakeService((entry) =>
      entry.tool === 'business_list_services'
        ? { body: result({ items: [] }) }
        : {}
    );
    const outcome = await runLive(liveArgs(), service.deps);
    expect(outcome.status).toBe('FAIL');
    expect(outcome.stoppedBy).toContain('no service');
    expect(service.sent.map((entry) => entry.tool)).not.toContain(
      'business_list_dates'
    );
  });

  it('tolerates a few other tool errors and stops when they pile up', async () => {
    const service = fakeService((entry) =>
      entry.tool === 'business_get'
        ? {
            body: result(
              {},
              true,
              'No business was found for this location id.'
            ),
          }
        : {}
    );
    const outcome = await runLive(liveArgs(), service.deps);
    expect(outcome.status).toBe('FAIL');
    expect(outcome.stoppedBy).toBe('too many other tool errors');
    expect(outcome.toolErrors).toBe(6);
  });
});

describe('runLive hard bounds (WR-58, T-03-54, T-03-55)', () => {
  const INTERVAL_MS = 1000 / 1.35;

  it('does not catch up after a slow reply: starts stay at least 1/rate apart', async () => {
    const service = fakeService((_sent, index) =>
      index === 1 ? { delayMs: 5000 } : {}
    );
    const outcome = await runLive(
      liveArgs(['--duration-sec=20', '--rate=1.35']),
      service.deps
    );
    expect(outcome.status).toBe('PASS');
    const times = service.sent.map((entry) => entry.at);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(
        INTERVAL_MS - 1e-6
      );
    }
    // The next start after the slow reply is at the reply time, not earlier.
    expect(times[2]! - times[1]!).toBe(5000);
    expect(times[3]! - times[2]!).toBeGreaterThanOrEqual(INTERVAL_MS - 1e-6);
  });

  it.each([25, 30])(
    'ends within --duration-sec=%i at the minimum rate; no wait is longer than the time left',
    async (durationSec) => {
      const service = fakeService(() => ({}));
      const outcome = await runLive(
        liveArgs([`--duration-sec=${durationSec}`, '--rate=0.1']),
        service.deps
      );
      expect(outcome.status).toBe('PASS');
      expect(outcome.elapsedMs).toBeLessThanOrEqual(durationSec * 1000);
      for (const wait of service.sleeps) {
        expect(wait).toBeLessThanOrEqual(durationSec * 1000);
      }
      const lastStart = service.sent[service.sent.length - 1]!.at;
      const startedAt = service.sent[0]!.at;
      const lastSleep = service.sleeps[service.sleeps.length - 1]!;
      expect(lastStart - startedAt + lastSleep).toBeLessThanOrEqual(
        durationSec * 1000
      );
    }
  );

  it('refuses a --rate below the minimum of 0.1 and names it', () => {
    const message = refusedMessage(['--rate=0.05']);
    expect(LIVE_MIN_RATE_PER_SEC).toBe(0.1);
    expect(message).toContain(String(LIVE_MIN_RATE_PER_SEC));
    expect(message).toContain('--rate');
    expect(() => liveArgs(['--rate=0.1'])).not.toThrow();
  });

  it('gives every request a 30 s timeout signal and hands it to fetch', async () => {
    const service = fakeService(() => ({}));
    await runLive(liveArgs(['--duration-sec=10']), service.deps);
    expect(service.sent.length).toBeGreaterThan(3);
    expect(service.signalRequests).toHaveLength(service.sent.length);
    expect(LIVE_REQUEST_TIMEOUT_MS).toBe(30_000);
    for (const ms of service.signalRequests) {
      expect(ms).toBe(LIVE_REQUEST_TIMEOUT_MS);
    }
    expect(service.fetchSignals).toHaveLength(service.sent.length);
    service.fetchSignals.forEach((signal, index) => {
      expect(signal).toBe(service.handedOut[index]);
    });
  });

  it('records a fetch timeout as a FAIL with the counts, without throwing', async () => {
    const service = fakeService((_sent, index) =>
      index === 2
        ? {
            fetchError: namedError(
              'TimeoutError',
              'The operation was aborted due to timeout https://svc.example/me'
            ),
          }
        : {}
    );
    const outcome = await runLive(liveArgs(), service.deps);
    expect(outcome.status).toBe('FAIL');
    expect(outcome.stoppedBy).toBe('network error: TimeoutError');
    expect(outcome.requests).toBe(3);
    expect(service.sent).toHaveLength(3);
    // Only the error name is kept: a message can echo the URL.
    expect(JSON.stringify(outcome)).not.toContain('svc.example');
  });

  it('records a failed body read the same way, with the error name', async () => {
    const service = fakeService((_sent, index) =>
      index === 1
        ? { bodyError: namedError('SocketError', 'other side closed') }
        : {}
    );
    const outcome = await runLive(liveArgs(), service.deps);
    expect(outcome.status).toBe('FAIL');
    expect(outcome.stoppedBy).toBe('network error: SocketError');
    expect(outcome.requests).toBe(2);
    expect(outcome.httpStatuses).toEqual({ '200': 2 });
  });

  it('stops before dates and time slots when no team member was found', async () => {
    const service = fakeService((entry) =>
      entry.tool === 'business_list_team_members'
        ? { body: result({ items: [] }) }
        : {}
    );
    const outcome = await runLive(liveArgs(), service.deps);
    expect(outcome.status).toBe('FAIL');
    expect(outcome.stoppedBy).toContain('no team member');
    const tools = service.sent.map((entry) => entry.tool);
    expect(tools).not.toContain('business_list_dates');
    expect(tools).not.toContain('business_list_time_slots');
    for (const entry of service.sent) {
      expect(entry.args.team_member_id).not.toBe(0);
    }
  });
});
