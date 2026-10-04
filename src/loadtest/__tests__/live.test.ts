import { describe, expect, it } from '@jest/globals';
import {
  LIVE_MAX_RATE_PER_SEC,
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

type Reply = { status?: number; body?: unknown; text?: string };

/** A fake service: `reply(sent, index)` answers each request; the clock moves only on sleep. */
function fakeService(reply: (sent: Sent, index: number) => Reply) {
  let clock = 1_000_000;
  const sent: Sent[] = [];
  const sleeps: number[] = [];
  const deps: LiveDeps = {
    now: () => clock,
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
      const answer = reply(entry, sent.length - 1);
      const text = answer.text ?? JSON.stringify(answer.body ?? okBody(entry));
      return Promise.resolve(
        new Response(text, { status: answer.status ?? 200 })
      );
    },
  };
  return { deps, sent, sleeps };
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

describe('runLive behaviour', () => {
  it('reads only the five read-only tools, never book_check, through <target>/mcp, unsigned', async () => {
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
      expect(entry.url).toBe(`${TARGET}/mcp`);
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

  it('never exceeds 2.7 calls a second, even when asked for more', async () => {
    const service = fakeService(() => ({}));
    const outcome = await runLive(
      liveArgs(['--duration-sec=60', '--rate=50']),
      service.deps
    );
    expect(outcome.status).toBe('PASS');
    expect(outcome.averageRate).toBeLessThanOrEqual(
      LIVE_MAX_RATE_PER_SEC + 0.05
    );
    // Any one-second window holds at most 3 starts at 2.7 a second.
    const times = service.sent.map((entry) => entry.at);
    for (let index = 0; index + 3 < times.length; index += 1) {
      expect(times[index + 3]! - times[index]!).toBeGreaterThan(1000);
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
