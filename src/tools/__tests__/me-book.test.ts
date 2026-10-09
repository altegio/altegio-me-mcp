import { describe, expect, it } from '@jest/globals';
import { BookingClient } from '../../booking/client.js';
import {
  fakeFetch,
  loadFixture,
  type FakeFetch,
  type FakeReply,
} from '../../booking/__tests__/helpers/fake-fetch.js';
import { createConfirmations } from '../confirmation.js';
import { NO_TOOL_CONTEXT, type ToolContext } from '../context.js';
import type { ToolInvocation } from '../factory.js';
import { meBook } from '../me-book.js';

// me_book at handler level through the real BookingClient with a fake fetch
// (ADR 0006, D-02): what every create rejection, the anti-fraud paths and an
// unknown outcome say to the model, and that no write error repeats what the
// business wrote back.

const API_BASE = 'https://api.alteg.io/api/v1';
const PARTNER_TOKEN = 'partner-token-0123456789abcdef';
const USER_TOKEN = 'client-user-token-0001-abcdef';
const SECRET = 'confirmation-secret-0123456789abcdef0123';
const LOCATION = 722227;
const CTX: ToolContext = { ...NO_TOOL_CONTEXT, userToken: USER_TOKEN };

const SELECTION = {
  location_id: LOCATION,
  service_ids: [10303531],
  team_member_id: 2098145,
  datetime: '2099-01-12T11:00:00+03:00',
};

const SECOND_TEAM_MEMBER = 2098146;
const PAIR = {
  ...SELECTION,
  second_appointment: {
    service_ids: [10303531],
    team_member_id: SECOND_TEAM_MEMBER,
  },
};

// The contract fixtures quote these in meta.message of every create error.
const BAIT = [
  '+15550000001',
  'Fixture Client',
  'fixture.client@example.invalid',
];

interface Setup {
  upstream: FakeFetch;
  invoke: (args: Record<string, unknown>) => Promise<ToolInvocation>;
}

function setup(
  options: {
    create?: FakeReply;
    check?: FakeReply;
    profile?: FakeReply;
    company?: FakeReply;
    services?: FakeReply;
    /** The card of location 731000, a place the client has no record at. */
    otherCompany?: FakeReply;
    timeoutMs?: number;
  } = {}
): Setup {
  const upstream = fakeFetch([
    {
      method: 'GET',
      path: '/user/records',
      reply: loadFixture('user_records', 'default'),
    },
    {
      method: 'GET',
      path: '/booking/user/data',
      reply: options.profile ?? loadFixture('booking_user_data', 'default'),
    },
    {
      method: 'GET',
      path: `/company/${LOCATION}`,
      reply: options.company ?? loadFixture('company', 'default'),
    },
    {
      method: 'GET',
      path: '/company/731000',
      reply: options.otherCompany ?? loadFixture('company', 'default'),
    },
    {
      method: 'GET',
      path: `/book_services/${LOCATION}`,
      reply: options.services ?? loadFixture('book_services', 'default'),
    },
    {
      method: 'GET',
      path: `/book_staff/${LOCATION}`,
      reply: loadFixture('book_staff', 'default'),
    },
    {
      method: 'POST',
      path: `/book_check/${LOCATION}`,
      reply: options.check ?? loadFixture('book_check', 'created_empty'),
    },
    {
      method: 'POST',
      path: `/book_record/${LOCATION}`,
      reply: options.create ?? loadFixture('book_record_create', 'created'),
    },
  ]);
  const booking = new BookingClient({
    base: API_BASE,
    token: PARTNER_TOKEN,
    fetch: upstream.fetch,
    timeoutMs: options.timeoutMs,
  });
  const deps = {
    booking,
    confirmations: createConfirmations({ secret: SECRET }),
  };
  return {
    upstream,
    invoke: (args) => meBook.invoke(args, deps, CTX),
  };
}

function textOf(invocation: ToolInvocation): string {
  return invocation.result.content.map((part) => part.text).join('\n');
}

interface BookOut {
  status: string;
  booking_id: number | null;
  second_booking_id: number | null;
  fallback: {
    reason: string;
    link: { url: string; kind: string } | null;
    second_link: { url: string; kind: string } | null;
  } | null;
}

/** The preview call, then the confirm call with its token; the upstream calls are cleared between. */
async function previewThenConfirm(
  made: Setup,
  args: Record<string, unknown> = SELECTION
): Promise<{ preview: ToolInvocation; confirm: ToolInvocation }> {
  const preview = await made.invoke(args);
  expect(preview.result.isError).not.toBe(true);
  const token = (
    preview.result.structuredContent as { confirmation_token: string }
  ).confirmation_token;
  made.upstream.calls.length = 0;
  const confirm = await made.invoke({
    ...args,
    confirmation_token: token,
  });
  return { preview, confirm };
}

function expectNoBait(invocation: ToolInvocation): void {
  const everything = `${textOf(invocation)}\n${JSON.stringify(
    invocation.result.structuredContent ?? null
  )}`;
  for (const bait of BAIT) expect(everything).not.toContain(bait);
  expect(everything).not.toContain('Upstream API message');
  expect(everything).not.toContain(USER_TOKEN);
}

describe('me_book confirm path: create rejections by code (D-02)', () => {
  it('says the time was taken meanwhile, for 433, and points to a new preview', async () => {
    const made = setup({
      create: loadFixture('book_record_create', 'taken_433'),
    });
    const { confirm } = await previewThenConfirm(made);
    expect(confirm.result.isError).toBe(true);
    const text = textOf(confirm);
    expect(text).toContain(
      'Nothing was booked: this time was taken meanwhile.'
    );
    expect(text).toContain(
      'Next: choose another time with business_list_time_slots, then call me_book without confirmation_token for a new preview.'
    );
    expectNoBait(confirm);
  });

  it('says the business does not accept this client online, for 434 (HTTP 403), never the sign-in text', async () => {
    const made = setup({
      create: loadFixture('book_record_create', 'blacklisted_434'),
    });
    const { confirm } = await previewThenConfirm(made);
    expect(confirm.result.isError).toBe(true);
    const text = textOf(confirm);
    expect(text).toMatch(/does not accept online bookings from this client/);
    expect(text).toContain('business_get');
    expect(text).not.toMatch(/sign-in|connect again/);
    expectNoBait(confirm);
  });

  it('names a team member choice or another time, for 436', async () => {
    const made = setup({
      create: loadFixture('book_record_create', 'no_team_member_436'),
    });
    const { confirm } = await previewThenConfirm(made);
    const text = textOf(confirm);
    expect(text.startsWith('Nothing was booked')).toBe(true);
    expect(text).toContain('business_list_team_members');
    expect(text).toContain('business_list_time_slots');
    expectNoBait(confirm);
  });

  it('names another time, for 437', async () => {
    const made = setup({
      create: loadFixture('book_record_create', 'overlap_437'),
    });
    const { confirm } = await previewThenConfirm(made);
    const text = textOf(confirm);
    expect(text.startsWith('Nothing was booked')).toBe(true);
    expect(text).toContain('business_list_time_slots');
    expectNoBait(confirm);
  });

  it.each(['phone_431', 'name_435'])(
    'names the Altegio profile and the book_check link, for %s',
    async (scenario) => {
      const made = setup({
        create: loadFixture('book_record_create', scenario),
      });
      const { confirm } = await previewThenConfirm(made);
      const text = textOf(confirm);
      expect(text.startsWith('Nothing was booked')).toBe(true);
      expect(text).toContain('Altegio profile');
      expect(text).toContain('book_check');
      expectNoBait(confirm);
    }
  );

  it('says the business confirms bookings with a code only its widget can request, for 432', async () => {
    const made = setup({
      create: loadFixture('book_record_create', 'code_432'),
    });
    const { confirm } = await previewThenConfirm(made);
    const text = textOf(confirm);
    expect(text).toContain('code');
    expect(text).toContain('booking widget');
    expect(text).toContain('book_check');
    expectNoBait(confirm);
  });

  it('gives a generic refusal and a new preview for a code it does not know', async () => {
    const made = setup({
      create: {
        status: 422,
        body: {
          success: false,
          meta: {
            message: 'Something else: +15550000001 Fixture Client',
            errors: [{ code: 499, message: 'Fixture Client' }],
          },
        },
      },
    });
    const { confirm } = await previewThenConfirm(made);
    const text = textOf(confirm);
    expect(text).toContain(
      'Nothing was booked: the business did not accept this booking.'
    );
    expect(text).toContain('new preview');
    expectNoBait(confirm);
  });

  it('keeps the sign-in message for a 401 on the create', async () => {
    const made = setup({
      create: { status: 401, body: { success: false, meta: { message: 'x' } } },
    });
    const { confirm } = await previewThenConfirm(made);
    expect(confirm.result.isError).toBe(true);
    expect(textOf(confirm)).toContain("did not accept the client's sign-in");
  });

  it('gives the sign-in message when the profile read is refused with 401', async () => {
    const made = setup({
      profile: {
        status: 401,
        body: { success: false, meta: { message: 'x' } },
      },
    });
    const { confirm } = await previewThenConfirm(made);
    expect(confirm.result.isError).toBe(true);
    expect(textOf(confirm)).toContain("did not accept the client's sign-in");
    expect(
      made.upstream.calls.some((call) =>
        call.url.pathname.includes('book_record')
      )
    ).toBe(false);
  });

  it('asks for a new preview, not a repeat, when the profile read fails', async () => {
    const made = setup({
      profile: {
        status: 503,
        body: { success: false, meta: { message: 'x' } },
      },
    });
    const { confirm } = await previewThenConfirm(made);
    expect(confirm.result.isError).toBe(true);
    const text = textOf(confirm);
    expect(text.startsWith('Nothing was booked')).toBe(true);
    expect(text).toContain('without confirmation_token for a new preview');
  });

  it('says the profile lacks a name or phone, and names the profile and book_check, without a create call', async () => {
    for (const scenario of ['no_phone', 'no_name']) {
      const made = setup({
        profile: loadFixture('booking_user_data', scenario),
      });
      const { confirm } = await previewThenConfirm(made);
      expect(confirm.result.isError).toBe(true);
      const text = textOf(confirm);
      expect(text).toContain('no name or phone');
      expect(text).toContain('book_check');
      expect(
        made.upstream.calls.some((call) =>
          call.url.pathname.includes('book_record')
        )
      ).toBe(false);
      expectNoBait(confirm);
    }
  });
});

describe('me_book confirm path: the anti-fraud paths hand off the pre-filled link', () => {
  it.each(['anti_fraud_412', 'fake_201'])(
    'returns the fallback status with the pre-selected link for %s',
    async (scenario) => {
      const made = setup({
        create: loadFixture('book_record_create', scenario),
      });
      const { confirm } = await previewThenConfirm(made);
      expect(confirm.result.isError).not.toBe(true);
      const out = confirm.result.structuredContent as unknown as BookOut;
      expect(out.status).toBe('fallback');
      expect(out.booking_id).toBeNull();
      expect(out.fallback?.reason).toBe('not_confirmed');
      expect(out.fallback?.link?.kind).toBe('preselected');
      expect(out.fallback?.link?.url).toContain('https://n1463903.alteg.io/');
      const text = textOf(confirm);
      expect(text).toContain(
        'Not booked: the business could not confirm this booking from here.'
      );
      expect(text).toContain(out.fallback?.link?.url ?? 'missing');
      expectNoBait(confirm);
    }
  );

  it('treats a 201 whose entry has record id 0 as the fake 201', async () => {
    const made = setup({
      create: {
        status: 201,
        body: {
          success: true,
          data: [{ id: 1, record_id: 0, record_hash: 'fixture-hash-0002' }],
          meta: [],
        },
      },
    });
    const { confirm } = await previewThenConfirm(made);
    const out = confirm.result.structuredContent as unknown as BookOut;
    expect(out.status).toBe('fallback');
    expect(JSON.stringify(confirm.result)).not.toContain('fixture-hash-0002');
  });

  it('falls back to the link for a business that requires a field the profile lacks (the required e-mail)', async () => {
    const made = setup({
      profile: loadFixture('booking_user_data', 'bare_digits_no_email'),
      create: loadFixture('book_record_create', 'required_email_422'),
    });
    const { confirm } = await previewThenConfirm(made);
    expect(confirm.result.isError).not.toBe(true);
    const out = confirm.result.structuredContent as unknown as BookOut;
    expect(out.status).toBe('fallback');
    expect(out.fallback?.reason).toBe('required_field');
    expect(out.fallback?.link?.kind).toBe('preselected');
    expect(textOf(confirm)).toContain('more details');
  });

  it('names book_check when the card cannot be read for the link', async () => {
    let cardReads = 0;
    const made = setup({
      create: loadFixture('book_record_create', 'anti_fraud_412'),
      company: () => {
        cardReads += 1;
        return cardReads === 1
          ? loadFixture('company', 'default')
          : { status: 503, body: { success: false, meta: { message: 'x' } } };
      },
    });
    const { confirm } = await previewThenConfirm(made);
    expect(confirm.result.isError).toBe(true);
    const text = textOf(confirm);
    expect(text).toContain('book_check');
    expect(text.startsWith('Nothing was booked')).toBe(true);
  });
});

describe('me_book confirm path: an unknown outcome never invites a double booking', () => {
  it('says the outcome is unknown and names me_list_bookings, for a create that times out', async () => {
    const made = setup({
      timeoutMs: 50,
      create: () => new Promise<never>(() => undefined),
    });
    const { confirm } = await previewThenConfirm(made);
    expect(confirm.result.isError).toBe(true);
    const text = textOf(confirm);
    expect(text).toContain(
      'The booking service did not answer, so it is not known whether the booking was made.'
    );
    expect(text).toContain(
      'Next: call me_list_bookings to check before booking again; do not repeat this confirmation.'
    );
  });

  it('says the same for a 503 on the create', async () => {
    const made = setup({
      create: { status: 503, body: { success: false, meta: { message: 'x' } } },
    });
    const { confirm } = await previewThenConfirm(made);
    expect(textOf(confirm)).toContain('not known whether the booking was made');
  });

  it('keeps the token used after the unknown outcome, so the same confirmation cannot be repeated', async () => {
    const made = setup({
      create: { status: 503, body: { success: false, meta: { message: 'x' } } },
    });
    const preview = await made.invoke(SELECTION);
    const token = (
      preview.result.structuredContent as { confirmation_token: string }
    ).confirmation_token;
    const args = { ...SELECTION, confirmation_token: token };
    await made.invoke(args);
    made.upstream.calls.length = 0;
    const again = await made.invoke(args);
    expect(again.result.isError).toBe(true);
    expect(textOf(again)).toContain('already used');
    expect(made.upstream.calls).toEqual([]);
  });

  it('asks for a new preview after a 429, because the same token cannot be used twice', async () => {
    const made = setup({
      create: {
        status: 429,
        headers: { 'retry-after': '3' },
        body: { success: false, meta: { message: 'slow down' } },
      },
    });
    const { confirm } = await previewThenConfirm(made);
    expect(confirm.result.isError).toBe(true);
    const text = textOf(confirm);
    expect(text.startsWith('Nothing was booked')).toBe(true);
    expect(text).toContain('without confirmation_token for a new preview');
  });
});

// ME-08, D-04: what the chat cannot do ends at the business's booking widget,
// with the reason and the pre-filled link, in band and with no token.

const PREPAYMENT_SENTENCE =
  "A chosen service needs online prepayment, which only the business's booking widget takes.";
const MEMBERSHIP_SENTENCE =
  "A chosen service is for membership holders, which only the business's booking widget checks.";
const NOT_OWN_PLACE_SENTENCE =
  "This client has no earlier booking at this business, so the booking is completed in the business's booking widget.";
const WIDGET_INACTIVE_SENTENCE =
  'This business does not take online bookings right now.';

interface PreviewOut extends BookOut {
  confirmation_token: string | null;
  preview: { optional_prepayment: boolean } | null;
}

function previewOf(invocation: ToolInvocation): PreviewOut {
  return invocation.result.structuredContent as unknown as PreviewOut;
}

function routesOf(made: Setup): string[] {
  return made.upstream.calls.map(
    (call) => `${call.method} ${call.url.pathname.replace('/api/v1', '')}`
  );
}

function expectFallback(
  invocation: ToolInvocation,
  reason: string,
  sentence: string
): PreviewOut {
  expect(invocation.result.isError).not.toBe(true);
  const out = previewOf(invocation);
  expect(out.status).toBe('fallback');
  expect(out.fallback?.reason).toBe(reason);
  expect(out.confirmation_token).toBeNull();
  expect(out.booking_id).toBeNull();
  expect(textOf(invocation)).toContain(sentence);
  return out;
}

describe('me_book preview: the place is not one of the client own places', () => {
  it('hands off the pre-selected link with the reason not_own_place, after reading only the records and the card', async () => {
    const made = setup();
    const result = await made.invoke({ ...SELECTION, location_id: 731000 });
    const out = expectFallback(result, 'not_own_place', NOT_OWN_PLACE_SENTENCE);
    expect(out.fallback?.link?.kind).toBe('preselected');
    expect(out.fallback?.link?.url).toContain('https://n1463903.alteg.io/');
    expect(out.fallback?.link?.url).toContain('731000');
    expect(textOf(result)).toContain(out.fallback?.link?.url ?? 'missing');
    expect(routesOf(made)).toEqual([
      'GET /user/records',
      'GET /company/731000',
    ]);
    expectNoBait(result);
  });

  it('names the inactive widget instead when that business also takes no online bookings', async () => {
    const made = setup({ otherCompany: loadFixture('company', 'inactive') });
    const result = await made.invoke({ ...SELECTION, location_id: 731000 });
    const out = expectFallback(
      result,
      'widget_inactive',
      WIDGET_INACTIVE_SENTENCE
    );
    expect(out.fallback?.link?.kind).toBe('booking_form');
    expect(routesOf(made)).toEqual([
      'GET /user/records',
      'GET /company/731000',
    ]);
  });
});

describe('me_book preview: prepayment, membership and an unknown prepayment', () => {
  it('hands off the pre-selected link for a service whose prepayment is required, with no slot check and no token', async () => {
    const made = setup();
    const result = await made.invoke({ ...SELECTION, service_ids: [10303532] });
    const out = expectFallback(result, 'prepayment', PREPAYMENT_SENTENCE);
    expect(out.fallback?.link?.kind).toBe('preselected');
    expect(routesOf(made)).not.toContain(`POST /book_check/${LOCATION}`);
    expect(textOf(result)).toContain(out.fallback?.link?.url ?? 'missing');
  });

  it('treats a service whose prepaid slug is unknown as prepayment', async () => {
    const services = loadFixture('book_services', 'default');
    const body = structuredClone(services.body) as {
      data: { services: { id: number; prepaid: unknown }[] };
    };
    const target = body.data.services.find((entry) => entry.id === 10303531);
    if (target === undefined) throw new Error('fixture service is missing');
    target.prepaid = 'mandatory_soon';
    const made = setup({ services: { ...services, body } });
    const result = await made.invoke(SELECTION);
    expectFallback(result, 'prepayment', PREPAYMENT_SENTENCE);
    expect(routesOf(made)).not.toContain(`POST /book_check/${LOCATION}`);
  });

  it('treats a service whose prepaid key is missing as prepayment', async () => {
    const services = loadFixture('book_services', 'default');
    const body = structuredClone(services.body) as {
      data: { services: Record<string, unknown>[] };
    };
    const target = body.data.services.find((entry) => entry.id === 10303531);
    if (target === undefined) throw new Error('fixture service is missing');
    delete target.prepaid;
    const made = setup({ services: { ...services, body } });
    expectFallback(
      await made.invoke(SELECTION),
      'prepayment',
      PREPAYMENT_SENTENCE
    );
  });

  it('hands off the link for a membership-only service, with no slot check and no token', async () => {
    const made = setup({
      services: loadFixture('book_services', 'membership_only'),
    });
    const result = await made.invoke(SELECTION);
    const out = expectFallback(result, 'membership', MEMBERSHIP_SENTENCE);
    expect(out.fallback?.link?.kind).toBe('preselected');
    expect(routesOf(made)).not.toContain(`POST /book_check/${LOCATION}`);
  });

  it('names prepayment before membership when both apply', async () => {
    const made = setup({
      services: loadFixture('book_services', 'membership_only'),
    });
    const result = await made.invoke({
      ...SELECTION,
      service_ids: [10303531, 10303532],
    });
    expect(previewOf(result).fallback?.reason).toBe('prepayment');
  });

  it('keeps a normal preview for optional prepayment and says the widget offers it', async () => {
    const made = setup();
    const result = await made.invoke({ ...SELECTION, service_ids: [10303533] });
    expect(result.result.isError).not.toBe(true);
    const out = previewOf(result);
    expect(out.status).toBe('preview');
    expect(out.confirmation_token).not.toBeNull();
    expect(out.preview?.optional_prepayment).toBe(true);
    expect(textOf(result)).toContain(
      'The business also offers optional online prepayment in its booking widget'
    );
  });

  it('does not mention prepayment for a service that offers none', async () => {
    const made = setup();
    const result = await made.invoke(SELECTION);
    expect(previewOf(result).preview?.optional_prepayment).toBe(false);
    expect(textOf(result)).not.toContain('optional online prepayment');
  });
});

describe('me_book preview: a widget that is inactive or has no form', () => {
  it('hands off the plain booking-form link for an inactive widget that has a form URL, with no slot check and no token', async () => {
    const made = setup({ company: loadFixture('company', 'inactive') });
    const result = await made.invoke(SELECTION);
    const out = expectFallback(
      result,
      'widget_inactive',
      WIDGET_INACTIVE_SENTENCE
    );
    expect(out.fallback?.link).toEqual({
      url: `https://n1463903.alteg.io/company/${LOCATION}`,
      kind: 'booking_form',
    });
    expect(textOf(result)).toContain(out.fallback?.link?.url ?? 'missing');
    expect(routesOf(made)).not.toContain(`POST /book_check/${LOCATION}`);
  });

  it('gives no link and names the business contacts when the card has no usable form', async () => {
    const made = setup({ company: loadFixture('company', 'no_forms') });
    const result = await made.invoke(SELECTION);
    const out = expectFallback(
      result,
      'widget_inactive',
      WIDGET_INACTIVE_SENTENCE
    );
    expect(out.fallback?.link).toBeNull();
    const text = textOf(result);
    expect(text).toContain('business_get');
    expect(text).not.toMatch(/https?:\/\//);
    expect(routesOf(made)).not.toContain(`POST /book_check/${LOCATION}`);
  });
});

describe('me_book fallbacks: the confirm path keeps its own', () => {
  it('still returns not_confirmed for an anti-fraud answer of the create', async () => {
    const made = setup({
      create: loadFixture('book_record_create', 'anti_fraud_412'),
    });
    const { confirm } = await previewThenConfirm(made);
    expect(previewOf(confirm).fallback?.reason).toBe('not_confirmed');
    expect(textOf(confirm)).toContain(
      'Not booked: the business could not confirm this booking from here.'
    );
  });
});

describe('me_book pair rule: two different named team members, before any upstream call (D-01, T-05-04)', () => {
  const REFUSAL =
    'Nothing was booked: two appointments need two different named team members.';

  it.each([
    ['team member 0 in the first appointment', { ...PAIR, team_member_id: 0 }],
    [
      'team member 0 in the second appointment',
      {
        ...PAIR,
        second_appointment: { ...PAIR.second_appointment, team_member_id: 0 },
      },
    ],
    [
      'the same team member twice',
      {
        ...PAIR,
        second_appointment: {
          ...PAIR.second_appointment,
          team_member_id: SELECTION.team_member_id,
        },
      },
    ],
  ])(
    'refuses %s, with a next action and zero upstream calls',
    async (_label, args) => {
      const made = setup();
      const result = await made.invoke(args);
      expect(result.result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain(REFUSAL);
      expect(text).toContain('Next: choose two different team members');
      expect(text).toContain('business_list_team_members');
      expect(made.upstream.calls).toEqual([]);
    }
  );

  it('refuses the same pair on the confirm call too, even with a token', async () => {
    const made = setup();
    const result = await made.invoke({
      ...PAIR,
      team_member_id: 0,
      confirmation_token: '1.x',
    });
    expect(result.result.isError).toBe(true);
    expect(textOf(result)).toContain(REFUSAL);
    expect(made.upstream.calls).toEqual([]);
  });

  it('takes no detail of the second person: a name, phone, e-mail or comment is a schema error', async () => {
    const made = setup();
    for (const extra of [
      { fullname: 'x' },
      { phone: '+15550000009' },
      { email: 'x@example.invalid' },
      { comment: 'x' },
    ]) {
      const result = await made.invoke({
        ...PAIR,
        second_appointment: { ...PAIR.second_appointment, ...extra },
      });
      expect(result.result.isError).toBe(true);
    }
    expect(made.upstream.calls).toEqual([]);
  });
});

// Two people side by side (CASE-02, D-01): every way a pair can fail answers in
// band, a half-done pair is named as such, the widget hand-off gives one link
// per appointment and no token crosses between a single booking and a pair.

const TAKEN_PAIR =
  'Nothing was booked: one of the two times is no longer free.';
const TAKEN_PAIR_NEXT =
  'Next: choose another time with business_list_time_slots for both team members, then call me_book without confirmation_token for a new preview.';
const NOT_AVAILABLE_PAIR =
  'Nothing was booked: a chosen team member is not available at this time.';
const SAME_MEMBER_PAIR =
  'Nothing was booked: one team member cannot take both appointments at this time.';

describe('me_book pair check: the answer of the booking service', () => {
  it.each([
    ['pair_taken_433', TAKEN_PAIR],
    ['no_member_436', NOT_AVAILABLE_PAIR],
    ['pair_same_member_437', SAME_MEMBER_PAIR],
    ['pair_same_member_coded_437', SAME_MEMBER_PAIR],
  ])(
    'answers the %s check with the pair text and no token',
    async (scenario, sentence) => {
      const made = setup({ check: loadFixture('book_check', scenario) });
      const result = await made.invoke(PAIR);
      expect(result.result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain(sentence);
      expect(text).toContain('Next:');
      expect(text).toContain('business_list_');
      expect(result.result.structuredContent).toBeUndefined();
      expect(
        made.upstream.calls.some((call) =>
          call.url.pathname.includes('book_record')
        )
      ).toBe(false);
    }
  );

  it('names the time slots of both team members for a taken pair, and two different team members for the same one twice', async () => {
    const taken = await setup({
      check: loadFixture('book_check', 'pair_taken_433'),
    }).invoke(PAIR);
    expect(textOf(taken)).toContain(TAKEN_PAIR_NEXT);
    const same = await setup({
      check: loadFixture('book_check', 'pair_same_member_437'),
    }).invoke(PAIR);
    expect(textOf(same)).toContain('choose two different team members');
  });

  it('keeps the single-booking text for a single check', async () => {
    const made = setup({ check: loadFixture('book_check', 'taken_433') });
    const text = textOf(await made.invoke(SELECTION));
    expect(text).not.toContain('one of the two');
  });
});

describe('me_book pair confirm: create rejections', () => {
  it.each([
    ['taken_433', TAKEN_PAIR],
    ['no_team_member_436', NOT_AVAILABLE_PAIR],
    ['overlap_437', SAME_MEMBER_PAIR],
  ])(
    'answers the %s create with the pair text and quotes nothing',
    async (scenario, sentence) => {
      const made = setup({
        create: loadFixture('book_record_create', scenario),
      });
      const { confirm } = await previewThenConfirm(made, PAIR);
      expect(confirm.result.isError).toBe(true);
      const text = textOf(confirm);
      expect(text).toContain(sentence);
      expect(text).toContain('without confirmation_token for a new preview');
      expectNoBait(confirm);
    }
  );

  it('answers the code-less 422 the probe recorded for one team member twice with the same-member text', async () => {
    const made = setup({
      create: {
        status: 422,
        body: {
          success: false,
          data: null,
          meta: {
            message:
              'Failed to register: the team member does not have enough time to perform the selected services. +15550000001 Fixture Client',
            errors: [],
          },
        },
      },
    });
    const { confirm } = await previewThenConfirm(made, PAIR);
    expect(textOf(confirm)).toContain(SAME_MEMBER_PAIR);
    expectNoBait(confirm);
  });

  it('keeps the single texts for a single booking', async () => {
    const made = setup({
      create: loadFixture('book_record_create', 'taken_433'),
    });
    const { confirm } = await previewThenConfirm(made);
    expect(textOf(confirm)).toContain(
      'Nothing was booked: this time was taken meanwhile.'
    );
  });

  it.each([
    ['blacklisted_434', /does not accept online bookings from this client/],
    ['phone_431', /Altegio profile/],
    ['name_435', /Altegio profile/],
    ['code_432', /confirms bookings with a code/],
  ])(
    'keeps today text for the %s create of a pair',
    async (scenario, pattern) => {
      const made = setup({
        create: loadFixture('book_record_create', scenario),
      });
      const { confirm } = await previewThenConfirm(made, PAIR);
      expect(confirm.result.isError).toBe(true);
      expect(textOf(confirm)).toMatch(pattern);
      expectNoBait(confirm);
    }
  );
});

describe('me_book pair confirm: only one of the two appointments is named', () => {
  it('returns partially_booked with the booked id and the next action, for an answer that names the first only', async () => {
    const made = setup({
      create: loadFixture('book_record_create', 'created_pair_partial'),
    });
    const { confirm } = await previewThenConfirm(made, PAIR);
    expect(confirm.result.isError).not.toBe(true);
    const out = confirm.result.structuredContent as unknown as BookOut;
    expect(out.status).toBe('partially_booked');
    expect(out.booking_id).toBe(990001);
    expect(out.second_booking_id).toBeNull();
    const text = textOf(confirm);
    expect(text).toContain(
      'Only one of the two appointments was booked: booking 990001.'
    );
    expect(text).toContain('Next: tell the user');
    expect(text).toContain('me_book on its own after a new preview');
    expect(text).toContain('cancel booking 990001 with me_cancel_booking');
    expectNoBait(confirm);
    expect(JSON.stringify(confirm.result)).not.toContain('fixture-hash');
  });

  it('returns the same shape for an answer that names the second only', async () => {
    const made = setup({
      create: {
        status: 201,
        body: {
          success: true,
          data: [
            { id: 1 },
            { id: 2, record_id: 990002, record_hash: 'fixture-hash-0003' },
          ],
          meta: [],
        },
      },
    });
    const { confirm } = await previewThenConfirm(made, PAIR);
    const out = confirm.result.structuredContent as unknown as BookOut;
    expect(out.status).toBe('partially_booked');
    expect(out.booking_id).toBeNull();
    expect(out.second_booking_id).toBe(990002);
    expect(textOf(confirm)).toContain(
      'Only one of the two appointments was booked: booking 990002.'
    );
    expect(textOf(confirm)).toContain(
      'cancel booking 990002 with me_cancel_booking'
    );
  });
});

describe('me_book pair fallbacks: one link for each appointment', () => {
  const WIDGET_ONE_AT_A_TIME =
    "The business's booking widget books one appointment at a time, so there is one link for each appointment.";

  function expectBothLinks(invocation: ToolInvocation): void {
    const out = previewOf(invocation);
    expect(out.fallback?.link?.kind).toBe('preselected');
    expect(out.fallback?.second_link?.kind).toBe('preselected');
    expect(out.fallback?.link?.url).toContain('m2098145');
    expect(out.fallback?.second_link?.url).toContain(`m${SECOND_TEAM_MEMBER}`);
    expect(out.fallback?.link?.url).toContain('s10303531');
    const text = textOf(invocation);
    expect(text).toContain(WIDGET_ONE_AT_A_TIME);
    expect(text).toContain(out.fallback?.link?.url ?? 'missing');
    expect(text).toContain(out.fallback?.second_link?.url ?? 'missing');
    expect(text).toContain('first appointment');
    expect(text).toContain('second appointment');
  }

  it.each(['anti_fraud_412', 'fake_201'])(
    'gives not_confirmed with both links for %s on a pair',
    async (scenario) => {
      const made = setup({
        create: loadFixture('book_record_create', scenario),
      });
      const { confirm } = await previewThenConfirm(made, PAIR);
      expect(confirm.result.isError).not.toBe(true);
      expect(previewOf(confirm).status).toBe('fallback');
      expect(previewOf(confirm).fallback?.reason).toBe('not_confirmed');
      expectBothLinks(confirm);
      expectNoBait(confirm);
    }
  );

  it('gives required_field with both links for a business that needs the e-mail', async () => {
    const made = setup({
      profile: loadFixture('booking_user_data', 'bare_digits_no_email'),
      create: loadFixture('book_record_create', 'required_email_422'),
    });
    const { confirm } = await previewThenConfirm(made, PAIR);
    expect(previewOf(confirm).fallback?.reason).toBe('required_field');
    expectBothLinks(confirm);
  });

  it('gives not_own_place with both links, after reading only the records and the card', async () => {
    const made = setup();
    const result = await made.invoke({ ...PAIR, location_id: 731000 });
    expectFallback(result, 'not_own_place', NOT_OWN_PLACE_SENTENCE);
    const out = previewOf(result);
    expect(out.fallback?.second_link?.url).toContain('731000');
    expect(out.fallback?.second_link?.url).toContain(`m${SECOND_TEAM_MEMBER}`);
    expect(routesOf(made)).toEqual([
      'GET /user/records',
      'GET /company/731000',
    ]);
  });

  it('gives prepayment with both links when the second appointment has a prepayment-required service', async () => {
    const made = setup();
    const result = await made.invoke({
      ...PAIR,
      second_appointment: {
        ...PAIR.second_appointment,
        service_ids: [10303532],
      },
    });
    expectFallback(result, 'prepayment', PREPAYMENT_SENTENCE);
    expect(previewOf(result).fallback?.second_link?.url).toContain('s10303532');
    expect(previewOf(result).fallback?.link?.url).toContain('s10303531');
    expect(routesOf(made)).not.toContain(`POST /book_check/${LOCATION}`);
  });

  it('gives prepayment when it is the first appointment that has one', async () => {
    const made = setup();
    const result = await made.invoke({
      ...PAIR,
      service_ids: [10303532],
    });
    expectFallback(result, 'prepayment', PREPAYMENT_SENTENCE);
  });

  it('gives membership with both links when the second appointment has a membership-only service', async () => {
    const made = setup({
      services: loadFixture('book_services', 'membership_only'),
    });
    const result = await made.invoke({
      ...PAIR,
      service_ids: [10303533],
    });
    expectFallback(result, 'membership', MEMBERSHIP_SENTENCE);
    expect(previewOf(result).fallback?.second_link?.kind).toBe('preselected');
    expect(routesOf(made)).not.toContain(`POST /book_check/${LOCATION}`);
  });

  it('gives widget_inactive with the plain form link and no second link', async () => {
    const made = setup({ company: loadFixture('company', 'inactive') });
    const result = await made.invoke(PAIR);
    const out = expectFallback(
      result,
      'widget_inactive',
      WIDGET_INACTIVE_SENTENCE
    );
    expect(out.fallback?.link?.kind).toBe('booking_form');
    expect(out.fallback?.second_link).toBeNull();
    expect(textOf(result)).not.toContain(WIDGET_ONE_AT_A_TIME);
  });

  it('gives a single booking no second link and no per-appointment wording', async () => {
    const made = setup();
    const result = await made.invoke({ ...SELECTION, service_ids: [10303532] });
    const out = expectFallback(result, 'prepayment', PREPAYMENT_SENTENCE);
    expect(out.fallback?.second_link).toBeNull();
    expect(textOf(result)).not.toContain('one link for each appointment');
  });
});

describe('me_book tokens do not cross between a single booking and a pair (T-05-05)', () => {
  const NOT_VALID =
    'Nothing was booked: this confirmation_token is not valid for this selection and sign-in.';

  async function tokenOf(made: Setup, args: Record<string, unknown>) {
    const result = await made.invoke(args);
    const token = (
      result.result.structuredContent as { confirmation_token: string }
    ).confirmation_token;
    made.upstream.calls.length = 0;
    return token;
  }

  async function expectNotValid(
    made: Setup,
    args: Record<string, unknown>
  ): Promise<void> {
    const result = await made.invoke(args);
    expect(result.result.isError).toBe(true);
    expect(textOf(result)).toContain(NOT_VALID);
    expect(made.upstream.calls).toEqual([]);
  }

  it('refuses a single token for a pair', async () => {
    const made = setup();
    const token = await tokenOf(made, SELECTION);
    await expectNotValid(made, { ...PAIR, confirmation_token: token });
  });

  it('refuses a pair token for a single booking', async () => {
    const made = setup();
    const token = await tokenOf(made, PAIR);
    await expectNotValid(made, { ...SELECTION, confirmation_token: token });
  });

  it('refuses a pair token for a changed second team member or second service', async () => {
    const made = setup();
    const token = await tokenOf(made, PAIR);
    await expectNotValid(made, {
      ...PAIR,
      second_appointment: {
        ...PAIR.second_appointment,
        team_member_id: 2098147,
      },
      confirmation_token: token,
    });
    await expectNotValid(made, {
      ...PAIR,
      second_appointment: {
        ...PAIR.second_appointment,
        service_ids: [10303533],
      },
      confirmation_token: token,
    });
  });

  it('still books the pair with the pair token', async () => {
    const made = setup({
      create: loadFixture('book_record_create', 'created_pair'),
    });
    const token = await tokenOf(made, PAIR);
    const result = await made.invoke({ ...PAIR, confirmation_token: token });
    expect(result.result.isError).not.toBe(true);
    expect(previewOf(result).status).toBe('booked');
  });
});
