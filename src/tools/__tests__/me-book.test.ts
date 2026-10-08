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
    profile?: FakeReply;
    company?: FakeReply;
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
  fallback: {
    reason: string;
    link: { url: string; kind: string } | null;
  } | null;
}

/** The preview call, then the confirm call with its token; the upstream calls are cleared between. */
async function previewThenConfirm(
  made: Setup
): Promise<{ preview: ToolInvocation; confirm: ToolInvocation }> {
  const preview = await made.invoke(SELECTION);
  expect(preview.result.isError).not.toBe(true);
  const token = (
    preview.result.structuredContent as { confirmation_token: string }
  ).confirmation_token;
  made.upstream.calls.length = 0;
  const confirm = await made.invoke({
    ...SELECTION,
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
