import { afterEach, describe, expect, it } from '@jest/globals';
import { BookingClient } from '../booking/client.js';
import {
  fakeFetch,
  loadFixture,
  type FakeFetch,
  type FakeRoute,
  type FixtureResponse,
} from '../booking/__tests__/helpers/fake-fetch.js';
import {
  DIRECT_USER_TOKEN_HEADER,
  SIGNED_KIND_HEADER,
  SIGNED_SCOPE_HEADER,
  SIGNED_USER_TOKEN_HEADER,
} from '../security/caller-auth.js';
import { PROXY_AUTH_HEADER } from '../security/proxy-auth.js';
import {
  CONFIRMATION_TTL_MS,
  createConfirmations,
  type Confirmations,
} from '../tools/confirmation.js';
import { productionTools } from '../tools/registry.js';
import { createFakeClock } from '../booking/__tests__/helpers/fake-clock.js';
import {
  CANARY_SECRET,
  CLIENT_USER_TOKEN,
  PARTNER_TOKEN,
  closeAllApps,
  postMcp,
  startApp,
  stubPartnerValidator,
  toolCallBody,
  toolsListBody,
  waitForLogs,
  type Harness,
} from './helpers/http-harness.js';
import { signProxyRequest } from './helpers/sign-request.js';

// The signed-in client's write tool end to end over HTTP (ADR 0006, D-02,
// D-03): POST /mcp -> caller check -> scope check -> me_book -> BookingClient
// -> BookingHttp -> (fake) Altegio API. Only fetch is replaced. The slot is in
// 2099 so the created booking reads as upcoming whatever the clock says.

const API_BASE = 'https://api.alteg.io/api/v1';
const LOCATION = 722227;
const SERVICE = 10303531;
const TEAM_MEMBER = 2098145;
const DATETIME = '2099-01-12T11:00:00+03:00';
const NEW_RECORD_ID = 990001;
const SECOND_RECORD_ID = 990002;
const SECOND_TEAM_MEMBER = 2098146;
const MOVE_TO = '2099-01-13T11:00:00+03:00';
const MOVED_DATETIME = '2099-01-13T11:00:00+0300';
const CLIENT_HEADERS = { [DIRECT_USER_TOKEN_HEADER]: CLIENT_USER_TOKEN };
const USER_AUTHORIZATION = `Bearer ${CANARY_SECRET}, User ${CLIENT_USER_TOKEN}`;
const PARTNER_AUTHORIZATION = `Bearer ${CANARY_SECRET}`;

// What the fixtures quote about the client, and the secrets of the record.
const BAIT = [
  CLIENT_USER_TOKEN,
  '+15550000001',
  'Fixture Client',
  'fixture.client@example.invalid',
  'fixture-user-token-0001',
  'fixture-hash-0002',
  'fixture-hash-0005',
];

interface BookOutput {
  status: string;
  location_id: number;
  preview: {
    business: string | null;
    services: {
      id: number;
      title: string | null;
      price: { min: number; max: number; currency: string | null } | null;
    }[];
    team_member: { id: number; name: string | null } | null;
    date: string;
    time: string;
    utc_offset: string;
    cancellation: string | null;
    second_appointment: {
      services: {
        id: number;
        title: string | null;
        price: { min: number; max: number; currency: string | null } | null;
      }[];
      team_member: { id: number; name: string | null } | null;
    } | null;
  } | null;
  confirmation_token: string | null;
  expires_at: string | null;
  booking_id: number | null;
  booking: { booking_id: number; status: string; datetime: string } | null;
  second_booking_id: number | null;
  second_booking: {
    booking_id: number;
    status: string;
    datetime: string;
  } | null;
}

interface RpcResult {
  result?: {
    content?: { type: string; text: string }[];
    structuredContent?: BookOutput;
    isError?: boolean;
  };
}

afterEach(async () => {
  await closeAllApps();
});

/** The default records, plus the new booking once the create call has been made. */
function recordsReply(
  state: { created: boolean; pair: boolean; moved: boolean },
  failAfterCreate: boolean
): () => FixtureResponse {
  return () => {
    const fixture = loadFixture('user_records', 'default');
    if (state.moved) {
      const moved = structuredClone(fixture.body) as {
        data: { id: number; datetime: string; date: string }[];
      };
      const record = moved.data.find((entry) => entry.id === 5);
      if (record === undefined) throw new Error('fixture record 5 is missing');
      record.datetime = MOVED_DATETIME;
      record.date = '2099-01-13 11:00:00';
      return { ...fixture, body: moved };
    }
    if (!state.created) return fixture;
    if (failAfterCreate) {
      return { status: 500, body: { success: false, meta: {} } };
    }
    const body = structuredClone(fixture.body) as {
      data: { id: number; datetime: string; date: string }[];
    };
    const template = body.data.find((record) => record.id === 5);
    if (template === undefined) throw new Error('fixture record 5 is missing');
    body.data.push({
      ...structuredClone(template),
      id: NEW_RECORD_ID,
      datetime: '2099-01-12T11:00:00+0300',
      date: '2099-01-12 11:00:00',
    });
    if (state.pair) {
      body.data.push({
        ...structuredClone(template),
        id: SECOND_RECORD_ID,
        datetime: '2099-01-12T11:00:00+0300',
        date: '2099-01-12 11:00:00',
      });
    }
    return { ...fixture, body };
  };
}

interface Scenario {
  confirmations?: Confirmations;
  create?: string;
  check?: string;
  profile?: string;
  records?: string;
  recordsAfterCreate?: 'fail';
  move?: string;
  cancel?: string;
  company?: string;
}

async function start(
  scenario: Scenario = {},
  overrides: Parameters<typeof startApp>[0] = {}
): Promise<{ harness: Harness; upstream: FakeFetch }> {
  const state = { created: false, pair: false, moved: false };
  const routes: FakeRoute[] = [
    {
      method: 'GET',
      path: '/user/records',
      reply:
        scenario.records === undefined
          ? recordsReply(state, scenario.recordsAfterCreate === 'fail')
          : loadFixture('user_records', scenario.records),
    },
    {
      method: 'GET',
      path: '/booking/user/data',
      reply: loadFixture('booking_user_data', scenario.profile ?? 'default'),
    },
    {
      method: 'GET',
      path: `/company/${LOCATION}`,
      reply: loadFixture('company', scenario.company ?? 'default'),
    },
    {
      method: 'GET',
      path: '/company/731000',
      reply: loadFixture('company', 'default'),
    },
    {
      method: 'GET',
      path: `/book_services/${LOCATION}`,
      reply: loadFixture('book_services', 'default'),
    },
    {
      method: 'GET',
      path: `/book_staff/${LOCATION}`,
      reply: loadFixture('book_staff', 'default'),
    },
    {
      method: 'POST',
      path: `/book_check/${LOCATION}`,
      reply: loadFixture('book_check', scenario.check ?? 'created_empty'),
    },
    {
      method: 'POST',
      path: `/book_record/${LOCATION}`,
      reply: (call) => {
        state.created = true;
        const sent = JSON.parse(call.body ?? '{}') as {
          appointments?: unknown[];
        };
        state.pair = sent.appointments?.length === 2;
        return loadFixture(
          'book_record_create',
          scenario.create ?? (state.pair ? 'created_pair' : 'created')
        );
      },
    },
    {
      method: 'PUT',
      path: `/book_record/${LOCATION}/5`,
      reply: () => {
        state.moved = true;
        return loadFixture('book_record_move', scenario.move ?? 'moved');
      },
    },
    {
      method: 'DELETE',
      path: '/user/records/5/0',
      reply: loadFixture('user_record_cancel', scenario.cancel ?? 'cancelled'),
    },
  ];
  const upstream = fakeFetch(routes);
  const harness = await startApp({
    tools: productionTools,
    toolDeps: {
      booking: new BookingClient({
        base: API_BASE,
        token: CANARY_SECRET,
        fetch: upstream.fetch,
      }),
      ...(scenario.confirmations === undefined
        ? {}
        : { confirmations: scenario.confirmations }),
    },
    ...overrides,
  });
  return { harness, upstream };
}

const SELECTION = {
  location_id: LOCATION,
  service_ids: [SERVICE],
  team_member_id: TEAM_MEMBER,
  datetime: DATETIME,
};

async function callBook(
  harness: Harness,
  args: Record<string, unknown>,
  headers: Record<string, string> = CLIENT_HEADERS
): Promise<{ body: RpcResult; text: string }> {
  const res = await postMcp(
    harness.baseUrl,
    toolCallBody('me_book', args),
    headers
  );
  expect(res.status).toBe(200);
  const text = await res.text();
  return { body: JSON.parse(text) as RpcResult, text };
}

function routesOf(upstream: FakeFetch): string[] {
  return upstream.calls.map(
    (call) => `${call.method} ${call.url.pathname.replace('/api/v1', '')}`
  );
}

async function preview(
  harness: Harness
): Promise<{ token: string; out: BookOutput }> {
  const { body } = await callBook(harness, SELECTION);
  const out = body.result?.structuredContent;
  if (
    out?.confirmation_token === null ||
    out?.confirmation_token === undefined
  ) {
    throw new Error('the preview carried no confirmation token');
  }
  return { token: out.confirmation_token, out };
}

describe('me_book, first call: the preview', () => {
  it('reads the records, the card, the catalog, the team member and the slot, and writes nothing', async () => {
    const { harness, upstream } = await start();
    const before = Date.now();
    const { body, text } = await callBook(harness, SELECTION);
    expect(body.result?.isError).not.toBe(true);
    const out = body.result?.structuredContent;
    expect(out?.status).toBe('preview');
    expect(out?.location_id).toBe(LOCATION);
    expect(out?.booking_id).toBeNull();
    expect(out?.booking).toBeNull();

    expect(out?.preview?.services).toEqual([
      {
        id: SERVICE,
        title: 'Manicure',
        price: { min: 1500, max: 1500, currency: 'EUR' },
      },
    ]);
    expect(out?.preview?.team_member).toEqual({
      id: TEAM_MEMBER,
      name: 'Anna Smith',
    });
    expect(out?.preview?.business).toBe('Demo Beauty Studio');
    expect(out?.preview).toMatchObject({
      date: '2099-01-12',
      time: '11:00',
      utc_offset: '+03:00',
    });
    expect(out?.preview?.cancellation).toContain('Online cancellation');
    expect(out?.preview?.cancellation).toContain('2 hours before the start');

    expect(out?.confirmation_token).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
    const expiresAt = Date.parse(out?.expires_at ?? '');
    expect(expiresAt - before).toBeGreaterThan(9 * 60_000);
    expect(expiresAt - before).toBeLessThan(11 * 60_000);

    expect(text).toContain('Preview, nothing is booked yet');
    expect(text).toContain('only after the user agrees');
    expect(text).toContain(out?.confirmation_token ?? 'missing');

    expect(upstream.unmatched).toEqual([]);
    expect(routesOf(upstream).sort()).toEqual(
      [
        'GET /user/records',
        `GET /company/${LOCATION}`,
        `GET /book_services/${LOCATION}`,
        `GET /book_staff/${LOCATION}`,
        `POST /book_check/${LOCATION}`,
      ].sort()
    );
    expect(routesOf(upstream)).not.toContain(`POST /book_record/${LOCATION}`);
  });

  it('sends the user token on the records call only, and the partner token alone on the rest', async () => {
    const { harness, upstream } = await start();
    await callBook(harness, SELECTION);
    for (const call of upstream.calls) {
      const route = `${call.method} ${call.url.pathname.replace('/api/v1', '')}`;
      expect(call.headers.get('authorization')).toBe(
        route === 'GET /user/records'
          ? USER_AUTHORIZATION
          : PARTNER_AUTHORIZATION
      );
    }
  });

  it('hands off the pre-filled link, with the reason, for a place the client has no record at, and issues no token', async () => {
    const { harness, upstream } = await start();
    const { body, text } = await callBook(harness, {
      ...SELECTION,
      location_id: 731000,
    });
    expect(body.result?.isError).not.toBe(true);
    const out = body.result?.structuredContent as unknown as {
      status: string;
      confirmation_token: string | null;
      fallback: { reason: string; link: { url: string; kind: string } | null };
    };
    expect(out.status).toBe('fallback');
    expect(out.confirmation_token).toBeNull();
    expect(out.fallback.reason).toBe('not_own_place');
    expect(out.fallback.link?.kind).toBe('preselected');
    expect(text).toContain('no earlier booking at this business');
    expect(text).toContain(out.fallback.link?.url ?? 'missing');
    expect(routesOf(upstream)).toEqual([
      'GET /user/records',
      'GET /company/731000',
    ]);
  });

  it('hands off the pre-filled link for a service that needs prepayment, with no slot check', async () => {
    const { harness, upstream } = await start();
    const { body, text } = await callBook(harness, {
      ...SELECTION,
      service_ids: [10303532],
    });
    const out = body.result?.structuredContent as unknown as {
      status: string;
      fallback: { reason: string; link: { kind: string } | null };
    };
    expect(out.status).toBe('fallback');
    expect(out.fallback.reason).toBe('prepayment');
    expect(out.fallback.link?.kind).toBe('preselected');
    expect(text).toContain('needs online prepayment');
    expect(routesOf(upstream)).not.toContain(`POST /book_check/${LOCATION}`);
  });

  it('hands off the plain form link for an inactive widget, and no link when the card has no form', async () => {
    const inactive = await start({ company: 'inactive' });
    const first = await callBook(inactive.harness, SELECTION);
    const firstOut = first.body.result?.structuredContent as unknown as {
      fallback: { reason: string; link: { kind: string } | null };
    };
    expect(firstOut.fallback.reason).toBe('widget_inactive');
    expect(firstOut.fallback.link?.kind).toBe('booking_form');

    const noForms = await start({ company: 'no_forms' });
    const second = await callBook(noForms.harness, SELECTION);
    const secondOut = second.body.result?.structuredContent as unknown as {
      fallback: { reason: string; link: unknown };
    };
    expect(secondOut.fallback.reason).toBe('widget_inactive');
    expect(secondOut.fallback.link).toBeNull();
    expect(second.text).toContain('business_get');
    expect(noForms.upstream.calls.some((call) => call.method === 'PUT')).toBe(
      false
    );
  });
});

describe('me_book, second call: the booking', () => {
  it('reads the profile, creates the booking with the user token and returns it as me_list_bookings shows it', async () => {
    const { harness, upstream } = await start();
    const { token } = await preview(harness);
    upstream.calls.length = 0;

    const { body, text } = await callBook(harness, {
      ...SELECTION,
      confirmation_token: token,
    });
    expect(body.result?.isError).not.toBe(true);
    const out = body.result?.structuredContent;
    expect(out?.status).toBe('booked');
    expect(out?.booking_id).toBe(NEW_RECORD_ID);
    expect(out?.booking).toMatchObject({
      booking_id: NEW_RECORD_ID,
      status: 'upcoming',
      datetime: '2099-01-12T11:00:00+0300',
    });
    expect(out?.preview).toBeNull();
    expect(out?.confirmation_token).toBeNull();
    expect(text).toContain(`Booked: booking ${NEW_RECORD_ID}`);
    expect(text).toContain('me_list_bookings');

    expect(routesOf(upstream)).toEqual([
      'GET /booking/user/data',
      `POST /book_record/${LOCATION}`,
      'GET /user/records',
    ]);
    for (const call of upstream.calls) {
      expect(call.headers.get('authorization')).toBe(USER_AUTHORIZATION);
    }
    const create = upstream.calls[1];
    expect(JSON.parse(create?.body ?? 'null')).toEqual({
      phone: '+15550000001',
      fullname: 'Fixture Client',
      email: 'fixture.client@example.invalid',
      appointments: [
        {
          id: 1,
          services: [SERVICE],
          staff_id: TEAM_MEMBER,
          datetime: DATETIME,
        },
      ],
    });
  });

  it('sends no e-mail when the profile has none, and a plus before bare phone digits', async () => {
    const { harness, upstream } = await start({
      profile: 'bare_digits_no_email',
    });
    const { token } = await preview(harness);
    upstream.calls.length = 0;
    await callBook(harness, { ...SELECTION, confirmation_token: token });
    const create = upstream.calls.find((call) => call.method === 'POST');
    expect(JSON.parse(create?.body ?? 'null')).toEqual({
      phone: '+15550000001',
      fullname: 'Fixture Client',
      appointments: [
        {
          id: 1,
          services: [SERVICE],
          staff_id: TEAM_MEMBER,
          datetime: DATETIME,
        },
      ],
    });
  });

  it('never sets a comment, code, notification or api id in the create body', async () => {
    const { harness, upstream } = await start();
    const { token } = await preview(harness);
    await callBook(harness, { ...SELECTION, confirmation_token: token });
    const create = upstream.calls.find(
      (call) =>
        call.method === 'POST' && call.url.pathname.includes('book_record')
    );
    const sent = JSON.parse(create?.body ?? '{}') as Record<string, unknown>;
    for (const key of [
      'comment',
      'code',
      'notify_by_sms',
      'notify_by_email',
      'api_id',
    ]) {
      expect(sent).not.toHaveProperty(key);
    }
  });

  it('keeps the booked status with the booking id when the records cannot be re-read', async () => {
    const { harness } = await start({ recordsAfterCreate: 'fail' });
    const { token } = await preview(harness);
    const { body } = await callBook(harness, {
      ...SELECTION,
      confirmation_token: token,
    });
    expect(body.result?.isError).not.toBe(true);
    const out = body.result?.structuredContent;
    expect(out?.status).toBe('booked');
    expect(out?.booking_id).toBe(NEW_RECORD_ID);
    expect(out?.booking).toBeNull();
  });
});

describe('me_book output and logs', () => {
  it('leaks neither the sign-in, the profile nor the record hash into any response or log line', async () => {
    const { harness } = await start();
    const first = await callBook(harness, SELECTION);
    const token = first.body.result?.structuredContent?.confirmation_token;
    const second = await callBook(harness, {
      ...SELECTION,
      confirmation_token: token,
    });
    await waitForLogs(harness, 2);
    const everything = [
      first.text,
      second.text,
      JSON.stringify(harness.logs),
    ].join('\n');
    for (const bait of BAIT) expect(everything).not.toContain(bait);
  });

  it('takes no phone, name, e-mail or code in its input', () => {
    const tool = productionTools.find((entry) => entry.name === 'me_book');
    const properties = Object.keys(
      (tool?.spec.inputSchema as { properties: Record<string, unknown> })
        .properties
    );
    expect(properties.sort()).toEqual(
      [
        'confirmation_token',
        'datetime',
        'location_id',
        'second_appointment',
        'service_ids',
        'team_member_id',
      ].sort()
    );
  });

  it('takes only service ids and a team member id for the second appointment', () => {
    const tool = productionTools.find((entry) => entry.name === 'me_book');
    const schema = tool?.spec.inputSchema as {
      properties: {
        second_appointment: { properties: Record<string, unknown> };
      };
    };
    expect(
      Object.keys(schema.properties.second_appointment.properties).sort()
    ).toEqual(['service_ids', 'team_member_id']);
  });
});

// Two people side by side (CASE-02, D-01): one call, one preview, one token, one
// create with two appointments, both under the client's name.

const PAIR = {
  ...SELECTION,
  second_appointment: {
    service_ids: [SERVICE],
    team_member_id: SECOND_TEAM_MEMBER,
  },
};
const PAIR_ENTRIES = [
  { id: 1, services: [SERVICE], staff_id: TEAM_MEMBER, datetime: DATETIME },
  {
    id: 2,
    services: [SERVICE],
    staff_id: SECOND_TEAM_MEMBER,
    datetime: DATETIME,
  },
];

describe('me_book with second_appointment, first call: the pair preview', () => {
  it('checks both appointments in one request and previews both, with one token and no create', async () => {
    const { harness, upstream } = await start({ check: 'pair_created' });
    const { body, text } = await callBook(harness, PAIR);
    expect(body.result?.isError).not.toBe(true);
    const out = body.result?.structuredContent;
    expect(out?.status).toBe('preview');
    expect(out?.preview?.services).toEqual([
      {
        id: SERVICE,
        title: 'Manicure',
        price: { min: 1500, max: 1500, currency: 'EUR' },
      },
    ]);
    expect(out?.preview?.team_member).toEqual({
      id: TEAM_MEMBER,
      name: 'Anna Smith',
    });
    expect(out?.preview?.second_appointment?.services).toEqual([
      {
        id: SERVICE,
        title: 'Manicure',
        price: { min: 1500, max: 1500, currency: 'EUR' },
      },
    ]);
    expect(out?.preview?.second_appointment?.team_member?.id).toBe(
      SECOND_TEAM_MEMBER
    );
    expect(out?.preview).toMatchObject({
      date: '2099-01-12',
      time: '11:00',
      utc_offset: '+03:00',
    });
    expect(out?.confirmation_token).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
    expect(out?.booking_id).toBeNull();
    expect(out?.second_booking_id).toBeNull();
    expect(out?.second_booking).toBeNull();

    expect(text).toContain('First appointment:');
    expect(text).toContain('Second appointment:');
    expect(text).toContain(`team member ${TEAM_MEMBER}`);
    expect(text).toContain(`team member ${SECOND_TEAM_MEMBER}`);
    expect(text).toContain("Both bookings are under the client's name");
    expect(text).toContain('second_appointment');
    expect(text).toContain(out?.confirmation_token ?? 'missing');

    const checks = upstream.calls.filter(
      (call) => call.method === 'POST' && call.url.pathname.includes('book_')
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.url.pathname).toBe(`/api/v1/book_check/${LOCATION}`);
    expect(checks[0]?.headers.get('authorization')).toBe(PARTNER_AUTHORIZATION);
    expect(JSON.parse(checks[0]?.body ?? 'null')).toEqual({
      appointments: PAIR_ENTRIES,
    });
    expect(routesOf(upstream)).not.toContain(`POST /book_record/${LOCATION}`);
    expect(upstream.unmatched).toEqual([]);
  });

  it('refuses team member 0 on either side, and the same team member twice, with no upstream call', async () => {
    const { harness, upstream } = await start();
    for (const args of [
      { ...PAIR, team_member_id: 0 },
      {
        ...PAIR,
        second_appointment: { ...PAIR.second_appointment, team_member_id: 0 },
      },
      {
        ...PAIR,
        second_appointment: {
          ...PAIR.second_appointment,
          team_member_id: TEAM_MEMBER,
        },
      },
    ]) {
      const { body } = await callBook(harness, args);
      expect(body.result?.isError).toBe(true);
      const text = body.result?.content?.[0]?.text ?? '';
      expect(text).toContain(
        'Nothing was booked: two appointments need two different named team members.'
      );
      expect(text).toContain('business_list_team_members');
    }
    expect(upstream.calls).toEqual([]);
  });
});

describe('me_book with second_appointment, second call: the pair booking', () => {
  async function previewPair(scenario: Scenario = {}) {
    const { harness, upstream } = await start({
      check: 'pair_created',
      ...scenario,
    });
    const { body } = await callBook(harness, PAIR);
    const token = body.result?.structuredContent?.confirmation_token;
    if (token === null || token === undefined) {
      throw new Error('the pair preview carried no confirmation token');
    }
    upstream.calls.length = 0;
    return { harness, upstream, token };
  }

  it('reads the profile, creates both appointments in one request, re-reads and returns both bookings', async () => {
    const { harness, upstream, token } = await previewPair();
    const { body, text } = await callBook(harness, {
      ...PAIR,
      confirmation_token: token,
    });
    expect(body.result?.isError).not.toBe(true);
    const out = body.result?.structuredContent;
    expect(out?.status).toBe('booked');
    expect(out?.booking_id).toBe(NEW_RECORD_ID);
    expect(out?.second_booking_id).toBe(SECOND_RECORD_ID);
    expect(out?.booking).toMatchObject({
      booking_id: NEW_RECORD_ID,
      status: 'upcoming',
      datetime: '2099-01-12T11:00:00+0300',
    });
    expect(out?.second_booking).toMatchObject({
      booking_id: SECOND_RECORD_ID,
      status: 'upcoming',
    });
    expect(out?.preview).toBeNull();
    expect(out?.confirmation_token).toBeNull();
    expect(text).toContain(`Booked: two appointments at location ${LOCATION}`);
    expect(text).toContain(`booking ${NEW_RECORD_ID}`);
    expect(text).toContain(`booking ${SECOND_RECORD_ID}`);
    expect(text).toContain("Both are under the client's name.");
    expect(text).toContain('me_cancel_booking');

    expect(routesOf(upstream)).toEqual([
      'GET /booking/user/data',
      `POST /book_record/${LOCATION}`,
      'GET /user/records',
    ]);
    for (const call of upstream.calls) {
      expect(call.headers.get('authorization')).toBe(USER_AUTHORIZATION);
    }
    expect(JSON.parse(upstream.calls[1]?.body ?? 'null')).toEqual({
      phone: '+15550000001',
      fullname: 'Fixture Client',
      email: 'fixture.client@example.invalid',
      appointments: PAIR_ENTRIES,
    });
    const sent = JSON.parse(upstream.calls[1]?.body ?? '{}') as Record<
      string,
      unknown
    >;
    expect(Object.keys(sent)).toEqual([
      'phone',
      'fullname',
      'email',
      'appointments',
    ]);

    const list = await postMcp(
      harness.baseUrl,
      toolCallBody('me_list_bookings', {}),
      CLIENT_HEADERS
    );
    const listText = await list.text();
    expect(listText).toContain(`${NEW_RECORD_ID}`);
    expect(listText).toContain(`${SECOND_RECORD_ID}`);
  });

  it('names the booked one and the next action when the answer names only the first appointment', async () => {
    const { harness, token } = await previewPair({
      create: 'created_pair_partial',
    });
    const { body, text } = await callBook(harness, {
      ...PAIR,
      confirmation_token: token,
    });
    expect(body.result?.isError).not.toBe(true);
    const out = body.result?.structuredContent;
    expect(out?.status).toBe('partially_booked');
    expect(out?.booking_id).toBe(NEW_RECORD_ID);
    expect(out?.second_booking_id).toBeNull();
    expect(out?.booking).toMatchObject({ booking_id: NEW_RECORD_ID });
    expect(text).toContain(
      `Only one of the two appointments was booked: booking ${NEW_RECORD_ID}.`
    );
    expect(text).toContain('me_cancel_booking');
  });

  it('leaks neither the sign-in, the profile nor a record hash into any response or log line', async () => {
    const { harness, token } = await previewPair();
    const second = await callBook(harness, {
      ...PAIR,
      confirmation_token: token,
    });
    await waitForLogs(harness, 2);
    const everything = [second.text, JSON.stringify(harness.logs)].join('\n');
    for (const bait of [...BAIT, 'fixture-hash-0003']) {
      expect(everything).not.toContain(bait);
    }
  });
});

// The caller tiers: only a client sign-in with the book scope reaches the write.

const PROXY_KEY = 'me-write-flow-key-0123456789abcdef0123456789abcdef';
const REQUIRED = {
  callerAuth: {
    mode: 'required' as const,
    validator: stubPartnerValidator(),
  },
};
const BEHIND_PROXY = {
  proxyAuth: { keys: () => [PROXY_KEY] },
  callerAuth: {
    mode: 'required' as const,
    validator: stubPartnerValidator(),
  },
};

function signedClient(scope: string): Record<string, string> {
  const headers = {
    [SIGNED_KIND_HEADER]: 'client',
    [SIGNED_USER_TOKEN_HEADER]: CLIENT_USER_TOKEN,
    [SIGNED_SCOPE_HEADER]: scope,
  };
  return {
    ...headers,
    [PROXY_AUTH_HEADER]: signProxyRequest({
      key: PROXY_KEY,
      method: 'POST',
      path: '/mcp',
      headers,
    }),
  };
}

describe('me_book for callers that are not a signed-in client with the book scope', () => {
  it('refuses a pair from an anonymous caller and from a partner caller, with InsufficientScope and no upstream call', async () => {
    const anonymous = await start();
    const { body } = await callBook(anonymous.harness, PAIR, {});
    expect(body.result?.isError).toBe(true);
    expect(anonymous.upstream.calls).toEqual([]);
    const lines = await waitForLogs(anonymous.harness, 1);
    expect(lines[0]).toMatchObject({
      tool: 'me_book',
      error_type: 'InsufficientScope',
    });

    const partner = await start({}, REQUIRED);
    const refused = await callBook(partner.harness, PAIR, {
      authorization: `Bearer ${PARTNER_TOKEN}`,
    });
    expect(refused.body.result?.isError).toBe(true);
    expect(partner.upstream.calls).toEqual([]);
    const partnerLines = await waitForLogs(partner.harness, 1);
    expect(partnerLines[0]).toMatchObject({ error_type: 'InsufficientScope' });
  });

  it('refuses an anonymous caller in band, naming the sign-in and book_check, with no upstream call', async () => {
    const { harness, upstream } = await start();
    const { body } = await callBook(harness, SELECTION, {});
    expect(body.result?.isError).toBe(true);
    const text = body.result?.content?.[0]?.text ?? '';
    expect(text).toContain('sign-in');
    expect(text).toContain('book_check');
    expect(upstream.calls).toEqual([]);
    const lines = await waitForLogs(harness, 1);
    expect(lines[0]).toMatchObject({
      tool: 'me_book',
      outcome: 'tool_error',
      error_type: 'InsufficientScope',
    });
  });

  it('refuses a partner caller the same way', async () => {
    const { harness, upstream } = await start({}, REQUIRED);
    const { body } = await callBook(harness, SELECTION, {
      authorization: `Bearer ${PARTNER_TOKEN}`,
    });
    expect(body.result?.isError).toBe(true);
    const text = body.result?.content?.[0]?.text ?? '';
    expect(text).toContain('sign-in');
    expect(text).toContain('book_check');
    expect(upstream.calls).toEqual([]);
    const lines = await waitForLogs(harness, 1);
    expect(lines[0]).toMatchObject({ error_type: 'InsufficientScope' });
  });

  it('refuses a client whose signed scope list lacks booking, and still serves its reads', async () => {
    const { harness, upstream } = await start({}, BEHIND_PROXY);
    const { body } = await callBook(
      harness,
      SELECTION,
      signedClient('mcp:me:read')
    );
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain(
      "this connection's sign-in does not include booking"
    );
    expect(upstream.calls).toEqual([]);

    const list = await postMcp(
      harness.baseUrl,
      toolCallBody('me_list_bookings', {}),
      signedClient('mcp:me:read')
    );
    const listBody = (await list.json()) as RpcResult;
    expect(listBody.result?.isError).not.toBe(true);
  });

  it('serves a signed client whose list names booking', async () => {
    const { harness } = await start({}, BEHIND_PROXY);
    const { body } = await callBook(
      harness,
      SELECTION,
      signedClient('mcp:me:read mcp:me:book')
    );
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent?.status).toBe('preview');
  });
});

describe('me_book confirmation tokens', () => {
  async function previewAndReset(scenario: Scenario = {}): Promise<{
    harness: Harness;
    upstream: FakeFetch;
    token: string;
  }> {
    const { harness, upstream } = await start(scenario);
    const { token } = await preview(harness);
    upstream.calls.length = 0;
    return { harness, upstream, token };
  }

  function flipLast(token: string): string {
    return `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  }

  async function expectRefused(
    harness: Harness,
    upstream: FakeFetch,
    args: Record<string, unknown>,
    headers: Record<string, string> = CLIENT_HEADERS
  ): Promise<string> {
    const { body } = await callBook(harness, args, headers);
    expect(body.result?.isError).toBe(true);
    const text = body.result?.content?.[0]?.text ?? '';
    expect(text.startsWith('Nothing was booked')).toBe(true);
    expect(text).toContain('Next:');
    expect(upstream.calls).toEqual([]);
    return text;
  }

  it('refuses a token with a flipped character', async () => {
    const { harness, upstream, token } = await previewAndReset();
    await expectRefused(harness, upstream, {
      ...SELECTION,
      confirmation_token: flipLast(token),
    });
  });

  it('refuses a token made for another sign-in', async () => {
    const { harness, upstream, token } = await previewAndReset();
    await expectRefused(
      harness,
      upstream,
      { ...SELECTION, confirmation_token: token },
      { [DIRECT_USER_TOKEN_HEADER]: 'client-user-token-0002-abcdef' }
    );
  });

  it('refuses a token for a changed selection', async () => {
    const { harness, upstream, token } = await previewAndReset();
    await expectRefused(harness, upstream, {
      ...SELECTION,
      datetime: '2099-01-12T12:00:00+03:00',
      confirmation_token: token,
    });
  });

  it('refuses a token past its expiry', async () => {
    const clock = createFakeClock();
    const confirmations = createConfirmations({ now: clock.now });
    const { harness, upstream, token } = await previewAndReset({
      confirmations,
    });
    await clock.sleep(CONFIRMATION_TTL_MS + 1);
    const text = await expectRefused(harness, upstream, {
      ...SELECTION,
      confirmation_token: token,
    });
    expect(text).toContain('expired');
  });

  it('refuses a token that was used once already, and makes only one booking', async () => {
    const { harness, upstream, token } = await previewAndReset();
    const first = await callBook(harness, {
      ...SELECTION,
      confirmation_token: token,
    });
    expect(first.body.result?.structuredContent?.status).toBe('booked');
    const creates = (): number =>
      upstream.calls.filter(
        (call) =>
          call.method === 'POST' && call.url.pathname.includes('book_record')
      ).length;
    expect(creates()).toBe(1);
    upstream.calls.length = 0;
    await expectRefused(harness, upstream, {
      ...SELECTION,
      confirmation_token: token,
    });
    expect(creates()).toBe(0);
  });

  it('never puts the confirmation secret into a response or a log line', async () => {
    const secret = 'confirmation-secret-0123456789abcdef0123';
    const confirmations = createConfirmations({ secret });
    const { harness } = await start(
      { confirmations },
      { secrets: [CANARY_SECRET, secret] }
    );
    const first = await callBook(harness, SELECTION);
    const token = first.body.result?.structuredContent?.confirmation_token;
    const second = await callBook(harness, {
      ...SELECTION,
      confirmation_token: token,
    });
    await waitForLogs(harness, 2);
    const everything = [
      first.text,
      second.text,
      JSON.stringify(harness.logs),
    ].join('\n');
    expect(everything).not.toContain(secret);
  });
});

// me_reschedule_booking over HTTP (ADR 0006, D-02, D-03): the same two steps
// for a booking the client already has.

async function callChange(
  harness: Harness,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = CLIENT_HEADERS
): Promise<{ body: RpcResult; text: string }> {
  const res = await postMcp(harness.baseUrl, toolCallBody(name, args), headers);
  expect(res.status).toBe(200);
  const text = await res.text();
  return { body: JSON.parse(text) as RpcResult, text };
}

const MOVE = { booking_id: 5, datetime: MOVE_TO };

async function movePreview(
  harness: Harness
): Promise<{ token: string; out: BookOutput }> {
  const { body } = await callChange(harness, 'me_reschedule_booking', MOVE);
  const out = body.result?.structuredContent;
  if (
    out?.confirmation_token === null ||
    out?.confirmation_token === undefined
  ) {
    throw new Error('the preview carried no confirmation token');
  }
  return { token: out.confirmation_token, out };
}

describe('me_reschedule_booking, first call: the preview', () => {
  it('reads the records, the card and the slot, writes nothing and returns a token', async () => {
    const { harness, upstream } = await start();
    const { body, text } = await callChange(
      harness,
      'me_reschedule_booking',
      MOVE
    );
    expect(body.result?.isError).not.toBe(true);
    const out = body.result?.structuredContent;
    expect(out?.status).toBe('preview');
    expect(out?.confirmation_token).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
    expect(text).toContain('Preview, nothing is moved yet');
    expect(routesOf(upstream).sort()).toEqual(
      [
        'GET /user/records',
        `GET /company/${LOCATION}`,
        `POST /book_check/${LOCATION}`,
      ].sort()
    );
    for (const call of upstream.calls) {
      const route = `${call.method} ${call.url.pathname.replace('/api/v1', '')}`;
      expect(call.headers.get('authorization')).toBe(
        route === 'GET /user/records'
          ? USER_AUTHORIZATION
          : PARTNER_AUTHORIZATION
      );
    }
  });

  it('refuses a booking that is not the client own, after reading only the records', async () => {
    const { harness, upstream } = await start();
    const { body } = await callChange(harness, 'me_reschedule_booking', {
      ...MOVE,
      booking_id: 777,
    });
    expect(body.result?.isError).toBe(true);
    const text = body.result?.content?.[0]?.text ?? '';
    expect(text.startsWith('Nothing was moved')).toBe(true);
    expect(text).toContain('me_list_bookings');
    expect(routesOf(upstream)).toEqual(['GET /user/records']);
  });
});

describe('me_reschedule_booking, second call: the move', () => {
  it('moves with exactly the new datetime and the user token, and returns the booking at its new time', async () => {
    const { harness, upstream } = await start();
    const { token } = await movePreview(harness);
    upstream.calls.length = 0;

    const { body, text } = await callChange(harness, 'me_reschedule_booking', {
      ...MOVE,
      confirmation_token: token,
    });
    expect(body.result?.isError).not.toBe(true);
    const out = body.result?.structuredContent;
    expect(out?.status).toBe('moved');
    expect(out?.booking).toMatchObject({
      booking_id: 5,
      status: 'upcoming',
      datetime: MOVED_DATETIME,
    });
    expect(text).toContain('Moved: booking 5');
    expect(routesOf(upstream)).toEqual([
      'GET /user/records',
      `PUT /book_record/${LOCATION}/5`,
      'GET /user/records',
    ]);
    for (const call of upstream.calls) {
      expect(call.headers.get('authorization')).toBe(USER_AUTHORIZATION);
    }
    const put = upstream.calls[1];
    expect(JSON.parse(put?.body ?? 'null')).toEqual({ datetime: MOVE_TO });
  });

  it('says the time was taken when the PUT answers 433, and moves nothing', async () => {
    const { harness, upstream } = await start({ move: 'taken_433' });
    const { token } = await movePreview(harness);
    upstream.calls.length = 0;
    const { body } = await callChange(harness, 'me_reschedule_booking', {
      ...MOVE,
      confirmation_token: token,
    });
    expect(body.result?.isError).toBe(true);
    const text = body.result?.content?.[0]?.text ?? '';
    expect(text).toContain('Nothing was moved: this time was taken meanwhile.');
    expect(text).toContain('business_list_time_slots');
  });

  it('refuses a token that was used once already, and sends one PUT only', async () => {
    const { harness, upstream } = await start();
    const { token } = await movePreview(harness);
    await callChange(harness, 'me_reschedule_booking', {
      ...MOVE,
      confirmation_token: token,
    });
    upstream.calls.length = 0;
    const { body } = await callChange(harness, 'me_reschedule_booking', {
      ...MOVE,
      confirmation_token: token,
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain('already used');
    expect(upstream.calls).toEqual([]);
  });

  it('refuses a token that another tool issued, with no upstream call', async () => {
    const { harness, upstream } = await start();
    const booked = await preview(harness);
    upstream.calls.length = 0;
    const { body } = await callChange(harness, 'me_reschedule_booking', {
      ...MOVE,
      confirmation_token: booked.token,
    });
    expect(body.result?.isError).toBe(true);
    expect(
      (body.result?.content?.[0]?.text ?? '').startsWith('Nothing was moved')
    ).toBe(true);
    expect(upstream.calls).toEqual([]);
  });
});

describe('me_reschedule_booking output and logs', () => {
  it('leaks neither the sign-in, the profile nor a record token into any response or log line', async () => {
    const { harness } = await start();
    const first = await callChange(harness, 'me_reschedule_booking', MOVE);
    const token = first.body.result?.structuredContent?.confirmation_token;
    const second = await callChange(harness, 'me_reschedule_booking', {
      ...MOVE,
      confirmation_token: token,
    });
    await waitForLogs(harness, 2);
    const everything = [
      first.text,
      second.text,
      JSON.stringify(harness.logs),
    ].join('\n');
    for (const bait of BAIT) expect(everything).not.toContain(bait);
  });

  it('takes no phone, name, e-mail or code in its input', () => {
    const tool = productionTools.find(
      (entry) => entry.name === 'me_reschedule_booking'
    );
    const properties = Object.keys(
      (tool?.spec.inputSchema as { properties: Record<string, unknown> })
        .properties
    );
    expect(properties.sort()).toEqual([
      'booking_id',
      'confirmation_token',
      'datetime',
    ]);
  });

  it('is listed as a write that is destructive, for a client caller', async () => {
    const { harness } = await start();
    const res = await postMcp(harness.baseUrl, toolsListBody(), CLIENT_HEADERS);
    const body = (await res.json()) as {
      result?: {
        tools?: { name: string; annotations?: Record<string, unknown> }[];
      };
    };
    const tool = body.result?.tools?.find(
      (entry) => entry.name === 'me_reschedule_booking'
    );
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    });
  });
});

describe('me_reschedule_booking for callers that are not a signed-in client with the book scope', () => {
  it('refuses an anonymous caller in band, naming the sign-in, with no upstream call', async () => {
    const { harness, upstream } = await start();
    const { body } = await callChange(
      harness,
      'me_reschedule_booking',
      MOVE,
      {}
    );
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain('sign-in');
    expect(upstream.calls).toEqual([]);
    const lines = await waitForLogs(harness, 1);
    expect(lines[0]).toMatchObject({
      tool: 'me_reschedule_booking',
      error_type: 'InsufficientScope',
    });
  });

  it('refuses a partner caller the same way', async () => {
    const { harness, upstream } = await start({}, REQUIRED);
    const { body } = await callChange(harness, 'me_reschedule_booking', MOVE, {
      authorization: `Bearer ${PARTNER_TOKEN}`,
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain('sign-in');
    expect(upstream.calls).toEqual([]);
  });

  it('refuses a client whose signed scope list lacks booking', async () => {
    const { harness, upstream } = await start({}, BEHIND_PROXY);
    const { body } = await callChange(
      harness,
      'me_reschedule_booking',
      MOVE,
      signedClient('mcp:me:read')
    );
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain(
      "this connection's sign-in does not include booking"
    );
    expect(upstream.calls).toEqual([]);
  });
});

// me_cancel_booking over HTTP (ADR 0006, D-02, D-03).

const CANCEL = { booking_id: 5 };

async function cancelPreview(
  harness: Harness
): Promise<{ token: string; out: BookOutput }> {
  const { body } = await callChange(harness, 'me_cancel_booking', CANCEL);
  const out = body.result?.structuredContent;
  if (
    out?.confirmation_token === null ||
    out?.confirmation_token === undefined
  ) {
    throw new Error('the preview carried no confirmation token');
  }
  return { token: out.confirmation_token, out };
}

describe('me_cancel_booking over HTTP', () => {
  it('previews with the records and the card, and writes nothing', async () => {
    const { harness, upstream } = await start();
    const { body, text } = await callChange(
      harness,
      'me_cancel_booking',
      CANCEL
    );
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent?.status).toBe('preview');
    expect(text).toContain('Preview, nothing is cancelled yet');
    expect(text).toContain('Online cancellation is allowed');
    expect(routesOf(upstream)).toEqual([
      'GET /user/records',
      `GET /company/${LOCATION}`,
    ]);
    expect(upstream.calls[0]?.headers.get('authorization')).toBe(
      USER_AUTHORIZATION
    );
    expect(upstream.calls[1]?.headers.get('authorization')).toBe(
      PARTNER_AUTHORIZATION
    );
  });

  it('cancels with one DELETE and the user token, and shows the booking as cancelled', async () => {
    const { harness, upstream } = await start();
    const { token } = await cancelPreview(harness);
    upstream.calls.length = 0;
    const { body, text } = await callChange(harness, 'me_cancel_booking', {
      ...CANCEL,
      confirmation_token: token,
    });
    expect(body.result?.isError).not.toBe(true);
    const out = body.result?.structuredContent;
    expect(out?.status).toBe('cancelled');
    expect(out?.booking).toMatchObject({ booking_id: 5, status: 'cancelled' });
    expect(text).toContain('Cancelled: booking 5');
    expect(routesOf(upstream)).toEqual([
      'GET /user/records',
      'DELETE /user/records/5/0',
    ]);
    for (const call of upstream.calls) {
      expect(call.headers.get('authorization')).toBe(USER_AUTHORIZATION);
    }
    expect(upstream.calls[1]?.body).toBeNull();
  });

  it('refuses a booking that is not the client own, after reading only the records', async () => {
    const { harness, upstream } = await start();
    const { body } = await callChange(harness, 'me_cancel_booking', {
      booking_id: 777,
    });
    expect(body.result?.isError).toBe(true);
    expect(
      (body.result?.content?.[0]?.text ?? '').startsWith(
        'Nothing was cancelled'
      )
    ).toBe(true);
    expect(routesOf(upstream)).toEqual(['GET /user/records']);
  });

  it('refuses a token from the reschedule tool, with no upstream call', async () => {
    const { harness, upstream } = await start();
    const moved = await movePreview(harness);
    upstream.calls.length = 0;
    const { body } = await callChange(harness, 'me_cancel_booking', {
      ...CANCEL,
      confirmation_token: moved.token,
    });
    expect(body.result?.isError).toBe(true);
    expect(upstream.calls).toEqual([]);
  });

  it('names the business contacts when the DELETE answers 403, and the booking was not cancelled', async () => {
    const { harness, upstream } = await start({ cancel: 'forbidden_403' });
    const { token } = await cancelPreview(harness);
    upstream.calls.length = 0;
    const { body } = await callChange(harness, 'me_cancel_booking', {
      ...CANCEL,
      confirmation_token: token,
    });
    expect(body.result?.isError).toBe(true);
    const text = body.result?.content?.[0]?.text ?? '';
    expect(text).toContain('Nothing was cancelled');
    expect(text).toContain('business_get');
  });

  it('leaks neither the sign-in, a record token nor the cancel path into any response or log line', async () => {
    const { harness } = await start();
    const first = await callChange(harness, 'me_cancel_booking', CANCEL);
    const token = first.body.result?.structuredContent?.confirmation_token;
    const second = await callChange(harness, 'me_cancel_booking', {
      ...CANCEL,
      confirmation_token: token,
    });
    await waitForLogs(harness, 2);
    const everything = [
      first.text,
      second.text,
      JSON.stringify(harness.logs),
    ].join('\n');
    for (const bait of BAIT) expect(everything).not.toContain(bait);
    expect(everything).not.toContain('/user/records/5');
  });

  it('takes only a booking id and a token, and is listed destructive', async () => {
    const { harness } = await start();
    const tool = productionTools.find(
      (entry) => entry.name === 'me_cancel_booking'
    );
    const properties = Object.keys(
      (tool?.spec.inputSchema as { properties: Record<string, unknown> })
        .properties
    );
    expect(properties.sort()).toEqual(['booking_id', 'confirmation_token']);
    const res = await postMcp(harness.baseUrl, toolsListBody(), CLIENT_HEADERS);
    const body = (await res.json()) as {
      result?: {
        tools?: { name: string; annotations?: Record<string, unknown> }[];
      };
    };
    expect(
      body.result?.tools?.find((entry) => entry.name === 'me_cancel_booking')
        ?.annotations
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    });
  });
});

describe('me_cancel_booking for callers that are not a signed-in client with the book scope', () => {
  it('refuses an anonymous caller in band, naming the sign-in, with no upstream call', async () => {
    const { harness, upstream } = await start();
    const { body } = await callChange(harness, 'me_cancel_booking', CANCEL, {});
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain('sign-in');
    expect(upstream.calls).toEqual([]);
    const lines = await waitForLogs(harness, 1);
    expect(lines[0]).toMatchObject({
      tool: 'me_cancel_booking',
      error_type: 'InsufficientScope',
    });
  });

  it('refuses a partner caller the same way', async () => {
    const { harness, upstream } = await start({}, REQUIRED);
    const { body } = await callChange(harness, 'me_cancel_booking', CANCEL, {
      authorization: `Bearer ${PARTNER_TOKEN}`,
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain('sign-in');
    expect(upstream.calls).toEqual([]);
  });

  it('refuses a client whose signed scope list lacks booking', async () => {
    const { harness, upstream } = await start({}, BEHIND_PROXY);
    const { body } = await callChange(
      harness,
      'me_cancel_booking',
      CANCEL,
      signedClient('mcp:me:read')
    );
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain(
      "this connection's sign-in does not include booking"
    );
    expect(upstream.calls).toEqual([]);
  });
});
