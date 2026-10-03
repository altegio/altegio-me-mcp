import { describe, expect, it } from '@jest/globals';
import { businessGet } from '../../tools/business.js';
import type { ToolInvocation } from '../../tools/factory.js';
import { BOOKING_ROUTES, BookingClient } from '../client.js';
import { UpstreamError } from '../errors.js';
import { GateSaturatedError, RequestGate } from '../gate.js';
import { BookingHttp } from '../http.js';
import { createFakeClock, type FakeClock } from './helpers/fake-clock.js';
import {
  fakeFetch,
  loadFixture,
  type FakeReply,
  type FixtureResponse,
} from './helpers/fake-fetch.js';

// The request gate wired into the booking client (BAPI-02, D-03): every
// upstream start goes through one gate, a 429 pauses it for the advised time,
// a short wait is retried once inside the same call, and a busy upstream
// reaches the user as an in-band error that names the wait.

const BASE = 'https://api.alteg.io/api/v1';
const TOKEN = 'partner-token-0123456789abcdef';
const LOCATION = 722227;
const COMPANY_PATH = `/company/${LOCATION}`;
const COMPANY_ROUTE = BOOKING_ROUTES.company.route;
const CHECK_PATH = `/book_check/${LOCATION}`;

const OK = loadFixture('company', 'default');

function rateLimited(headers: Record<string, string> = {}): FixtureResponse {
  return {
    status: 429,
    headers: { 'content-type': 'application/json', ...headers },
    body: {
      success: false,
      data: null,
      meta: { message: 'Too many requests' },
    },
  };
}

/** Replies in order (the last one repeats) and records each start time. */
function inSequence(
  clock: FakeClock,
  starts: number[],
  replies: readonly FixtureResponse[]
): FakeReply {
  let next = 0;
  return () => {
    starts.push(clock.now());
    const reply = replies[Math.min(next, replies.length - 1)]!;
    next += 1;
    return reply;
  };
}

interface Setup {
  clock: FakeClock;
  gate: RequestGate;
  client: BookingClient;
  calls: () => number;
  starts: number[];
}

function setup(replies: readonly FixtureResponse[]): Setup {
  const clock = createFakeClock();
  const gate = new RequestGate({ now: clock.now, sleep: clock.sleep });
  const starts: number[] = [];
  const upstream = fakeFetch([
    {
      method: 'GET',
      path: COMPANY_PATH,
      reply: inSequence(clock, starts, replies),
    },
  ]);
  const client = new BookingClient({
    base: BASE,
    token: TOKEN,
    fetch: upstream.fetch,
    gate,
    now: clock.now,
  });
  return { clock, gate, client, calls: () => upstream.calls.length, starts };
}

async function upstreamError(
  promise: Promise<unknown>
): Promise<UpstreamError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UpstreamError) return error;
    throw error;
  }
  throw new Error('expected the call to fail with an UpstreamError');
}

function textOf(invocation: ToolInvocation): string {
  return invocation.result.content.map((part) => part.text).join('\n');
}

describe('429 handling in the booking client (BAPI-02)', () => {
  it('retries once after a 2-second X-Rate-Limit-Reset and returns the card', async () => {
    const { client, calls, starts } = setup([
      rateLimited({ 'x-rate-limit-reset': '2' }),
      OK,
    ]);
    const card = await client.company(LOCATION);
    expect(card.locationId).toBe(LOCATION);
    expect(calls()).toBe(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(2000);
  });

  it('does not retry a 30-second reset, and turns away the next caller during the pause without a fetch', async () => {
    const { client, calls } = setup([
      rateLimited({ 'x-rate-limit-reset': '30' }),
      OK,
    ]);
    const first = await upstreamError(client.company(LOCATION));
    expect(first.kind).toBe('rate_limited');
    expect(first.status).toBe(429);
    expect(first.retryAfterSeconds).toBe(30);
    expect(first.route).toBe(COMPANY_ROUTE);
    expect(calls()).toBe(1);

    const second = await upstreamError(client.company(LOCATION));
    expect(second.kind).toBe('rate_limited');
    expect(second.status).toBeNull();
    expect(second.retryAfterSeconds).toBe(30);
    expect(calls()).toBe(1);
  });

  it('gives rate_limited after exactly two fetches when the retry is limited too', async () => {
    const { client, calls } = setup([
      rateLimited({ 'x-rate-limit-reset': '1' }),
      rateLimited({ 'x-rate-limit-reset': '1' }),
      OK,
    ]);
    const error = await upstreamError(client.company(LOCATION));
    expect(error.kind).toBe('rate_limited');
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(1);
    expect(calls()).toBe(2);
  });

  it('waits the 2-second default before the one retry when the 429 has no rate headers', async () => {
    const { client, calls, starts } = setup([rateLimited(), OK]);
    await client.company(LOCATION);
    expect(calls()).toBe(2);
    expect(starts[1]! - starts[0]!).toBe(2000);
  });

  it('does not retry an HTTP-date Retry-After 5 seconds ahead and reports 5 seconds', async () => {
    const clock = createFakeClock();
    const at = new Date(clock.now() + 5000).toUTCString();
    const { client, calls } = setup([rateLimited({ 'retry-after': at }), OK]);
    const error = await upstreamError(client.company(LOCATION));
    expect(error.kind).toBe('rate_limited');
    expect(error.retryAfterSeconds).toBe(5);
    expect(calls()).toBe(1);
  });

  it('maps a gate rejection to rate_limited with the gate wait and no status', async () => {
    const { client, clock, gate, calls } = setup([OK]);
    gate.pauseUntil(clock.now() + 20_000);
    const error = await upstreamError(client.company(LOCATION));
    expect(error.kind).toBe('rate_limited');
    expect(error.status).toBeNull();
    expect(error.retryAfterSeconds).toBe(20);
    expect(error.cause).toBeInstanceOf(GateSaturatedError);
    expect(calls()).toBe(0);
  });

  it('never retries a status other than 429', async () => {
    const { client, calls } = setup([{ status: 503, body: '' }, OK]);
    const error = await upstreamError(client.company(LOCATION));
    expect(error.kind).toBe('unavailable');
    expect(calls()).toBe(1);
  });

  it('pauses the shared gate after a 429, so the next caller waits for the advised time', async () => {
    const { client, calls, starts } = setup([
      rateLimited({ 'x-rate-limit-reset': '5' }),
      OK,
    ]);
    await upstreamError(client.company(LOCATION));
    await client.company(LOCATION);
    expect(calls()).toBe(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(5000);
  });

  it('retries the book_check POST the same way, since a 429 was not processed', async () => {
    const clock = createFakeClock();
    const gate = new RequestGate({ now: clock.now, sleep: clock.sleep });
    const starts: number[] = [];
    const upstream = fakeFetch([
      {
        method: 'POST',
        path: CHECK_PATH,
        reply: inSequence(clock, starts, [
          rateLimited({ 'x-rate-limit-reset': '1' }),
          { status: 201, body: { success: true, data: null, meta: [] } },
        ]),
      },
    ]);
    const http = new BookingHttp({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
      gate,
      now: clock.now,
    });
    const body = { appointments: [{ id: 1, services: [2], staff_id: 0 }] };
    const reply = await http.send({
      method: 'POST',
      route: BOOKING_ROUTES.check.route,
      path: CHECK_PATH,
      body,
    });
    expect(reply.status).toBe(201);
    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls.map((call) => call.method)).toEqual(['POST', 'POST']);
    expect(upstream.calls[1]!.body).toBe(JSON.stringify(body));
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1000);
  });
});

describe('business_get through the shared gate (BAPI-02, ROADMAP criterion 5)', () => {
  function sharedClient(): {
    clock: FakeClock;
    client: BookingClient;
    starts: number[];
  } {
    const clock = createFakeClock();
    const gate = new RequestGate({ now: clock.now, sleep: clock.sleep });
    const starts: number[] = [];
    const upstream = fakeFetch([
      {
        method: 'GET',
        path: COMPANY_PATH,
        reply: inSequence(clock, starts, [OK]),
      },
    ]);
    const client = new BookingClient({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
      gate,
      now: clock.now,
    });
    return { clock, client, starts };
  }

  function invokeMany(
    client: BookingClient,
    count: number
  ): Promise<ToolInvocation[]> {
    return Promise.all(
      Array.from({ length: count }, () =>
        businessGet.invoke({ location_id: LOCATION }, { booking: client })
      )
    );
  }

  it('serves a burst of 30 concurrent calls with upstream starts at least 250 ms apart', async () => {
    const { client, starts } = sharedClient();
    const results = await invokeMany(client, 30);

    expect(results.every((result) => result.outcome === 'ok')).toBe(true);
    expect(starts).toHaveLength(30);
    for (let index = 1; index < starts.length; index += 1) {
      expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(250);
    }
  });

  it('turns calls beyond the queue bound away at once with the busy error and a whole-second wait', async () => {
    const { client, starts } = sharedClient();
    const results = await invokeMany(client, 60);

    const ok = results.filter((result) => result.outcome === 'ok');
    const busy = results.filter((result) => result.result.isError === true);
    expect(ok.length + busy.length).toBe(60);
    expect(ok.length).toBeGreaterThanOrEqual(40);
    expect(busy.length).toBeGreaterThanOrEqual(1);
    for (const result of busy) {
      const text = textOf(result);
      expect(text.startsWith('The booking service is busy right now.')).toBe(
        true
      );
      expect(text).toMatch(
        /Next: wait [1-9]\d* seconds, then repeat the same call\.$/
      );
    }
    expect(starts).toHaveLength(ok.length);
  });

  it('names the advised wait in the business_get error after a long 429', async () => {
    const { client } = setup([rateLimited({ 'x-rate-limit-reset': '30' })]);
    const result = await businessGet.invoke(
      { location_id: LOCATION },
      { booking: client }
    );
    expect(result.result.isError).toBe(true);
    const text = textOf(result);
    expect(text.startsWith('The booking service is busy right now.')).toBe(
      true
    );
    expect(text).toContain('Next: wait 30 seconds, then repeat the same call.');
  });
});
