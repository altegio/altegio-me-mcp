import { describe, expect, it } from '@jest/globals';
import {
  BOOKING_ROUTES,
  BookingClient,
  CANCEL_HASH_SEGMENT,
  CLIENT_WRITE_ROUTES,
  USER_ROUTES,
} from '../client.js';
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
      rules: {
        cancelAllowed: true,
        cancelBeforeSeconds: 7200,
        moveAllowed: true,
        moveBeforeSeconds: 7200,
      },
    });
  });

  it('reads no rule where the card states none', async () => {
    const fixture = loadFixture('company', 'no_forms');
    const { client } = clientFor(fixture);
    expect((await client.company(LOCATION)).rules).toEqual({
      cancelAllowed: null,
      cancelBeforeSeconds: null,
      moveAllowed: null,
      moveBeforeSeconds: null,
    });
  });
});

describe('company utc offset (IN-05)', () => {
  function companyWithTimezone(timezone: unknown): FixtureResponse {
    const fixture = loadFixture('company', 'default');
    const body = structuredClone(fixture.body) as {
      data: { timezone: unknown };
    };
    body.data.timezone = timezone;
    return { ...fixture, body };
  }

  it.each<[unknown, number]>([
    [3, 3],
    ['3', 3],
    ['5.5', 5.5],
    ['-14', -14],
    ['14', 14],
    [-12, -12],
  ])('reads %j as %d', async (timezone, expected) => {
    const { client } = clientFor(companyWithTimezone(timezone));
    expect((await client.company(LOCATION)).utcOffsetHours).toBe(expected);
  });

  it.each<[unknown]>([
    ['0x10'],
    ['1e3'],
    ['15'],
    ['-15'],
    [''],
    ['  '],
    [15],
    [-14.5],
    [null],
  ])('reads %j as null', async (timezone) => {
    const { client } = clientFor(companyWithTimezone(timezone));
    expect((await client.company(LOCATION)).utcOffsetHours).toBeNull();
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

describe('signed-in route table (D-01, D-02)', () => {
  it('is frozen and holds exactly the places, records and profile routes', () => {
    expect(Object.isFrozen(USER_ROUTES)).toBe(true);
    for (const entry of Object.values(USER_ROUTES)) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(
      Object.values(USER_ROUTES)
        .map((entry) => `${entry.method} ${entry.route}`)
        .sort()
    ).toEqual([
      'GET /booking/user/data',
      'GET /user/companies/yplaces',
      'GET /user/records',
    ]);
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

// GET /book_services and GET /book_staff (DISC-02, DISC-03, BAPI-03). The
// fixtures follow the backend facts in 02-RESEARCH (real keys seance_length
// and sex, PHP empty arrays, numeric strings); plan 02-09 replaces them with
// live recordings.

const SERVICES_PATH = `/book_services/${LOCATION}`;
const STAFF_PATH = `/book_staff/${LOCATION}`;
const SLOT = '2026-10-05T14:00:00+03:00';

function clientWith(routes: readonly { path: string; reply: FakeReply }[]): {
  client: BookingClient;
  upstream: ReturnType<typeof fakeFetch>;
} {
  const upstream = fakeFetch(
    routes.map((route) => ({ method: 'GET' as const, ...route }))
  );
  const client = new BookingClient({
    base: BASE,
    token: TOKEN,
    fetch: upstream.fetch,
  });
  return { client, upstream };
}

function servicesClient(scenario: string) {
  return clientWith([
    { path: SERVICES_PATH, reply: loadFixture('book_services', scenario) },
  ]);
}

function staffClient(scenario: string) {
  return clientWith([
    { path: STAFF_PATH, reply: loadFixture('book_staff', scenario) },
  ]);
}

describe('services request (book_services)', () => {
  it('sends one GET /book_services/{location_id} without a query when no filter is given', async () => {
    const { client, upstream } = servicesClient('default');
    await client.services(LOCATION);
    expect(upstream.unmatched).toEqual([]);
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0];
    expect(call?.method).toBe('GET');
    expect(call?.url.toString()).toBe(`${BASE}${SERVICES_PATH}`);
    expect(call?.headers.get('accept')).toBe(ALTEGIO_ACCEPT);
    expect(call?.body).toBeNull();
  });

  it('parses the default fixture into the catalog, in upstream order', async () => {
    const { client } = servicesClient('default');
    expect(await client.services(LOCATION)).toEqual({
      services: [
        {
          id: 10303530,
          title: "Women's haircut",
          categoryId: 7,
          priceMin: 0,
          priceMax: 0,
          durationSeconds: null,
          prepaid: 'forbidden',
          membershipOnly: false,
        },
        {
          id: 10303531,
          title: 'Manicure',
          categoryId: 8,
          priceMin: 1500,
          priceMax: 1500,
          durationSeconds: null,
          prepaid: 'forbidden',
          membershipOnly: false,
        },
        {
          id: 10303532,
          title: 'Hair colouring',
          categoryId: 7,
          priceMin: 2000,
          priceMax: 4500,
          durationSeconds: null,
          prepaid: 'required',
          membershipOnly: false,
        },
        {
          id: 10303533,
          title: 'Массаж спины 💆',
          categoryId: 9,
          priceMin: 3000,
          priceMax: 3500,
          durationSeconds: null,
          prepaid: 'allowed',
          membershipOnly: false,
        },
        {
          id: 10303534,
          title: 'Consultation',
          categoryId: 7,
          priceMin: 500,
          priceMax: 500,
          durationSeconds: null,
          prepaid: 'forbidden',
          membershipOnly: false,
        },
        {
          id: 10303535,
          title: 'Consultation',
          categoryId: 8,
          priceMin: 700,
          priceMax: 700,
          durationSeconds: null,
          prepaid: 'forbidden',
          membershipOnly: false,
        },
        {
          id: 10303536,
          title: 'Brow tint',
          categoryId: 9,
          priceMin: 12.5,
          priceMax: 12.5,
          durationSeconds: null,
          prepaid: 'forbidden',
          membershipOnly: false,
        },
      ],
      categories: [
        { id: 7, title: 'Hair' },
        { id: 8, title: 'Nails' },
        { id: 9, title: 'Massage & spa' },
      ],
    });
  });

  it('sends staff_id, datetime, then one service_ids[] per id in the order given (edge BAPI-03 ordering)', async () => {
    const { client, upstream } = servicesClient('by_member');
    await client.services(LOCATION, {
      teamMemberId: 2098145,
      datetime: SLOT,
      serviceIds: [3, 1, 2],
    });
    const url = upstream.calls[0]?.url;
    expect(url?.pathname).toBe(`/api/v1${SERVICES_PATH}`);
    expect([...(url?.searchParams.keys() ?? [])]).toEqual([
      'staff_id',
      'datetime',
      'service_ids[]',
      'service_ids[]',
      'service_ids[]',
    ]);
    expect(url?.searchParams.get('staff_id')).toBe('2098145');
    expect(url?.searchParams.getAll('service_ids[]')).toEqual(['3', '1', '2']);
  });

  it("percent-encodes the '+' of the datetime offset so it arrives intact", async () => {
    const { client, upstream } = servicesClient('by_member');
    await client.services(LOCATION, { datetime: SLOT });
    const url = upstream.calls[0]?.url;
    expect(url?.search).toBe('?datetime=2026-10-05T14%3A00%3A00%2B03%3A00');
    expect(url?.searchParams.get('datetime')).toBe(SLOT);
  });

  it('keeps durations in seconds, maps prepaid slugs, converts numeric strings and drops inactive services (by_member)', async () => {
    const { client } = servicesClient('by_member');
    const catalog = await client.services(LOCATION, { teamMemberId: 2098145 });
    expect(catalog.services).toEqual([
      {
        id: 10303530,
        title: "Women's haircut",
        categoryId: 7,
        priceMin: 1500,
        priceMax: 2500,
        durationSeconds: 3600,
        prepaid: 'required',
        membershipOnly: false,
      },
      {
        id: 10303532,
        title: 'Hair colouring',
        categoryId: 7,
        priceMin: 2000,
        priceMax: 4500,
        durationSeconds: 3630,
        prepaid: 'allowed',
        membershipOnly: false,
      },
      {
        id: 10303531,
        title: 'Manicure',
        categoryId: 8,
        priceMin: 1500,
        priceMax: 1500,
        durationSeconds: 2700,
        prepaid: 'forbidden',
        membershipOnly: false,
      },
      {
        id: 10303537,
        title: 'Gift consultation',
        categoryId: 7,
        priceMin: 0,
        priceMax: 0,
        durationSeconds: 1800,
        prepaid: null,
        membershipOnly: false,
      },
    ]);
    expect(catalog.services.map((service) => service.id)).not.toContain(
      10303538
    );
  });

  it('parses the empty scenario (services [], category [], events [])', async () => {
    const { client } = servicesClient('empty');
    expect(await client.services(LOCATION)).toEqual({
      services: [],
      categories: [],
    });
  });

  it('maps the 422 for a past datetime to rejected', async () => {
    const { client } = servicesClient('past_datetime');
    const error = await upstreamError(
      client.services(LOCATION, { datetime: '2020-01-01T10:00:00+03:00' })
    );
    expect(error.kind).toBe('rejected');
    expect(error.status).toBe(422);
    expect(error.route).toBe(BOOKING_ROUTES.services.route);
  });

  it('maps data that is not a services object to contract_drift', async () => {
    const { client } = clientWith([
      {
        path: SERVICES_PATH,
        reply: { status: 200, body: { success: true, data: null, meta: [] } },
      },
    ]);
    const error = await upstreamError(client.services(LOCATION));
    expect(error.kind).toBe('contract_drift');
    expect(error.route).toBe(BOOKING_ROUTES.services.route);
  });

  it.each<[string, number, Parameters<BookingClient['services']>[1]]>([
    ['location id 0', 0, undefined],
    ['location id 1.5', 1.5, undefined],
    ['team member id 0', LOCATION, { teamMemberId: 0 }],
    ['team member id 2.5', LOCATION, { teamMemberId: 2.5 }],
    ['service id 1.5', LOCATION, { serviceIds: [1, 1.5] }],
    ['service id -1', LOCATION, { serviceIds: [-1] }],
    ['an unsafe service id', LOCATION, { serviceIds: [2 ** 53] }],
    [
      'a datetime that is not a slot datetime',
      LOCATION,
      { datetime: 'tomorrow 14:00' },
    ],
  ])(
    'rejects %s with a TypeError before any request',
    async (_case, location, filter) => {
      const { client, upstream } = servicesClient('default');
      await expect(client.services(location, filter)).rejects.toThrow(
        TypeError
      );
      expect(upstream.calls).toHaveLength(0);
    }
  );
});

describe('team members request (book_staff)', () => {
  it('sends one GET /book_staff/{location_id} without a query when no filter is given', async () => {
    const { client, upstream } = staffClient('default');
    await client.teamMembers(LOCATION);
    expect(upstream.unmatched).toEqual([]);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.url.toString()).toBe(`${BASE}${STAFF_PATH}`);
  });

  it('parses the default fixture, in upstream order, keeping bookable false on the domain object', async () => {
    const { client } = staffClient('default');
    expect(await client.teamMembers(LOCATION)).toEqual([
      {
        id: 2098145,
        name: 'Anna Smith',
        specialization: 'Senior stylist',
        positionTitle: 'Stylist',
        bookable: true,
        rating: 4.8,
        nextFreeDate: '2026-10-05',
      },
      {
        id: 2098146,
        name: 'Maria Lopez',
        specialization: 'Nail artist',
        positionTitle: null,
        bookable: true,
        rating: 5,
        nextFreeDate: '2026-10-06',
      },
      {
        id: 2098147,
        name: 'Olga Ivanova',
        specialization: 'Massage therapist',
        positionTitle: 'Therapist',
        bookable: false,
        rating: 4.9,
        nextFreeDate: null,
      },
      {
        id: 2098148,
        name: 'Anna Smith',
        specialization: 'Colourist',
        positionTitle: 'Colourist',
        bookable: true,
        rating: 4.5,
        nextFreeDate: null,
      },
      {
        // show_rating 0: the business hides the rating in its widget.
        id: 2098149,
        name: 'Ivan Petrov',
        specialization: null,
        positionTitle: 'Stylist',
        bookable: true,
        rating: null,
        nextFreeDate: 'next week',
      },
    ]);
  });

  it('sends datetime, then one service_ids[] per id in the order given (edge BAPI-03 ordering)', async () => {
    const { client, upstream } = staffClient('default');
    await client.teamMembers(LOCATION, {
      serviceIds: [10303530, 10303531],
      datetime: SLOT,
    });
    const url = upstream.calls[0]?.url;
    expect([...(url?.searchParams.keys() ?? [])]).toEqual([
      'datetime',
      'service_ids[]',
      'service_ids[]',
    ]);
    expect(url?.searchParams.getAll('service_ids[]')).toEqual([
      '10303530',
      '10303531',
    ]);
    expect(url?.searchParams.get('datetime')).toBe(SLOT);
    expect(url?.search).toContain('%2B03%3A00');
  });

  it('parses the empty scenario to no team members', async () => {
    const { client } = staffClient('empty');
    expect(await client.teamMembers(LOCATION)).toEqual([]);
  });

  it('maps the 422 for a past datetime to rejected', async () => {
    const { client } = staffClient('past_datetime');
    const error = await upstreamError(
      client.teamMembers(LOCATION, { datetime: '2020-01-01T10:00:00+03:00' })
    );
    expect(error.kind).toBe('rejected');
    expect(error.status).toBe(422);
    expect(error.route).toBe(BOOKING_ROUTES.teamMembers.route);
  });

  it('maps data that is not an array to contract_drift', async () => {
    const { client } = clientWith([
      {
        path: STAFF_PATH,
        reply: { status: 200, body: { success: true, data: {}, meta: [] } },
      },
    ]);
    const error = await upstreamError(client.teamMembers(LOCATION));
    expect(error.kind).toBe('contract_drift');
  });

  it.each<[string, number, Parameters<BookingClient['teamMembers']>[1]]>([
    ['location id 1.5', 1.5, undefined],
    ['location id -3', -3, undefined],
    ['service id 0', LOCATION, { serviceIds: [0] }],
    ['service id 2.5', LOCATION, { serviceIds: [2.5] }],
    [
      'a datetime that is not a slot datetime',
      LOCATION,
      { datetime: '2026-10-05 14:00' },
    ],
  ])(
    'rejects %s with a TypeError before any request',
    async (_case, location, filter) => {
      const { client, upstream } = staffClient('default');
      await expect(client.teamMembers(location, filter)).rejects.toThrow(
        TypeError
      );
      expect(upstream.calls).toHaveLength(0);
    }
  );
});

// GET /book_dates and GET /book_times (DISC-04, DISC-05, BAPI-03). The
// fixtures follow the backend facts in 02-RESEARCH (booking_days keyed by
// month or a PHP [], time as G:i, datetime as ISO 8601 with a colon offset);
// plan 02-09 replaces them with live recordings.

const DATES_PATH = `/book_dates/${LOCATION}`;
const DATE = '2026-10-05';
const ANY_MEMBER_TIMES_PATH = `/book_times/${LOCATION}/0/${DATE}`;
const NAMED_MEMBER_TIMES_PATH = `/book_times/${LOCATION}/2098145/${DATE}`;

function datesClient(scenario: string) {
  return clientWith([
    { path: DATES_PATH, reply: loadFixture('book_dates', scenario) },
  ]);
}

function timesClient(scenario: string, path = ANY_MEMBER_TIMES_PATH) {
  return clientWith([{ path, reply: loadFixture('book_times', scenario) }]);
}

describe('dates request (book_dates)', () => {
  it('sends one GET /book_dates/{location_id} without a query when no filter is given', async () => {
    const { client, upstream } = datesClient('default');
    await client.dates(LOCATION);
    expect(upstream.unmatched).toEqual([]);
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0];
    expect(call?.method).toBe('GET');
    expect(call?.url.toString()).toBe(`${BASE}${DATES_PATH}`);
    expect(call?.headers.get('accept')).toBe(ALTEGIO_ACCEPT);
    expect(call?.body).toBeNull();
  });

  it('sends staff_id, date_from, date_to, then one service_ids[] per id (edge BAPI-03 ordering)', async () => {
    const { client, upstream } = datesClient('default');
    await client.dates(LOCATION, {
      serviceIds: [10303530, 10303531],
      teamMemberId: 2098145,
      dateFrom: '2026-10-05',
      dateTo: '2026-10-19',
    });
    const url = upstream.calls[0]?.url;
    expect(url?.pathname).toBe(`/api/v1${DATES_PATH}`);
    expect([...(url?.searchParams.keys() ?? [])]).toEqual([
      'staff_id',
      'date_from',
      'date_to',
      'service_ids[]',
      'service_ids[]',
    ]);
    expect(url?.searchParams.get('staff_id')).toBe('2098145');
    expect(url?.searchParams.get('date_from')).toBe('2026-10-05');
    expect(url?.searchParams.get('date_to')).toBe('2026-10-19');
    expect(url?.searchParams.getAll('service_ids[]')).toEqual([
      '10303530',
      '10303531',
    ]);
  });

  it('sends no staff_id for any team member (team member id 0)', async () => {
    const { client, upstream } = datesClient('default');
    await client.dates(LOCATION, { teamMemberId: 0, serviceIds: [10303530] });
    const url = upstream.calls[0]?.url;
    expect(url?.searchParams.has('staff_id')).toBe(false);
    expect([...(url?.searchParams.keys() ?? [])]).toEqual(['service_ids[]']);
  });

  it('returns booking_dates as given, never the month-keyed booking_days', async () => {
    const { client } = datesClient('default');
    expect(await client.dates(LOCATION)).toEqual([
      '2026-10-19',
      '2026-10-05',
      '2026-10-06',
      '2026-10-05',
    ]);
  });

  it('parses the empty scenario, where booking_days arrives as a PHP []', async () => {
    const { client } = datesClient('empty');
    expect(await client.dates(LOCATION)).toEqual([]);
  });

  it('maps the 422 for a past date to rejected', async () => {
    const { client } = datesClient('past_date');
    const error = await upstreamError(
      client.dates(LOCATION, { dateFrom: '2020-01-01', dateTo: '2020-01-02' })
    );
    expect(error.kind).toBe('rejected');
    expect(error.status).toBe(422);
    expect(error.route).toBe(BOOKING_ROUTES.dates.route);
  });

  it('maps a booking date that is not YYYY-MM-DD to contract_drift', async () => {
    const { client } = clientWith([
      {
        path: DATES_PATH,
        reply: {
          status: 200,
          body: {
            success: true,
            data: { booking_dates: ['5.10.2026'], booking_days: [] },
            meta: [],
          },
        },
      },
    ]);
    const error = await upstreamError(client.dates(LOCATION));
    expect(error.kind).toBe('contract_drift');
    expect(error.route).toBe(BOOKING_ROUTES.dates.route);
  });

  it.each<[string, number, Parameters<BookingClient['dates']>[1]]>([
    ['location id 0', 0, undefined],
    ['team member id -1', LOCATION, { teamMemberId: -1 }],
    ['team member id 1.5', LOCATION, { teamMemberId: 1.5 }],
    ['service id 0', LOCATION, { serviceIds: [0] }],
    ['date_from 2026-1-5', LOCATION, { dateFrom: '2026-1-5' }],
    ['date_to 2026-02-30', LOCATION, { dateTo: '2026-02-30' }],
    ['date_from with a path suffix', LOCATION, { dateFrom: '2026-10-05/..' }],
  ])(
    'rejects %s with a TypeError before any request',
    async (_case, location, filter) => {
      const { client, upstream } = datesClient('default');
      await expect(client.dates(location, filter)).rejects.toThrow(TypeError);
      expect(upstream.calls).toHaveLength(0);
    }
  );
});

describe('datetime filters are calendar-checked before any request (WR-01)', () => {
  it.each(['2026-13-45T99:99:99+99:99', '2026-02-31T10:00:00+03:00'])(
    'services and teamMembers reject %s with a TypeError and make no call',
    async (datetime) => {
      const { client, upstream } = clientWith([
        {
          path: SERVICES_PATH,
          reply: loadFixture('book_services', 'default'),
        },
        { path: STAFF_PATH, reply: loadFixture('book_staff', 'default') },
      ]);
      await expect(client.services(LOCATION, { datetime })).rejects.toThrow(
        TypeError
      );
      await expect(client.teamMembers(LOCATION, { datetime })).rejects.toThrow(
        TypeError
      );
      expect(upstream.calls).toHaveLength(0);
    }
  );

  it('still sends a real slot datetime unchanged', async () => {
    const { client, upstream } = servicesClient('default');
    await client.services(LOCATION, { datetime: '2028-02-29T10:00:00+03:00' });
    expect(upstream.calls[0]?.url.searchParams.get('datetime')).toBe(
      '2028-02-29T10:00:00+03:00'
    );
  });
});

describe('time slots request (book_times)', () => {
  it('sends GET /book_times/{location_id}/0/{date} for any team member, with service_ids[]', async () => {
    const { client, upstream } = timesClient('any_member');
    await client.timeSlots(LOCATION, 0, DATE, [10303530]);
    expect(upstream.unmatched).toEqual([]);
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0];
    expect(call?.method).toBe('GET');
    expect(call?.url.toString()).toBe(
      `${BASE}${ANY_MEMBER_TIMES_PATH}?service_ids%5B%5D=10303530`
    );
    expect(call?.url.pathname).toBe(`/api/v1/book_times/722227/0/2026-10-05`);
    expect(call?.url.searchParams.getAll('service_ids[]')).toEqual([
      '10303530',
    ]);
    expect(call?.body).toBeNull();
  });

  it('puts a named team member in the path', async () => {
    const { client, upstream } = timesClient(
      'named_member',
      NAMED_MEMBER_TIMES_PATH
    );
    await client.timeSlots(LOCATION, 2098145, DATE, [10303530, 10303531]);
    expect(upstream.unmatched).toEqual([]);
    expect(upstream.calls[0]?.url.pathname).toBe(
      `/api/v1${NAMED_MEMBER_TIMES_PATH}`
    );
    expect(upstream.calls[0]?.url.searchParams.getAll('service_ids[]')).toEqual(
      ['10303530', '10303531']
    );
  });

  it('keeps time and datetime exactly as the API wrote them, in upstream order', async () => {
    const { client } = timesClient('any_member');
    expect(await client.timeSlots(LOCATION, 0, DATE, [10303530])).toEqual([
      {
        time: '14:00',
        datetime: '2026-10-05T14:00:00+03:00',
        durationSeconds: 2700,
        totalSeconds: 2700,
      },
      {
        time: '9:30',
        datetime: '2026-10-05T09:30:00+03:00',
        durationSeconds: 3600,
        totalSeconds: 3600,
      },
      {
        time: '10:01',
        datetime: '2026-10-05T10:01:00+03:00',
        durationSeconds: 3600,
        totalSeconds: 3630,
      },
      {
        time: '10:00',
        datetime: '2026-10-05T10:00:00+03:00',
        durationSeconds: 3600,
        totalSeconds: 3600,
      },
      {
        time: '9:30',
        datetime: '2026-10-05T09:30:00+03:00',
        durationSeconds: 3600,
        totalSeconds: 3600,
      },
    ]);
  });

  it('maps a null seance_length and sum_length to null', async () => {
    const { client } = timesClient('named_member', NAMED_MEMBER_TIMES_PATH);
    const slots = await client.timeSlots(LOCATION, 2098145, DATE, [10303530]);
    expect(slots[1]).toEqual({
      time: '16:30',
      datetime: '2026-10-05T16:30:00+03:00',
      durationSeconds: null,
      totalSeconds: null,
    });
  });

  it('parses the empty scenario to no slots', async () => {
    const { client } = timesClient('empty');
    expect(await client.timeSlots(LOCATION, 0, DATE, [10303530])).toEqual([]);
  });

  it("maps a slot datetime that is not ISO 8601 to contract_drift (drift: '2026-10-05 09:30')", async () => {
    const { client } = timesClient('drift');
    const error = await upstreamError(
      client.timeSlots(LOCATION, 0, DATE, [10303530])
    );
    expect(error.kind).toBe('contract_drift');
    expect(error.route).toBe(BOOKING_ROUTES.timeSlots.route);
  });

  it('maps a slot datetime with an hour out of range to contract_drift', async () => {
    const { client } = clientWith([
      {
        path: ANY_MEMBER_TIMES_PATH,
        reply: {
          status: 200,
          body: {
            success: true,
            data: [
              {
                time: '25:00',
                seance_length: 3600,
                sum_length: 3600,
                datetime: '2026-10-05T25:00:00+03:00',
              },
            ],
            meta: [],
          },
        },
      },
    ]);
    const error = await upstreamError(
      client.timeSlots(LOCATION, 0, DATE, [10303530])
    );
    expect(error.kind).toBe('contract_drift');
  });

  it('maps the 422 for a past date to rejected', async () => {
    const { client } = clientWith([
      {
        path: `/book_times/${LOCATION}/0/2020-01-01`,
        reply: loadFixture('book_times', 'past_date'),
      },
    ]);
    const error = await upstreamError(
      client.timeSlots(LOCATION, 0, '2020-01-01', [10303530])
    );
    expect(error.kind).toBe('rejected');
    expect(error.status).toBe(422);
    expect(error.route).toBe(BOOKING_ROUTES.timeSlots.route);
  });

  it.each<[string, number, number, string, number[]]>([
    ['the date 2026-1-5', LOCATION, 0, '2026-1-5', [1]],
    ['the date 2026-02-30', LOCATION, 0, '2026-02-30', [1]],
    ['the date 2026-13-01', LOCATION, 0, '2026-13-01', [1]],
    ['a date with a path suffix', LOCATION, 0, '2026-10-05/../x', [1]],
    ['a negative team member id', LOCATION, -1, DATE, [1]],
    ['team member id 1.5', LOCATION, 1.5, DATE, [1]],
    ['location id 0', 0, 0, DATE, [1]],
    ['an empty service list', LOCATION, 0, DATE, []],
    ['service id 0', LOCATION, 0, DATE, [0]],
  ])(
    'rejects %s with a TypeError before any request',
    async (_case, location, member, date, serviceIds) => {
      const { client, upstream } = timesClient('any_member');
      await expect(
        client.timeSlots(location, member, date, serviceIds)
      ).rejects.toThrow(TypeError);
      expect(upstream.calls).toHaveLength(0);
    }
  );
});

const CHECK_PATH = `/book_check/${LOCATION}`;

function checkClient(reply: FakeReply): {
  client: BookingClient;
  upstream: ReturnType<typeof fakeFetch>;
} {
  const upstream = fakeFetch([{ method: 'POST', path: CHECK_PATH, reply }]);
  const client = new BookingClient({
    base: BASE,
    token: TOKEN,
    fetch: upstream.fetch,
  });
  return { client, upstream };
}

describe('check request (book_check, the validation route)', () => {
  it('sends one POST with exactly one appointment carrying all four keys', async () => {
    const { client, upstream } = checkClient(
      loadFixture('book_check', 'created_empty')
    );
    await client.check(LOCATION, {
      serviceIds: [10303530, 10303531],
      teamMemberId: 0,
      datetime: SLOT,
    });
    expect(upstream.unmatched).toEqual([]);
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url.toString()).toBe(`${BASE}${CHECK_PATH}`);
    expect(call?.url.search).toBe('');
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.headers.get('accept')).toBe(ALTEGIO_ACCEPT);
    expect(call?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(call?.body).toBe(
      '{"appointments":[{"id":1,"services":[10303530,10303531],"staff_id":0,"datetime":"2026-10-05T14:00:00+03:00"}]}'
    );
  });

  it('sends a named team member as staff_id and the services in the given order', async () => {
    const { client, upstream } = checkClient(
      loadFixture('book_check', 'created_empty')
    );
    await client.check(LOCATION, {
      serviceIds: [10303531, 10303530],
      teamMemberId: 2098145,
      datetime: SLOT,
    });
    expect(JSON.parse(upstream.calls[0]?.body ?? 'null')).toEqual({
      appointments: [
        {
          id: 1,
          services: [10303531, 10303530],
          staff_id: 2098145,
          datetime: SLOT,
        },
      ],
    });
  });

  it("sends the datetime '2026-10-05T14:00:00+0300' byte-identical (edge BOOK-01 encoding)", async () => {
    const { client, upstream } = checkClient(
      loadFixture('book_check', 'created_empty')
    );
    await client.check(LOCATION, {
      serviceIds: [10303530],
      teamMemberId: 0,
      datetime: '2026-10-05T14:00:00+0300',
    });
    expect(upstream.calls[0]?.body).toContain(
      '"datetime":"2026-10-05T14:00:00+0300"'
    );
  });

  it('resolves on a 201 with an empty body (edge BOOK-01 empty)', async () => {
    const { client } = checkClient(loadFixture('book_check', 'created_empty'));
    await expect(
      client.check(LOCATION, {
        serviceIds: [10303530],
        teamMemberId: 0,
        datetime: SLOT,
      })
    ).resolves.toBeUndefined();
  });

  it('resolves on a 201 with a JSON envelope', async () => {
    const { client } = checkClient(loadFixture('book_check', 'created_json'));
    await expect(
      client.check(LOCATION, {
        serviceIds: [10303530],
        teamMemberId: 0,
        datetime: SLOT,
      })
    ).resolves.toBeUndefined();
  });

  it('rejects a 200 as contract_drift: only 201 means bookable', async () => {
    const { client } = checkClient(loadFixture('book_check', 'ok_200'));
    const error = await upstreamError(
      client.check(LOCATION, {
        serviceIds: [10303530],
        teamMemberId: 0,
        datetime: SLOT,
      })
    );
    expect(error.kind).toBe('contract_drift');
    expect(error.status).toBe(200);
    expect(error.route).toBe(BOOKING_ROUTES.check.route);
  });

  it.each<[string, number[]]>([
    ['taken_433', [433]],
    ['no_member_436', [436]],
    ['not_enough_time_437', [437]],
    ['service_438', [438]],
    ['taken_and_service_433_438', [433, 438]],
  ])(
    'rejects the 422 %s as rejected with its codes',
    async (scenario, codes) => {
      const { client } = checkClient(loadFixture('book_check', scenario));
      const error = await upstreamError(
        client.check(LOCATION, {
          serviceIds: [10303530],
          teamMemberId: 0,
          datetime: SLOT,
        })
      );
      expect(error.kind).toBe('rejected');
      expect(error.status).toBe(422);
      expect(error.codes).toEqual(codes);
      expect(error.route).toBe(BOOKING_ROUTES.check.route);
    }
  );

  it('rejects a 404 as not_found', async () => {
    const { client } = checkClient(loadFixture('book_check', 'not_found_404'));
    const error = await upstreamError(
      client.check(LOCATION, {
        serviceIds: [10303530],
        teamMemberId: 0,
        datetime: SLOT,
      })
    );
    expect(error.kind).toBe('not_found');
  });

  it('rejects a 503 as unavailable', async () => {
    const { client } = checkClient(
      loadFixture('book_check', 'unavailable_503')
    );
    const error = await upstreamError(
      client.check(LOCATION, {
        serviceIds: [10303530],
        teamMemberId: 0,
        datetime: SLOT,
      })
    );
    expect(error.kind).toBe('unavailable');
  });

  it('resolves after one retry when a 429 with a short wait comes first', async () => {
    const replies: FixtureResponse[] = [
      {
        status: 429,
        headers: { 'x-rate-limit-reset': '1' },
        body: { success: false, data: null, meta: { message: 'Too many' } },
      },
      loadFixture('book_check', 'created_empty'),
    ];
    const { client, upstream } = checkClient(
      () => replies.shift() ?? { status: 599, body: '' }
    );
    await expect(
      client.check(LOCATION, {
        serviceIds: [10303530],
        teamMemberId: 0,
        datetime: SLOT,
      })
    ).resolves.toBeUndefined();
    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls[1]?.body).toBe(upstream.calls[0]?.body);
  });

  it.each<[string, number, number[], number, string]>([
    ['an empty service list', LOCATION, [], 0, SLOT],
    ['service id 1.5', LOCATION, [1.5], 0, SLOT],
    ['service id 0', LOCATION, [0], 0, SLOT],
    ['a negative team member id', LOCATION, [1], -1, SLOT],
    ['team member id 1.5', LOCATION, [1], 1.5, SLOT],
    ['location id 0', 0, [1], 0, SLOT],
    ["the datetime '2026-10-05 14:00'", LOCATION, [1], 0, '2026-10-05 14:00'],
    ['an empty datetime', LOCATION, [1], 0, ''],
    [
      'a day that does not exist',
      LOCATION,
      [1],
      0,
      '2026-02-31T10:00:00+03:00',
    ],
    ['an out-of-range datetime', LOCATION, [1], 0, '2026-13-45T99:99:99+99:99'],
  ])(
    'rejects %s with a TypeError before any request',
    async (_case, location, serviceIds, teamMemberId, datetime) => {
      const { client, upstream } = checkClient(
        loadFixture('book_check', 'created_empty')
      );
      await expect(
        client.check(location, { serviceIds, teamMemberId, datetime })
      ).rejects.toThrow(TypeError);
      expect(upstream.calls).toHaveLength(0);
    }
  );
});

describe('user records request (GET /user/records)', () => {
  const USER_TOKEN = 'client-user-token-0001-abcdef';

  function recordsClient(reply: FakeReply) {
    const upstream = fakeFetch([
      { method: 'GET', path: '/user/records', reply },
    ]);
    const client = new BookingClient({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
    });
    return { client, upstream };
  }

  it('sends exactly GET /user/records with Accept v2 and both tokens, and no query', async () => {
    const { client, upstream } = recordsClient(
      loadFixture('user_records', 'default')
    );
    await client.myRecords({ userToken: USER_TOKEN });
    expect(upstream.calls).toHaveLength(1);
    const [call] = upstream.calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.href).toBe(`${BASE}/user/records`);
    expect(call?.headers.get('accept')).toBe(ALTEGIO_ACCEPT);
    expect(call?.headers.get('authorization')).toBe(
      `Bearer ${TOKEN}, User ${USER_TOKEN}`
    );
    expect(call?.body).toBeNull();
  });

  it('parses the default fixture into records in upstream order', async () => {
    const { client } = recordsClient(loadFixture('user_records', 'default'));
    const records = await client.myRecords({ userToken: USER_TOKEN });
    expect(
      records.map((record) => [
        record.locationId,
        record.datetime,
        record.cancelled,
      ])
    ).toEqual([
      [722227, '2025-03-10T10:00:00+0300', false],
      [726120, '2025-05-05T16:00:00+0300', false],
      [722227, '2025-06-16T14:30:00+0300', false],
      [722227, '2025-09-01T11:00:00+0300', true],
      [722227, '2099-01-12T10:00:00+0300', false],
    ]);
    expect(records[0]).toEqual({
      id: 1,
      locationId: 722227,
      businessName: 'Fixture Barber',
      city: 'Limassol',
      currency: '\u20ac',
      services: [{ id: 10303531, title: 'Manicure', price: 1500 }],
      teamMember: { id: 2098145, name: 'Anna Smith' },
      datetime: '2025-03-10T10:00:00+0300',
      cancelled: false,
      attendance: 1,
      price: 1500,
      moveAllowed: true,
      cancelAllowed: true,
    });
  });

  it('reads the booking id and never a token, hash, api id or comment into a record', async () => {
    const { client } = recordsClient(loadFixture('user_records', 'default'));
    const records = await client.myRecords({ userToken: USER_TOKEN });
    const text = JSON.stringify(records);
    for (const bait of [
      'fixture-hash-0001',
      'fixture-api-id-0001',
      'Fixture Client',
      'fixture.client@example.invalid',
      '+15550000001',
    ]) {
      expect(text).not.toContain(bait);
    }
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual([
        'attendance',
        'businessName',
        'cancelAllowed',
        'cancelled',
        'city',
        'currency',
        'datetime',
        'id',
        'locationId',
        'moveAllowed',
        'price',
        'services',
        'teamMember',
      ]);
    }
  });

  it('parses an empty list', async () => {
    const { client } = recordsClient(loadFixture('user_records', 'empty'));
    await expect(client.myRecords({ userToken: USER_TOKEN })).resolves.toEqual(
      []
    );
  });

  it.each([undefined, ''])(
    'refuses with a TypeError and sends nothing without a user token (%p)',
    async (userToken) => {
      const { client, upstream } = recordsClient(
        loadFixture('user_records', 'default')
      );
      await expect(
        client.myRecords(userToken === undefined ? {} : { userToken })
      ).rejects.toThrow(TypeError);
      expect(upstream.calls).toHaveLength(0);
    }
  );

  it('maps a record with an empty staff, no services or a discount, and drops one without a place or a datetime', async () => {
    const { client } = recordsClient({
      status: 200,
      body: {
        success: true,
        meta: [],
        data: [
          {
            id: 1,
            company: { id: 7, title: 'Plain', public_title: '' },
            services: [],
            staff: [],
            datetime: '2025-01-01T10:00:00+0700',
            deleted: 0,
            attendance: -1,
          },
          {
            id: 2,
            company: { id: 7, public_title: 'Public' },
            services: [
              { id: 3, title: 'A', cost: 100, amount: 2, discount: 0 },
              { id: 4, title: 'B', cost: 50, amount: 1, discount: 10 },
            ],
            staff: { id: 0, name: '' },
            datetime: '2025-02-01T10:00:00+0700',
            deleted: true,
          },
          { id: 3, company: [], datetime: '2025-03-01T10:00:00+0700' },
          { id: 4, company: { id: 7 }, datetime: null },
        ],
      },
    });
    const records = await client.myRecords({ userToken: USER_TOKEN });
    expect(records).toEqual([
      {
        id: 1,
        locationId: 7,
        businessName: 'Plain',
        city: null,
        currency: null,
        services: [],
        teamMember: null,
        datetime: '2025-01-01T10:00:00+0700',
        cancelled: false,
        attendance: -1,
        price: null,
        moveAllowed: null,
        cancelAllowed: null,
      },
      {
        id: 2,
        locationId: 7,
        businessName: 'Public',
        city: null,
        currency: null,
        services: [
          { id: 3, title: 'A', price: 200 },
          { id: 4, title: 'B', price: null },
        ],
        teamMember: null,
        datetime: '2025-02-01T10:00:00+0700',
        cancelled: true,
        attendance: null,
        price: null,
        moveAllowed: null,
        cancelAllowed: null,
      },
    ]);
  });

  it('treats a body that is not a list as contract drift', async () => {
    const { client } = recordsClient({
      status: 200,
      body: { success: true, data: { records: [] }, meta: [] },
    });
    await expect(
      client.myRecords({ userToken: USER_TOKEN })
    ).rejects.toMatchObject({ kind: 'contract_drift' });
  });
});

describe('the profile and the create route (ADR 0006, D-02)', () => {
  const USER_TOKEN = 'client-user-token-0001-abcdef';
  const SELECTION = {
    serviceIds: [10303531],
    teamMemberId: 2098145,
    datetime: '2099-01-12T11:00:00+03:00',
  };
  const PROFILE = {
    fullname: 'Fixture Client',
    phone: '+15550000001',
    email: null,
  };

  function writeClient(options: { profile?: FakeReply; create?: FakeReply }) {
    const upstream = fakeFetch([
      {
        method: 'GET',
        path: '/booking/user/data',
        reply: options.profile ?? loadFixture('booking_user_data', 'default'),
      },
      {
        method: 'POST',
        path: `/book_record/${LOCATION}`,
        reply: options.create ?? loadFixture('book_record_create', 'created'),
      },
    ]);
    const client = new BookingClient({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
    });
    return { client, upstream };
  }

  it('declares the client write routes, frozen: the create, the move and the cancel', () => {
    expect(Object.isFrozen(CLIENT_WRITE_ROUTES)).toBe(true);
    expect(
      Object.values(CLIENT_WRITE_ROUTES).map(
        (entry) => `${entry.method} ${entry.route}`
      )
    ).toEqual([
      'POST /book_record/{location_id}',
      'PUT /book_record/{location_id}/{record_id}',
      'DELETE /user/records/{record_id}/{record_hash}',
    ]);
  });

  it('reads the profile with both tokens: name, phone as plus and digits, e-mail when set', async () => {
    const { client, upstream } = writeClient({});
    expect(await client.myProfile({ userToken: USER_TOKEN })).toEqual({
      fullname: 'Fixture Client',
      phone: '+15550000001',
      email: 'fixture.client@example.invalid',
    });
    const [call] = upstream.calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.pathname).toBe('/api/v1/booking/user/data');
    expect(call?.headers.get('authorization')).toBe(
      `Bearer ${TOKEN}, User ${USER_TOKEN}`
    );
  });

  it('adds a plus to bare phone digits, joins name and surname, and gives no e-mail when it is empty', async () => {
    const { client } = writeClient({
      profile: loadFixture('booking_user_data', 'bare_digits_no_email'),
    });
    expect(await client.myProfile({ userToken: USER_TOKEN })).toEqual({
      fullname: 'Fixture Client',
      phone: '+15550000001',
      email: null,
    });
  });

  it.each(['no_phone', 'no_name'])(
    'gives no profile when the %s scenario lacks what the create needs',
    async (scenario) => {
      const { client } = writeClient({
        profile: loadFixture('booking_user_data', scenario),
      });
      expect(await client.myProfile({ userToken: USER_TOKEN })).toBeNull();
    }
  );

  it('sends nothing without a user token', async () => {
    const { client, upstream } = writeClient({});
    await expect(client.myProfile({})).rejects.toThrow(TypeError);
    await expect(
      client.createBooking(LOCATION, SELECTION, PROFILE, {})
    ).rejects.toThrow(TypeError);
    expect(upstream.calls).toEqual([]);
  });

  it('creates one booking with exactly the profile and one appointment, and returns its id', async () => {
    const { client, upstream } = writeClient({});
    const created = await client.createBooking(LOCATION, SELECTION, PROFILE, {
      userToken: USER_TOKEN,
    });
    expect(created).toEqual({ bookingId: 990001 });
    expect(JSON.stringify(created)).not.toContain('fixture-hash-0002');
    const [call] = upstream.calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.pathname).toBe(`/api/v1/book_record/${LOCATION}`);
    expect(call?.headers.get('authorization')).toBe(
      `Bearer ${TOKEN}, User ${USER_TOKEN}`
    );
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(call?.body ?? 'null')).toEqual({
      phone: '+15550000001',
      fullname: 'Fixture Client',
      appointments: [
        {
          id: 1,
          services: [10303531],
          staff_id: 2098145,
          datetime: '2099-01-12T11:00:00+03:00',
        },
      ],
    });
  });

  it('sends the profile e-mail only when there is one', async () => {
    const { client, upstream } = writeClient({});
    await client.createBooking(
      LOCATION,
      SELECTION,
      { ...PROFILE, email: 'fixture.client@example.invalid' },
      { userToken: USER_TOKEN }
    );
    expect(JSON.parse(upstream.calls[0]?.body ?? '{}')).toMatchObject({
      email: 'fixture.client@example.invalid',
    });
  });

  it('rejects ids and datetimes it cannot send before anything goes out', async () => {
    const { client, upstream } = writeClient({});
    const call = { userToken: USER_TOKEN };
    await expect(
      client.createBooking(
        LOCATION,
        { ...SELECTION, serviceIds: [] },
        PROFILE,
        call
      )
    ).rejects.toThrow(TypeError);
    await expect(
      client.createBooking(
        LOCATION,
        { ...SELECTION, datetime: 'tomorrow' },
        PROFILE,
        call
      )
    ).rejects.toThrow(TypeError);
    await expect(
      client.createBooking(0, SELECTION, PROFILE, call)
    ).rejects.toThrow(TypeError);
    expect(upstream.calls).toEqual([]);
  });
});

describe('create rejections and the anti-fraud signals (ADR 0006, D-02)', () => {
  const USER_TOKEN = 'client-user-token-0001-abcdef';
  const SELECTION = {
    serviceIds: [10303531],
    teamMemberId: 2098145,
    datetime: '2099-01-12T11:00:00+03:00',
  };
  const PROFILE = {
    fullname: 'Fixture Client',
    phone: '+15550000001',
    email: null,
  };

  function createWith(scenario: string): {
    client: BookingClient;
    upstream: ReturnType<typeof fakeFetch>;
  } {
    const upstream = fakeFetch([
      {
        method: 'POST',
        path: `/book_record/${LOCATION}`,
        reply: loadFixture('book_record_create', scenario),
      },
    ]);
    const client = new BookingClient({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
    });
    return { client, upstream };
  }

  async function createError(scenario: string): Promise<UpstreamError> {
    const { client } = createWith(scenario);
    return upstreamError(
      client.createBooking(LOCATION, SELECTION, PROFILE, {
        userToken: USER_TOKEN,
      })
    );
  }

  it('maps a 412 to the anti_fraud kind with its status', async () => {
    const error = await createError('anti_fraud_412');
    expect(error.kind).toBe('anti_fraud');
    expect(error.status).toBe(412);
    expect(error.route).toBe('/book_record/{location_id}');
  });

  it.each(['fake_201'])(
    'maps the %s answer, a 201 that names no booking, to anti_fraud with status 201',
    async (scenario) => {
      const error = await createError(scenario);
      expect(error.kind).toBe('anti_fraud');
      expect(error.status).toBe(201);
    }
  );

  it('maps a 201 whose entry has record id 0 to anti_fraud', async () => {
    const upstream = fakeFetch([
      {
        method: 'POST',
        path: `/book_record/${LOCATION}`,
        reply: {
          status: 201,
          body: { success: true, data: [{ id: 1, record_id: 0 }], meta: [] },
        },
      },
    ]);
    const client = new BookingClient({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
    });
    const error = await upstreamError(
      client.createBooking(LOCATION, SELECTION, PROFILE, {
        userToken: USER_TOKEN,
      })
    );
    expect(error.kind).toBe('anti_fraud');
  });

  it('keeps the codes of a 403 with code 434 and names the user as the credential', async () => {
    const error = await createError('blacklisted_434');
    expect(error.kind).toBe('unauthorized');
    expect(error.status).toBe(403);
    expect(error.codes).toEqual([434]);
    expect(error.credential).toBe('user');
  });

  it.each([
    ['taken_433', 433],
    ['no_team_member_436', 436],
    ['overlap_437', 437],
    ['phone_431', 431],
    ['name_435', 435],
    ['code_432', 432],
  ])('keeps the code of the 422 scenario %s', async (scenario, code) => {
    const error = await createError(scenario);
    expect(error.kind).toBe('rejected');
    expect(error.codes).toEqual([code]);
  });

  it('names the required fields of a 422 whose errors are keyed by field, and no code', async () => {
    const error = await createError('required_email_422');
    expect(error.kind).toBe('rejected');
    expect(error.codes).toEqual([]);
    expect(error.requiredFields).toEqual(['email']);
  });

  it('names no required field for a list of coded errors', async () => {
    const error = await createError('taken_433');
    expect(error.requiredFields).toEqual([]);
  });

  it('keeps the upstream message out of the error text', async () => {
    const error = await createError('taken_433');
    expect(error.message).not.toContain('Fixture Client');
    expect(error.message).not.toContain('+15550000001');
  });
});

describe('the change flags of an own record (ADR 0006, D-03)', () => {
  const USER_TOKEN = 'client-user-token-0001-abcdef';

  async function recordFive(
    change: (record: Record<string, unknown>) => void
  ): Promise<{ moveAllowed: boolean | null; cancelAllowed: boolean | null }> {
    const fixture = loadFixture('user_records', 'default');
    const body = structuredClone(fixture.body) as {
      data: { id: number }[];
    };
    const record = body.data.find((entry) => entry.id === 5);
    if (record === undefined) throw new Error('fixture record 5 is missing');
    change(record);
    const upstream = fakeFetch([
      {
        method: 'GET',
        path: '/user/records',
        reply: { ...fixture, body },
      },
    ]);
    const client = new BookingClient({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
    });
    const records = await client.myRecords({ userToken: USER_TOKEN });
    const found = records.find((entry) => entry.id === 5);
    if (found === undefined) throw new Error('record 5 was dropped');
    return {
      moveAllowed: found.moveAllowed,
      cancelAllowed: found.cancelAllowed,
    };
  }

  it('reads allow_change_record and allow_delete_record as booleans', async () => {
    expect(
      await recordFive((record) => {
        record.allow_change_record = false;
        record.allow_delete_record = 1;
      })
    ).toEqual({ moveAllowed: false, cancelAllowed: true });
  });

  it('gives null for a flag the record does not carry', async () => {
    expect(
      await recordFive((record) => {
        delete record.allow_change_record;
        record.allow_delete_record = null;
      })
    ).toEqual({ moveAllowed: null, cancelAllowed: null });
  });
});

describe('the move route (ADR 0006, D-02)', () => {
  const USER_TOKEN = 'client-user-token-0001-abcdef';
  const RECORD = 5;
  const NEW_TIME = '2099-01-10T11:00:00+03:00';
  const MOVE_PATH = `/book_record/${LOCATION}/${RECORD}`;

  function moveWith(reply: FakeReply) {
    const upstream = fakeFetch([{ method: 'PUT', path: MOVE_PATH, reply }]);
    const client = new BookingClient({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
    });
    return { client, upstream };
  }

  const call = { userToken: USER_TOKEN };

  it('sends one PUT with exactly the new datetime and both tokens', async () => {
    const { client, upstream } = moveWith(
      loadFixture('book_record_move', 'moved')
    );
    await expect(
      client.moveBooking(LOCATION, RECORD, NEW_TIME, call)
    ).resolves.toBeUndefined();
    expect(upstream.unmatched).toEqual([]);
    expect(upstream.calls).toHaveLength(1);
    const [sent] = upstream.calls;
    expect(sent?.method).toBe('PUT');
    expect(sent?.url.pathname).toBe(`/api/v1${MOVE_PATH}`);
    expect(sent?.headers.get('authorization')).toBe(
      `Bearer ${TOKEN}, User ${USER_TOKEN}`
    );
    expect(sent?.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(sent?.body ?? 'null')).toEqual({ datetime: NEW_TIME });
  });

  it('returns nothing from the answer, which carries the record token', async () => {
    const { client } = moveWith(loadFixture('book_record_move', 'moved'));
    const result: unknown = await client.moveBooking(
      LOCATION,
      RECORD,
      NEW_TIME,
      call
    );
    expect(JSON.stringify(result ?? null)).not.toContain('fixture-hash');
  });

  it('treats any 2xx other than 200 as contract drift', async () => {
    const moved = loadFixture('book_record_move', 'moved');
    const { client } = moveWith({ ...moved, status: 201 });
    const error = await upstreamError(
      client.moveBooking(LOCATION, RECORD, NEW_TIME, call)
    );
    expect(error.kind).toBe('contract_drift');
    expect(error.route).toBe('/book_record/{location_id}/{record_id}');
  });

  it('treats a 200 that is not a moved record as contract drift', async () => {
    const { client } = moveWith({
      status: 200,
      body: { success: true, data: [], meta: [] },
    });
    const error = await upstreamError(
      client.moveBooking(LOCATION, RECORD, NEW_TIME, call)
    );
    expect(error.kind).toBe('contract_drift');
  });

  it('keeps code 433 of a taken time and names the user as the credential of a 403', async () => {
    const taken = await upstreamError(
      moveWith(loadFixture('book_record_move', 'taken_433')).client.moveBooking(
        LOCATION,
        RECORD,
        NEW_TIME,
        call
      )
    );
    expect(taken.kind).toBe('rejected');
    expect(taken.codes).toEqual([433]);
    const forbidden = await upstreamError(
      moveWith(
        loadFixture('book_record_move', 'forbidden_403')
      ).client.moveBooking(LOCATION, RECORD, NEW_TIME, call)
    );
    expect(forbidden.kind).toBe('unauthorized');
    expect(forbidden.credential).toBe('user');
  });

  it('refuses ids and a datetime it cannot send, and a missing user token, before anything goes out', async () => {
    const { client, upstream } = moveWith(
      loadFixture('book_record_move', 'moved')
    );
    await expect(
      client.moveBooking(LOCATION, 0, NEW_TIME, call)
    ).rejects.toThrow(TypeError);
    await expect(
      client.moveBooking(LOCATION, 1.5, NEW_TIME, call)
    ).rejects.toThrow(TypeError);
    await expect(client.moveBooking(0, RECORD, NEW_TIME, call)).rejects.toThrow(
      TypeError
    );
    await expect(
      client.moveBooking(LOCATION, RECORD, 'tomorrow', call)
    ).rejects.toThrow(TypeError);
    await expect(
      client.moveBooking(LOCATION, RECORD, NEW_TIME, {})
    ).rejects.toThrow(TypeError);
    expect(upstream.calls).toEqual([]);
  });
});

describe('the cancel route (ADR 0006, D-02)', () => {
  const USER_TOKEN = 'client-user-token-0001-abcdef';
  const RECORD = 5;
  // The recording accepted the placeholder 0 for a signed-in client
  // (docs/research/signed-in-routes.md, "## Writes").
  const CANCEL_PATH = `/user/records/${RECORD}/0`;

  function cancelWith(reply: FakeReply) {
    const upstream = fakeFetch([
      { method: 'DELETE', path: CANCEL_PATH, reply },
    ]);
    const client = new BookingClient({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
    });
    return { client, upstream };
  }

  const call = { userToken: USER_TOKEN };

  it('uses the recorded placeholder as the hash segment, a short alphanumeric text', () => {
    expect(CANCEL_HASH_SEGMENT).toBe('0');
    expect(CANCEL_HASH_SEGMENT).toMatch(/^[A-Za-z0-9]{1,128}$/);
  });

  it('sends one DELETE with no body and both tokens, and resolves on a 204 with no body', async () => {
    const { client, upstream } = cancelWith(
      loadFixture('user_record_cancel', 'cancelled')
    );
    await expect(client.cancelBooking(RECORD, call)).resolves.toBeUndefined();
    expect(upstream.unmatched).toEqual([]);
    expect(upstream.calls).toHaveLength(1);
    const [sent] = upstream.calls;
    expect(sent?.method).toBe('DELETE');
    expect(sent?.url.pathname).toBe(`/api/v1${CANCEL_PATH}`);
    expect(sent?.headers.get('authorization')).toBe(
      `Bearer ${TOKEN}, User ${USER_TOKEN}`
    );
    expect(sent?.body).toBeNull();
  });

  it('also accepts a 200 that answers an empty list', async () => {
    const { client } = cancelWith({
      status: 200,
      body: { success: true, data: [], meta: [] },
    });
    await expect(client.cancelBooking(RECORD, call)).resolves.toBeUndefined();
  });

  it('treats any other 2xx as contract drift, because the outcome is not known', async () => {
    const { client } = cancelWith({
      status: 202,
      body: { success: true, data: null, meta: [] },
    });
    const error = await upstreamError(client.cancelBooking(RECORD, call));
    expect(error.kind).toBe('contract_drift');
    expect(error.route).toBe('/user/records/{record_id}/{record_hash}');
  });

  it('maps a 403 to unauthorized with the user as the credential and a 404 to not_found', async () => {
    const forbidden = await upstreamError(
      cancelWith(
        loadFixture('user_record_cancel', 'forbidden_403')
      ).client.cancelBooking(RECORD, call)
    );
    expect(forbidden.kind).toBe('unauthorized');
    expect(forbidden.status).toBe(403);
    expect(forbidden.credential).toBe('user');
    const missing = await upstreamError(
      cancelWith(
        loadFixture('user_record_cancel', 'not_found_404')
      ).client.cancelBooking(RECORD, call)
    );
    expect(missing.kind).toBe('not_found');
  });

  it('keeps the segment out of the error text', async () => {
    const error = await upstreamError(
      cancelWith(
        loadFixture('user_record_cancel', 'not_found_404')
      ).client.cancelBooking(RECORD, call)
    );
    expect(error.message).not.toContain(CANCEL_PATH);
  });

  it('refuses a booking id it cannot send, and a missing user token, before anything goes out', async () => {
    const { client, upstream } = cancelWith(
      loadFixture('user_record_cancel', 'cancelled')
    );
    await expect(client.cancelBooking(0, call)).rejects.toThrow(TypeError);
    await expect(client.cancelBooking(-3, call)).rejects.toThrow(TypeError);
    await expect(client.cancelBooking(1.5, call)).rejects.toThrow(TypeError);
    await expect(client.cancelBooking(RECORD, {})).rejects.toThrow(TypeError);
    expect(upstream.calls).toEqual([]);
  });
});

describe('the membership restriction of a service (ADR 0006, D-04)', () => {
  function catalogOf(reply: FakeReply) {
    const upstream = fakeFetch([
      { method: 'GET', path: `/book_services/${LOCATION}`, reply },
    ]);
    const client = new BookingClient({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
    });
    return client.services(LOCATION);
  }

  it('marks no service as membership-only in the default catalog, where 0 and an absent key mean none', async () => {
    const catalog = await catalogOf(loadFixture('book_services', 'default'));
    expect(catalog.services.length).toBeGreaterThan(0);
    for (const service of catalog.services) {
      expect(service.membershipOnly).toBe(false);
    }
  });

  it('marks a service whose abonement_restriction is above 0 as membership-only, and no other', async () => {
    const catalog = await catalogOf(
      loadFixture('book_services', 'membership_only')
    );
    expect(
      catalog.services
        .filter((service) => service.membershipOnly)
        .map((service) => service.id)
    ).toEqual([10303531]);
  });

  it('reads a flag and a number the same way, and treats null as none', async () => {
    const fixture = loadFixture('book_services', 'default');
    const body = structuredClone(fixture.body) as {
      data: { services: Record<string, unknown>[] };
    };
    const [first, second, third, fourth] = body.data.services;
    if (!first || !second || !third || !fourth) {
      throw new Error('the default catalog has fewer than four services');
    }
    first.abonement_restriction = true;
    second.abonement_restriction = 2;
    third.abonement_restriction = null;
    fourth.abonement_restriction = false;
    const catalog = await catalogOf({ ...fixture, body });
    expect(
      catalog.services.slice(0, 4).map((service) => service.membershipOnly)
    ).toEqual([true, true, false, false]);
  });
});

describe('pair check and create (CASE-02, D-01)', () => {
  const USER_TOKEN = 'client-user-token-0001-abcdef';
  const PAIR_SLOT = '2099-01-12T11:00:00+03:00';
  const FIRST = {
    serviceIds: [10303531],
    teamMemberId: 2098145,
    datetime: PAIR_SLOT,
  };
  const SECOND = {
    serviceIds: [10303531],
    teamMemberId: 2098146,
    datetime: PAIR_SLOT,
  };
  const PROFILE = {
    fullname: 'Fixture Client',
    phone: '+15550000001',
    email: null,
  };
  const PAIR_ENTRIES = [
    { id: 1, services: [10303531], staff_id: 2098145, datetime: PAIR_SLOT },
    { id: 2, services: [10303531], staff_id: 2098146, datetime: PAIR_SLOT },
  ];

  function pairClient(options: { check?: FakeReply; create?: FakeReply }) {
    const upstream = fakeFetch([
      {
        method: 'POST',
        path: CHECK_PATH,
        reply: options.check ?? loadFixture('book_check', 'pair_created'),
      },
      {
        method: 'POST',
        path: `/book_record/${LOCATION}`,
        reply:
          options.create ?? loadFixture('book_record_create', 'created_pair'),
      },
    ]);
    const client = new BookingClient({
      base: BASE,
      token: TOKEN,
      fetch: upstream.fetch,
    });
    return { client, upstream };
  }

  it('checks two appointments with one POST carrying exactly two numbered entries and the partner token only', async () => {
    const { client, upstream } = pairClient({});
    await expect(
      client.checkPair(LOCATION, FIRST, SECOND)
    ).resolves.toBeUndefined();
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url.pathname).toBe(`/api/v1${CHECK_PATH}`);
    expect(call?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(call?.body ?? 'null')).toEqual({
      appointments: PAIR_ENTRIES,
    });
  });

  it('maps the code-less 422 the live probe recorded for one team member twice to rejected with no code', async () => {
    const { client } = pairClient({
      check: loadFixture('book_check', 'pair_same_member_437'),
    });
    const error = await upstreamError(
      client.checkPair(LOCATION, FIRST, SECOND)
    );
    expect(error.kind).toBe('rejected');
    expect(error.status).toBe(422);
    expect(error.codes).toEqual([]);
    expect(error.upstreamMessage).toContain('enough time');
  });

  it('maps the documented code-437 shape to rejected with the code', async () => {
    const { client } = pairClient({
      check: loadFixture('book_check', 'pair_same_member_coded_437'),
    });
    const error = await upstreamError(
      client.checkPair(LOCATION, FIRST, SECOND)
    );
    expect(error.kind).toBe('rejected');
    expect(error.codes).toEqual([437]);
  });

  it('maps a taken time of the pair to rejected with code 433', async () => {
    const { client } = pairClient({
      check: loadFixture('book_check', 'pair_taken_433'),
    });
    const error = await upstreamError(
      client.checkPair(LOCATION, FIRST, SECOND)
    );
    expect(error.codes).toEqual([433]);
  });

  it.each([
    ['team member 0 first', { ...FIRST, teamMemberId: 0 }, SECOND],
    ['team member 0 second', FIRST, { ...SECOND, teamMemberId: 0 }],
    ['the same team member twice', FIRST, { ...SECOND, teamMemberId: 2098145 }],
    [
      'two different datetimes',
      FIRST,
      { ...SECOND, datetime: '2099-01-12T12:00:00+03:00' },
    ],
    ['no services of the second', FIRST, { ...SECOND, serviceIds: [] }],
    [
      'a bad datetime',
      { ...FIRST, datetime: 'x' },
      { ...SECOND, datetime: 'x' },
    ],
  ])('sends nothing for a pair with %s', async (_label, first, second) => {
    const { client, upstream } = pairClient({});
    await expect(client.checkPair(LOCATION, first, second)).rejects.toThrow(
      TypeError
    );
    await expect(
      client.createPairBooking(LOCATION, first, second, PROFILE, {
        userToken: USER_TOKEN,
      })
    ).rejects.toThrow(TypeError);
    expect(upstream.calls).toEqual([]);
  });

  it('creates two appointments with one POST of exactly the profile and the two entries, and returns both ids', async () => {
    const { client, upstream } = pairClient({});
    const created = await client.createPairBooking(
      LOCATION,
      FIRST,
      SECOND,
      PROFILE,
      { userToken: USER_TOKEN }
    );
    expect(created).toEqual({ bookingIds: [990001, 990002] });
    expect(JSON.stringify(created)).not.toContain('fixture-hash');
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url.pathname).toBe(`/api/v1/book_record/${LOCATION}`);
    expect(call?.headers.get('authorization')).toBe(
      `Bearer ${TOKEN}, User ${USER_TOKEN}`
    );
    expect(JSON.parse(call?.body ?? 'null')).toEqual({
      phone: '+15550000001',
      fullname: 'Fixture Client',
      appointments: PAIR_ENTRIES,
    });
  });

  it('sends the profile e-mail only when there is one', async () => {
    const { client, upstream } = pairClient({});
    await client.createPairBooking(
      LOCATION,
      FIRST,
      SECOND,
      { ...PROFILE, email: 'fixture.client@example.invalid' },
      { userToken: USER_TOKEN }
    );
    expect(JSON.parse(upstream.calls[0]?.body ?? '{}')).toMatchObject({
      email: 'fixture.client@example.invalid',
    });
  });

  it('names a null for the appointment an answer does not name', async () => {
    const { client } = pairClient({
      create: loadFixture('book_record_create', 'created_pair_partial'),
    });
    expect(
      await client.createPairBooking(LOCATION, FIRST, SECOND, PROFILE, {
        userToken: USER_TOKEN,
      })
    ).toEqual({ bookingIds: [990001, null] });
  });

  it('maps a 201 that names no booking to anti_fraud, and a 412 to anti_fraud', async () => {
    for (const [scenario, status] of [
      ['fake_201', 201],
      ['anti_fraud_412', 412],
    ] as const) {
      const { client } = pairClient({
        create: loadFixture('book_record_create', scenario),
      });
      const error = await upstreamError(
        client.createPairBooking(LOCATION, FIRST, SECOND, PROFILE, {
          userToken: USER_TOKEN,
        })
      );
      expect(error.kind).toBe('anti_fraud');
      expect(error.status).toBe(status);
    }
  });

  it('sends nothing without a user token', async () => {
    const { client, upstream } = pairClient({});
    await expect(
      client.createPairBooking(LOCATION, FIRST, SECOND, PROFILE, {})
    ).rejects.toThrow(TypeError);
    expect(upstream.calls).toEqual([]);
  });
});
