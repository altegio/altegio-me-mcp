import { describe, expect, it } from '@jest/globals';
import { BOOKING_ROUTES, BookingClient } from '../client.js';
import { UpstreamError, type UpstreamErrorKind } from '../errors.js';
import { ALTEGIO_ACCEPT, BookingHttp } from '../http.js';
import {
  fakeFetch,
  loadFixture,
  type FakeReply,
  type FixtureResponse,
} from './helpers/fake-fetch.js';

// Contract of the typed booking client against the company route (BAPI-01,
// BAPI-03): what goes on the wire, and how every way a call can end maps to
// one UpstreamError kind. Upstream answers come from the company fixture;
// status-only cases use small inline responses.

const BASE = 'https://api.alteg.io/api/v1';
const TOKEN = 'partner-token-0123456789abcdef';
const LOCATION = 722227;
const COMPANY_PATH = `/company/${LOCATION}`;
const COMPANY_URL = `${BASE}${COMPANY_PATH}?forBooking=1&showBookforms=1`;
const COMPANY_ROUTE = '/company/{location_id}';

function clientFor(
  reply: FakeReply,
  options: { base?: string; timeoutMs?: number } = {}
): { client: BookingClient; upstream: ReturnType<typeof fakeFetch> } {
  const upstream = fakeFetch([{ method: 'GET', path: COMPANY_PATH, reply }]);
  const client = new BookingClient({
    base: options.base ?? BASE,
    token: TOKEN,
    fetch: upstream.fetch,
    timeoutMs: options.timeoutMs,
  });
  return { client, upstream };
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

function companyWithId(id: number): FixtureResponse {
  const fixture = loadFixture('company', 'default');
  const body = structuredClone(fixture.body) as { data: { id: number } };
  body.data.id = id;
  return { ...fixture, body };
}

describe('company request', () => {
  it('sends one GET with the v2 Accept header and the partner token, and no body', async () => {
    const { client, upstream } = clientFor(loadFixture('company', 'default'));
    const card = await client.company(LOCATION);

    expect(card.locationId).toBe(LOCATION);
    expect(upstream.unmatched).toEqual([]);
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0];
    expect(call?.method).toBe('GET');
    expect(call?.url.toString()).toBe(COMPANY_URL);
    expect(call?.headers.get('accept')).toBe(ALTEGIO_ACCEPT);
    expect(call?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(call?.headers.has('content-type')).toBe(false);
    expect(call?.body).toBeNull();
    // The token travels only in the Authorization header.
    expect(call?.url.toString()).not.toContain(TOKEN);
  });

  it('builds the same URL from a base with a trailing slash', async () => {
    const { client, upstream } = clientFor(loadFixture('company', 'default'), {
      base: `${BASE}/`,
    });
    await client.company(LOCATION);
    expect(upstream.calls[0]?.url.toString()).toBe(COMPANY_URL);
  });

  it('does not follow upstream redirects', async () => {
    let redirect: RequestInit['redirect'];
    const client = new BookingClient({
      base: BASE,
      token: TOKEN,
      fetch: (_input, init) => {
        redirect = init?.redirect;
        return Promise.resolve(
          new Response(JSON.stringify(loadFixture('company', 'default').body), {
            status: 200,
          })
        );
      },
    });
    await client.company(LOCATION);
    expect(redirect).toBe('manual');
  });

  it('parses the fixture into a business card', async () => {
    const { client } = clientFor(loadFixture('company', 'default'));
    expect(await client.company(LOCATION)).toEqual({
      locationId: 722227,
      name: 'Demo Beauty Studio',
      category: 'Beauty salon',
      address: '12 Example Street',
      city: 'Limassol',
      country: 'Cyprus',
      phone: null,
      website: 'https://demo-beauty.example',
      timeZoneName: 'Asia/Nicosia',
      utcOffsetHours: 3,
      currency: 'EUR',
      widgetActive: true,
      phoneConfirmation: true,
      anyTeamMemberAllowed: true,
      paymentPolicyType: 'forbidden',
      nextFreeSlot: null,
      bookingForms: [
        {
          id: 1463903,
          title: 'Online booking',
          url: 'https://n1463903.alteg.io/',
          isDefault: true,
        },
      ],
      bookingFormUrl: 'https://n1463903.alteg.io/',
    });
  });
});

describe('upstream status mapping (BAPI-01)', () => {
  it.each<[string, string, UpstreamErrorKind, number]>([
    ['400', 'bad_request', 'bad_request', 400],
    ['401', 'unauthorized', 'unauthorized', 401],
    ['403', 'forbidden', 'unauthorized', 403],
    ['404', 'not_found', 'not_found', 404],
    ['429', 'rate_limited', 'rate_limited', 429],
    ['500', 'server_error', 'unavailable', 500],
  ])('maps status %s to its kind', async (_status, scenario, kind, status) => {
    const { client } = clientFor(loadFixture('company', scenario));
    const error = await upstreamError(client.company(LOCATION));
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.route).toBe(COMPANY_ROUTE);
    expect(error.codes).toEqual([]);
  });

  it('maps 422 to rejected with the numeric meta.errors codes', async () => {
    const { client } = clientFor(loadFixture('company', 'rejected'));
    const error = await upstreamError(client.company(LOCATION));
    expect(error.kind).toBe('rejected');
    expect(error.status).toBe(422);
    expect(error.codes).toEqual([433, 436]);
  });

  it('maps 429 to rate_limited with the X-Rate-Limit-Reset wait (BAPI-02)', async () => {
    const { client, upstream } = clientFor(
      loadFixture('company', 'rate_limited')
    );
    const error = await upstreamError(client.company(LOCATION));
    expect(error.kind).toBe('rate_limited');
    expect(error.retryAfterSeconds).toBe(7);
    // 7 seconds is above the inline-retry limit, so nothing is retried.
    expect(upstream.calls).toHaveLength(1);
  });

  it.each([500, 502, 503])(
    'maps status %i to unavailable with that status',
    async (status) => {
      const { client } = clientFor({ status, body: '' });
      const error = await upstreamError(client.company(LOCATION));
      expect(error.kind).toBe('unavailable');
      expect(error.status).toBe(status);
    }
  );

  it.each([302, 418])(
    'maps the unexpected status %i to contract_drift',
    async (status) => {
      const { client } = clientFor({ status, body: '' });
      const error = await upstreamError(client.company(LOCATION));
      expect(error.kind).toBe('contract_drift');
      expect(error.status).toBe(status);
    }
  );
});

describe('2xx bodies', () => {
  it('maps a 200 with an HTML body to contract_drift', async () => {
    const { client } = clientFor(loadFixture('company', 'html'));
    const error = await upstreamError(client.company(LOCATION));
    expect(error.kind).toBe('contract_drift');
    expect(error.status).toBe(200);
  });

  it('maps a 200 whose data lacks id to contract_drift', async () => {
    const { client } = clientFor(loadFixture('company', 'no_id'));
    const error = await upstreamError(client.company(LOCATION));
    expect(error.kind).toBe('contract_drift');
  });

  it('maps a 200 with a JSON null body to contract_drift', async () => {
    const { client } = clientFor({ status: 200, body: 'null' });
    const error = await upstreamError(client.company(LOCATION));
    expect(error.kind).toBe('contract_drift');
  });

  it('gives data null for an empty 2xx body at the http layer', async () => {
    const upstream = fakeFetch([
      {
        method: 'GET',
        path: COMPANY_PATH,
        reply: loadFixture('company', 'empty'),
      },
    ]);
    const http = new BookingHttp({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
    });
    const reply = await http.send({
      method: 'GET',
      route: COMPANY_ROUTE,
      path: COMPANY_PATH,
    });
    expect(reply).toEqual({ status: 200, data: null });
  });
});

describe('network failure and timeout', () => {
  it('maps a rejected fetch to unavailable with status null', async () => {
    const client = new BookingClient({
      base: BASE,
      token: TOKEN,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    const error = await upstreamError(client.company(LOCATION));
    expect(error.kind).toBe('unavailable');
    expect(error.status).toBeNull();
  });

  it('maps a call that never settles to unavailable after the timeout', async () => {
    const { client } = clientFor(() => new Promise<FixtureResponse>(() => {}), {
      timeoutMs: 50,
    });
    const started = Date.now();
    const error = await upstreamError(client.company(LOCATION));
    expect(error.kind).toBe('unavailable');
    expect(error.status).toBeNull();
    expect(String((error.cause as Error | undefined)?.message)).toMatch(
      /timed out after 50 ms/
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('upstream text and the partner token (WR-04, SEC-03)', () => {
  it('scrubs the token from meta.message before storing it', async () => {
    const { client } = clientFor(loadFixture('company', 'token_echo'));
    const error = await upstreamError(client.company(LOCATION));
    expect(error.kind).toBe('unauthorized');
    expect(error.upstreamMessage).toContain('[redacted]');
    expect(error.upstreamMessage).not.toContain(TOKEN);
  });

  it('keeps meta.message out of the error message', async () => {
    const { client } = clientFor(loadFixture('company', 'unauthorized'));
    const error = await upstreamError(client.company(LOCATION));
    expect(error.upstreamMessage).toBe('No authorization data specified');
    expect(error.message).not.toContain('authorization data');
    expect(error.message).toBe(
      'Altegio API error unauthorized on /company/{location_id}'
    );
  });

  it('stores no upstream message for a body without meta.message', async () => {
    const { client } = clientFor({ status: 503, body: '<html>busy</html>' });
    const error = await upstreamError(client.company(LOCATION));
    expect(error.upstreamMessage).toBeNull();
  });
});

describe('location id guard (T-02-14)', () => {
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2])(
    'rejects %p with a TypeError and makes no request',
    async (locationId) => {
      const { client, upstream } = clientFor(loadFixture('company', 'default'));
      await expect(client.company(locationId)).rejects.toThrow(TypeError);
      expect(upstream.calls).toHaveLength(0);
    }
  );
});

describe('route table (D-01)', () => {
  it('is frozen and holds exactly the six documented routes', () => {
    expect(Object.isFrozen(BOOKING_ROUTES)).toBe(true);
    for (const entry of Object.values(BOOKING_ROUTES)) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(
      Object.values(BOOKING_ROUTES)
        .map((entry) => `${entry.method} ${entry.route}`)
        .sort()
    ).toEqual(
      [
        'GET /company/{location_id}',
        'GET /book_services/{location_id}',
        'GET /book_staff/{location_id}',
        'GET /book_dates/{location_id}',
        'GET /book_times/{location_id}/{team_member_id}/{date}',
        'POST /book_check/{location_id}',
      ].sort()
    );
  });
});

describe('concurrency (edge BAPI-01)', () => {
  it('resolves parallel calls for different locations to their own cards', async () => {
    const upstream = fakeFetch([
      { method: 'GET', path: '/company/722227', reply: companyWithId(722227) },
      { method: 'GET', path: '/company/722228', reply: companyWithId(722228) },
    ]);
    const client = new BookingClient({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
    });
    const [first, second] = await Promise.all([
      client.company(722227),
      client.company(722228),
    ]);
    expect(first.locationId).toBe(722227);
    expect(second.locationId).toBe(722228);
    expect(upstream.calls).toHaveLength(2);
  });

  it('times out one call without affecting a parallel call that succeeds', async () => {
    const upstream = fakeFetch([
      { method: 'GET', path: '/company/722227', reply: companyWithId(722227) },
      {
        method: 'GET',
        path: '/company/722228',
        reply: () => new Promise<FixtureResponse>(() => {}),
      },
    ]);
    const client = new BookingClient({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
      timeoutMs: 50,
    });
    const [ok, hung] = await Promise.allSettled([
      client.company(722227),
      client.company(722228),
    ]);
    expect(ok.status).toBe('fulfilled');
    expect(ok.status === 'fulfilled' ? ok.value.locationId : null).toBe(722227);
    expect(hung.status).toBe('rejected');
    const reason: unknown = hung.status === 'rejected' ? hung.reason : null;
    expect(reason).toBeInstanceOf(UpstreamError);
    expect((reason as UpstreamError).kind).toBe('unavailable');
    expect((reason as UpstreamError).status).toBeNull();
  });
});
