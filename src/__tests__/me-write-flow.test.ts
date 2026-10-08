import { afterEach, describe, expect, it } from '@jest/globals';
import { BookingClient } from '../booking/client.js';
import {
  fakeFetch,
  loadFixture,
  type FakeFetch,
  type FakeRoute,
  type FixtureResponse,
} from '../booking/__tests__/helpers/fake-fetch.js';
import { DIRECT_USER_TOKEN_HEADER } from '../security/caller-auth.js';
import { productionTools } from '../tools/registry.js';
import {
  CANARY_SECRET,
  CLIENT_USER_TOKEN,
  closeAllApps,
  postMcp,
  startApp,
  toolCallBody,
  waitForLogs,
  type Harness,
} from './helpers/http-harness.js';

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
  } | null;
  confirmation_token: string | null;
  expires_at: string | null;
  booking_id: number | null;
  booking: { booking_id: number; status: string; datetime: string } | null;
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
  state: { created: boolean },
  failAfterCreate: boolean
): () => FixtureResponse {
  return () => {
    const fixture = loadFixture('user_records', 'default');
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
    return { ...fixture, body };
  };
}

interface Scenario {
  create?: string;
  profile?: string;
  records?: string;
  recordsAfterCreate?: 'fail';
}

async function start(
  scenario: Scenario = {},
  overrides: Parameters<typeof startApp>[0] = {}
): Promise<{ harness: Harness; upstream: FakeFetch }> {
  const state = { created: false };
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
      reply: loadFixture('book_check', 'created_empty'),
    },
    {
      method: 'POST',
      path: `/book_record/${LOCATION}`,
      reply: () => {
        state.created = true;
        return loadFixture('book_record_create', scenario.create ?? 'created');
      },
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

  it('refuses a place the client has no record at, naming book_check, after reading only the records', async () => {
    const { harness, upstream } = await start();
    const { body } = await callBook(harness, {
      ...SELECTION,
      location_id: 731000,
    });
    expect(body.result?.isError).toBe(true);
    const text = body.result?.content?.[0]?.text ?? '';
    expect(text).toContain('not among the places');
    expect(text).toContain('book_check');
    expect(routesOf(upstream)).toEqual(['GET /user/records']);
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
        'service_ids',
        'team_member_id',
      ].sort()
    );
  });
});
