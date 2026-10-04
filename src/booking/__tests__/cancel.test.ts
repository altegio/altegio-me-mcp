import { describe, expect, it } from '@jest/globals';
import { BOOKING_ROUTES, BookingClient } from '../client.js';
import { UpstreamError } from '../errors.js';
import { RequestGate } from '../gate.js';
import {
  BookingHttp,
  type GateLike,
  type UpstreamCallOptions,
} from '../http.js';
import { createFakeClock } from './helpers/fake-clock.js';
import {
  fakeFetch,
  loadFixture,
  type FakeFetch,
} from './helpers/fake-fetch.js';

// A tool call's signal reaches the gate and the fetch (WR-04, D-01): an
// aborted call stops spending upstream budget, and a call that ran out of time
// or was dropped never reads like a per-fetch timeout.

const BASE = 'https://api.alteg.io/api/v1';
const TOKEN = 'partner-token-0123456789abcdef';
const LOCATION = 722227;
const COMPANY_PATH = `/company/${LOCATION}`;

const NEVER = (): Promise<never> => new Promise<never>(() => undefined);

function upstreamThatNeverAnswers(): FakeFetch {
  return fakeFetch([
    {
      method: 'GET',
      path: COMPANY_PATH,
      // fakeFetch rejects with the signal's reason when init.signal aborts.
      reply: NEVER,
    },
  ]);
}

function send(http: BookingHttp, call: UpstreamCallOptions): Promise<unknown> {
  const { route, method } = BOOKING_ROUTES.company;
  return http.send({ method, route, path: COMPANY_PATH, ...call });
}

async function failure(promise: Promise<unknown>): Promise<UpstreamError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UpstreamError) return error;
    throw error;
  }
  throw new Error('expected an UpstreamError');
}

function causeMessage(error: UpstreamError): string {
  return error.cause instanceof Error ? error.cause.message : '';
}

describe('BookingHttp with a call signal (WR-04)', () => {
  it('throws unavailable with a cancelled cause when the signal aborts during the fetch', async () => {
    const upstream = upstreamThatNeverAnswers();
    const http = new BookingHttp({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
    });
    const controller = new AbortController();
    const pending = failure(send(http, { signal: controller.signal }));
    controller.abort(new Error('client went away'));

    const error = await pending;
    expect(error.kind).toBe('unavailable');
    expect(causeMessage(error)).toMatch(/cancelled/i);
    expect(causeMessage(error)).not.toMatch(/timed out/i);
    expect(upstream.calls).toHaveLength(1);
  });

  it('says the call ran out of time when the signal aborts with a TimeoutError', async () => {
    const upstream = upstreamThatNeverAnswers();
    const http = new BookingHttp({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
    });
    const error = await failure(
      send(http, { signal: AbortSignal.timeout(30) })
    );
    expect(error.kind).toBe('unavailable');
    expect(causeMessage(error)).toMatch(/ran out of time/i);
    expect(causeMessage(error)).not.toMatch(/timed out after/i);
  });

  it('sends nothing for a signal that is already aborted', async () => {
    const upstream = upstreamThatNeverAnswers();
    const http = new BookingHttp({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
    });
    const controller = new AbortController();
    controller.abort();

    const error = await failure(send(http, { signal: controller.signal }));
    expect(error.kind).toBe('unavailable');
    expect(upstream.calls).toEqual([]);
  });

  it('makes no inline 429 retry once the call is aborted', async () => {
    const controller = new AbortController();
    const upstream = fakeFetch([
      {
        method: 'GET',
        path: COMPANY_PATH,
        reply: () => {
          controller.abort(new Error('client went away'));
          return {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'X-Rate-Limit-Reset': '1',
            },
            body: { success: false, data: null, meta: { message: 'slow' } },
          };
        },
      },
    ]);
    const http = new BookingHttp({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
    });

    const error = await failure(send(http, { signal: controller.signal }));
    expect(error).toBeInstanceOf(UpstreamError);
    expect(upstream.calls).toHaveLength(1);
  });

  it('keeps the per-fetch timeout message when the call signal is still live', async () => {
    const upstream = upstreamThatNeverAnswers();
    const http = new BookingHttp({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
      timeoutMs: 30,
    });
    const error = await failure(
      send(http, { signal: new AbortController().signal })
    );
    expect(error.kind).toBe('unavailable');
    expect(causeMessage(error)).toBe('Altegio API call timed out after 30 ms');
  });

  it('passes the signal and the key to the gate', async () => {
    const seen: (UpstreamCallOptions | undefined)[] = [];
    const gate: GateLike = {
      run<T>(start: () => Promise<T>, opts?: UpstreamCallOptions): Promise<T> {
        seen.push(opts);
        return start();
      },
      pauseUntil: () => undefined,
    };
    const upstream = fakeFetch([
      {
        method: 'GET',
        path: COMPANY_PATH,
        reply: loadFixture('company', 'default'),
      },
    ]);
    const client = new BookingClient({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
      gate,
    });
    const controller = new AbortController();

    await client.company(LOCATION, { signal: controller.signal, key: 'k-1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.signal).toBe(controller.signal);
    expect(seen[0]?.key).toBe('k-1');
  });
});

describe('an abandoned call spends no partner budget (T-03-16)', () => {
  it('never reaches the upstream when the call leaves the gate queue before its turn', async () => {
    const clock = createFakeClock(1_700_000_000_000);
    const gate = new RequestGate({ now: clock.now, sleep: clock.sleep });
    gate.pauseUntil(clock.now() + 1000);
    const upstream = fakeFetch([
      {
        method: 'GET',
        path: COMPANY_PATH,
        reply: loadFixture('company', 'default'),
      },
    ]);
    const client = new BookingClient({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
      gate,
    });
    const controller = new AbortController();

    const first = client.company(LOCATION);
    const abandoned = failure(
      client.company(LOCATION, { signal: controller.signal })
    );
    controller.abort(new Error('client went away'));

    const error = await abandoned;
    expect(error.kind).toBe('unavailable');
    await first;
    expect(upstream.calls).toHaveLength(1);
  });
});
