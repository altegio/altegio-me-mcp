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
const USER_TOKEN = 'client-user-token-0001-abcdef';

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

  it('leaves the shared gate alone on a 429 for the caller token', async () => {
    const pauses: number[] = [];
    const upstream = fakeFetch([
      {
        method: 'GET',
        path: CALL.path,
        reply: {
          status: 429,
          headers: { 'Retry-After': '2' },
          body: { success: false, meta: { message: 'Too many requests' } },
        },
      },
    ]);
    const http = new BookingHttp({
      base: BASE,
      tokenSource: spySource(),
      fetch: upstream.fetch,
      gate: {
        run: (start) => start(),
        pauseUntil: (until) => {
          pauses.push(until);
        },
      },
    });
    const error = (await http
      .send({ ...CALL, partnerToken: CALLER_TOKEN })
      .catch((caught: unknown) => caught)) as UpstreamError;
    expect(error.kind).toBe('rate_limited');
    expect(error.retryAfterSeconds).toBe(2);
    expect(upstream.calls).toHaveLength(1);
    expect(pauses).toEqual([]);
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

// ADR 0005, D-02: a signed-in call carries the client's user token next to the
// partner token, on the two signed-in routes only.
describe('BookingHttp with the client user token', () => {
  const PLACES: UpstreamCallSpec = {
    method: 'GET',
    route: '/user/companies/yplaces',
    path: '/user/companies/yplaces',
  };

  function unchangedSource(): SecretSource & { refreshes: () => number } {
    const refresh = jest.fn(() => Promise.resolve(false));
    return {
      current: () => SERVER_TOKEN,
      known: () => [SERVER_TOKEN],
      refresh,
      refreshes: () => refresh.mock.calls.length,
    };
  }

  it('writes Bearer <partner>, User <user> and Bearer alone without a user token', async () => {
    const upstream = fakeFetch([
      {
        method: 'GET',
        path: PLACES.path,
        reply: loadFixture('user_yplaces', 'default'),
      },
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
    await http.send({ ...PLACES, userToken: USER_TOKEN });
    await http.send({
      ...PLACES,
      userToken: USER_TOKEN,
      partnerToken: CALLER_TOKEN,
    });
    await http.send(CALL);
    expect(
      upstream.calls.map((call) => call.headers.get('authorization'))
    ).toEqual([
      `Bearer ${SERVER_TOKEN}, User ${USER_TOKEN}`,
      `Bearer ${CALLER_TOKEN}, User ${USER_TOKEN}`,
      `Bearer ${SERVER_TOKEN}`,
    ]);
  });

  it('sends one request on a 401 when the server token is unchanged, and names the user', async () => {
    const source = unchangedSource();
    const upstream = fakeFetch([
      {
        method: 'GET',
        path: PLACES.path,
        reply: refusal(`User ${USER_TOKEN} is not valid`),
      },
    ]);
    const http = new BookingHttp({
      base: BASE,
      tokenSource: source,
      fetch: upstream.fetch,
    });
    const error = (await http
      .send({ ...PLACES, userToken: USER_TOKEN })
      .catch((caught: unknown) => caught)) as UpstreamError;
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.kind).toBe('unauthorized');
    expect(error.credential).toBe('user');
    expect(error.upstreamMessage).toBe('User [redacted] is not valid');
    expect(upstream.calls).toHaveLength(1);
  });

  it('sends one request on a 403 with a caller partner token and names the user', async () => {
    const source = spySource();
    const upstream = fakeFetch([
      {
        method: 'GET',
        path: PLACES.path,
        reply: { status: 403, body: { success: false, meta: {} } },
      },
    ]);
    const http = new BookingHttp({
      base: BASE,
      tokenSource: source,
      fetch: upstream.fetch,
    });
    const error = (await http
      .send({ ...PLACES, userToken: USER_TOKEN, partnerToken: CALLER_TOKEN })
      .catch((caught: unknown) => caught)) as UpstreamError;
    expect(error.credential).toBe('user');
    expect(upstream.calls).toHaveLength(1);
    expect(source.refreshes()).toBe(0);
  });

  it('keeps the same user token on the one rotation retry of the server token', async () => {
    let attempt = 0;
    let current = SERVER_TOKEN;
    const source: SecretSource = {
      current: () => current,
      known: () => [SERVER_TOKEN, current],
      refresh: () => {
        current = 'server-partner-token-0002';
        return Promise.resolve(true);
      },
    };
    const upstream = fakeFetch([
      {
        method: 'GET',
        path: PLACES.path,
        reply: () => {
          attempt += 1;
          return attempt === 1
            ? { status: 401, body: { success: false, meta: {} } }
            : loadFixture('user_yplaces', 'default');
        },
      },
    ]);
    const http = new BookingHttp({
      base: BASE,
      tokenSource: source,
      fetch: upstream.fetch,
    });
    await http.send({ ...PLACES, userToken: USER_TOKEN });
    expect(
      upstream.calls.map((call) => call.headers.get('authorization'))
    ).toEqual([
      `Bearer ${SERVER_TOKEN}, User ${USER_TOKEN}`,
      `Bearer server-partner-token-0002, User ${USER_TOKEN}`,
    ]);
  });

  it('words a refused sign-in as the client sign-in, with a next action to reconnect', () => {
    const error = toToolError(
      new UpstreamError('unauthorized', PLACES.route, {
        status: 401,
        credential: 'user',
      })
    ) as Error & { nextAction: string };
    expect(error.message).toBe(
      "The booking service did not accept the client's sign-in for this connection."
    );
    expect(error.nextAction).toContain('connect again');
    expect(error.nextAction).toContain('do not retry');
  });
});

describe('BookingClient.myPlaces', () => {
  function client(reply: FakeReply) {
    const upstream = fakeFetch([
      { method: 'GET', path: '/user/companies/yplaces', reply },
    ]);
    return {
      upstream,
      booking: new BookingClient({
        base: BASE,
        tokenSource: spySource(),
        fetch: upstream.fetch,
      }),
    };
  }

  it.each([undefined, ''])(
    'sends nothing without a user token (%p)',
    async (userToken) => {
      const { upstream, booking } = client(
        loadFixture('user_yplaces', 'default')
      );
      await expect(
        booking.myPlaces(userToken === undefined ? {} : { userToken })
      ).rejects.toThrow(TypeError);
      expect(upstream.calls).toEqual([]);
    }
  );

  it('maps the recorded places and keeps only an https logo', async () => {
    const { booking } = client({
      status: 200,
      body: {
        success: true,
        meta: [],
        data: [
          {
            id: 7,
            title: 'Plain title',
            public_title: '',
            address: 'Somewhere 1',
            logo: 'http://assets.example.invalid/logo.png',
            active_status: { is_active: true, is_enabled_gca: false },
          },
          {
            id: 8,
            title: 'T',
            public_title: 'Public',
            logo: 'https://assets.example.invalid/logo.png',
            active: 0,
          },
          { id: 9, title: null, logo: 'not a url', active_status: [] },
        ],
      },
    });
    const places = await booking.myPlaces({ userToken: USER_TOKEN });
    expect(places).toEqual([
      {
        locationId: 7,
        name: 'Plain title',
        address: 'Somewhere 1',
        city: null,
        logoUrl: null,
        onlineBooking: true,
        lastVisit: null,
      },
      {
        locationId: 8,
        name: 'Public',
        address: null,
        city: null,
        logoUrl: 'https://assets.example.invalid/logo.png',
        onlineBooking: false,
        lastVisit: null,
      },
      {
        locationId: 9,
        name: null,
        address: null,
        city: null,
        logoUrl: null,
        onlineBooking: false,
        lastVisit: null,
      },
    ]);
  });

  it('treats a body that is not a list as contract drift', async () => {
    const { booking } = client({
      status: 200,
      body: { success: true, data: { places: [] }, meta: [] },
    });
    await expect(
      booking.myPlaces({ userToken: USER_TOKEN })
    ).rejects.toMatchObject({ kind: 'contract_drift' });
  });
});
