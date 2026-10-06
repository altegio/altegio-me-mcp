import { describe, expect, it, jest } from '@jest/globals';
import type { SecretSource } from '../../config/secret-source.js';
import { toToolError } from '../../tools/upstream-errors.js';
import { BookingClient, PARTNER_PROBE } from '../client.js';
import { UpstreamError } from '../errors.js';
import { BookingHttp, type UpstreamCallSpec } from '../http.js';
import {
  fakeFetch,
  loadFixture,
  type FakeReply,
} from './helpers/fake-fetch.js';

// ADR 0004 D3: a call may carry the caller's own partner token. It replaces
// ours, a refusal of it is never retried with ours, and it is scrubbed from
// upstream messages.

const BASE = 'https://api.alteg.io/api/v1';
const SERVER_TOKEN = 'server-partner-token-0001';
const CALLER_TOKEN = 'caller-partner-token-0001';

const CALL: UpstreamCallSpec = {
  method: 'GET',
  route: '/company/{location_id}',
  path: '/company/722227',
};

function spySource(): SecretSource & { refreshes: () => number } {
  const refresh = jest.fn(() => Promise.resolve(true));
  return {
    current: () => SERVER_TOKEN,
    known: () => [SERVER_TOKEN],
    refresh,
    refreshes: () => refresh.mock.calls.length,
  };
}

function refusal(message: string): FakeReply {
  return {
    status: 401,
    body: { success: false, data: null, meta: { message } },
  };
}

describe('BookingHttp with the caller partner token', () => {
  it('sends the caller token instead of the server token', async () => {
    const upstream = fakeFetch([
      {
        method: 'GET',
        path: CALL.path,
        reply: loadFixture('company', 'default'),
      },
    ]);
    const http = new BookingHttp({
      base: BASE,
      tokenSource: spySource(),
      fetch: upstream.fetch,
    });
    await http.send({ ...CALL, partnerToken: CALLER_TOKEN });
    expect(
      upstream.calls.map((call) => call.headers.get('authorization'))
    ).toEqual([`Bearer ${CALLER_TOKEN}`]);
  });

  it('never retries a refused caller token with the server token', async () => {
    const source = spySource();
    const upstream = fakeFetch([
      {
        method: 'GET',
        path: CALL.path,
        reply: refusal(`Partner ${CALLER_TOKEN} is blocked`),
      },
    ]);
    const http = new BookingHttp({
      base: BASE,
      tokenSource: source,
      fetch: upstream.fetch,
    });
    const error = await http
      .send({ ...CALL, partnerToken: CALLER_TOKEN })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UpstreamError);
    const upstreamError = error as UpstreamError;
    expect(upstreamError.kind).toBe('unauthorized');
    expect(upstreamError.credential).toBe('caller');
    expect(upstreamError.upstreamMessage).toBe('Partner [redacted] is blocked');
    expect(upstream.calls).toHaveLength(1);
    expect(source.refreshes()).toBe(0);
  });

  it('keeps the rotation retry for the server token', async () => {
    const source = spySource();
    const upstream = fakeFetch([
      { method: 'GET', path: CALL.path, reply: refusal('Unauthorized') },
    ]);
    const http = new BookingHttp({
      base: BASE,
      tokenSource: source,
      fetch: upstream.fetch,
    });
    const error = (await http
      .send(CALL)
      .catch((caught: unknown) => caught)) as UpstreamError;
    expect(error.credential).toBe('server');
    expect(source.refreshes()).toBe(1);
  });

  it('words a refused caller token as the connection token, not our access', () => {
    const caller = toToolError(
      new UpstreamError('unauthorized', CALL.route, {
        status: 401,
        credential: 'caller',
      })
    );
    const server = toToolError(
      new UpstreamError('unauthorized', CALL.route, { status: 401 })
    );
    expect(caller.message).toContain("this connection's Altegio partner token");
    expect(server.message).not.toContain('partner token');
  });
});

describe('BookingClient.probePartnerToken', () => {
  function client(reply: FakeReply | null) {
    const upstream = fakeFetch(
      reply === null
        ? []
        : [{ method: PARTNER_PROBE.method, path: PARTNER_PROBE.route, reply }]
    );
    return {
      upstream,
      booking: new BookingClient({
        base: BASE,
        tokenSource: spySource(),
        fetch: upstream.fetch,
      }),
    };
  }

  it('asks for one entry of the business list with the probed token', async () => {
    const { upstream, booking } = client({
      status: 200,
      body: { success: true, data: [], meta: {} },
    });
    expect(await booking.probePartnerToken(CALLER_TOKEN)).toBe('valid');
    const [call] = upstream.calls;
    expect(call?.url.searchParams.get('count')).toBe('1');
    expect(call?.url.searchParams.get('page')).toBe('1');
    expect(call?.headers.get('authorization')).toBe(`Bearer ${CALLER_TOKEN}`);
  });

  it.each([401, 403])('says invalid for %i', async (status) => {
    const { booking } = client({ status, body: { success: false, meta: {} } });
    expect(await booking.probePartnerToken(CALLER_TOKEN)).toBe('invalid');
  });

  it.each([404, 500, 503])('says unavailable for %i', async (status) => {
    const { booking } = client({ status, body: { success: false, meta: {} } });
    expect(await booking.probePartnerToken(CALLER_TOKEN)).toBe('unavailable');
  });

  it('says unavailable when the network fails', async () => {
    const booking = new BookingClient({
      base: BASE,
      tokenSource: spySource(),
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    expect(await booking.probePartnerToken(CALLER_TOKEN)).toBe('unavailable');
  });
});
