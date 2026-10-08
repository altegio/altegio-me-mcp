import { describe, expect, it } from '@jest/globals';
import { BookingClient } from '../../booking/client.js';
import {
  fakeFetch,
  loadFixture,
  type FakeFetch,
  type FakeReply,
  type FixtureResponse,
  type RecordedCall,
} from '../../booking/__tests__/helpers/fake-fetch.js';
import { createConfirmations, type Confirmations } from '../confirmation.js';
import { NO_TOOL_CONTEXT, type ToolContext } from '../context.js';
import type { ToolInvocation } from '../factory.js';
import { meCancelBooking, meRescheduleBooking } from '../me-change.js';
import { meListBookings } from '../me.js';
import { SCOPE_BOOK, SCOPE_READ } from '../scopes.js';

// me_reschedule_booking at handler level through the real BookingClient with a
// fake fetch (ADR 0006, D-02, D-03): the preview reads and checks and writes
// nothing, the confirm moves with the user token and nothing else, and every
// refusal comes before any write.

const API_BASE = 'https://api.alteg.io/api/v1';
const PARTNER_TOKEN = 'partner-token-0123456789abcdef';
const USER_TOKEN = 'client-user-token-0001-abcdef';
const SECRET = 'confirmation-secret-0123456789abcdef0123';
const LOCATION = 722227;
const CTX: ToolContext = { ...NO_TOOL_CONTEXT, userToken: USER_TOKEN };
const USER_AUTHORIZATION = `Bearer ${PARTNER_TOKEN}, User ${USER_TOKEN}`;
const PARTNER_AUTHORIZATION = `Bearer ${PARTNER_TOKEN}`;

const NEW_TIME = '2099-01-13T11:00:00+03:00';
const MOVE = { booking_id: 5, datetime: NEW_TIME };

// Quoted by the contract fixtures, and the secrets of record 5.
const BAIT = [
  USER_TOKEN,
  '+15550000001',
  'Fixture Client',
  'fixture.client@example.invalid',
  'fixture-hash-0005',
];

type Records = { data: Record<string, unknown>[] };

/** The default records, changed by `edit`. */
function records(edit: (body: Records) => void): FixtureResponse {
  const fixture = loadFixture('user_records', 'default');
  const body = structuredClone(fixture.body) as Records;
  edit(body);
  return { ...fixture, body };
}

function recordFive(body: Records): Record<string, unknown> {
  const found = body.data.find((entry) => entry.id === 5);
  if (found === undefined) throw new Error('fixture record 5 is missing');
  return found;
}

/** The records once record 5 sits at the new time. */
function recordsAfterMove(): FixtureResponse {
  return records((body) => {
    Object.assign(recordFive(body), {
      datetime: '2099-01-13T11:00:00+0300',
      date: '2099-01-13 11:00:00',
    });
  });
}

function card(edit: (data: Record<string, unknown>) => void): FixtureResponse {
  const fixture = loadFixture('company', 'default');
  const body = structuredClone(fixture.body) as {
    data: Record<string, unknown>;
  };
  edit(body.data);
  return { ...fixture, body };
}

interface Setup {
  upstream: FakeFetch;
  confirmations: Confirmations;
  invoke: (
    args: Record<string, unknown>,
    ctx?: ToolContext
  ) => Promise<ToolInvocation>;
  invokeCancel: (
    args: Record<string, unknown>,
    ctx?: ToolContext
  ) => Promise<ToolInvocation>;
}

function setup(
  options: {
    records?: FakeReply;
    company?: FakeReply;
    check?: FakeReply;
    move?: FakeReply;
    cancel?: FakeReply;
    timeoutMs?: number;
  } = {}
): Setup {
  const upstream = fakeFetch([
    {
      method: 'GET',
      path: '/user/records',
      reply: options.records ?? loadFixture('user_records', 'default'),
    },
    {
      method: 'GET',
      path: `/company/${LOCATION}`,
      reply: options.company ?? loadFixture('company', 'default'),
    },
    {
      method: 'POST',
      path: `/book_check/${LOCATION}`,
      reply: options.check ?? loadFixture('book_check', 'created_empty'),
    },
    {
      method: 'PUT',
      path: `/book_record/${LOCATION}/5`,
      reply: options.move ?? loadFixture('book_record_move', 'moved'),
    },
    {
      method: 'DELETE',
      path: '/user/records/5/0',
      reply: options.cancel ?? loadFixture('user_record_cancel', 'cancelled'),
    },
  ]);
  const booking = new BookingClient({
    base: API_BASE,
    token: PARTNER_TOKEN,
    fetch: upstream.fetch,
    timeoutMs: options.timeoutMs,
  });
  const confirmations = createConfirmations({ secret: SECRET });
  const deps = { booking, confirmations };
  return {
    upstream,
    confirmations,
    invoke: (args, ctx = CTX) => meRescheduleBooking.invoke(args, deps, ctx),
    invokeCancel: (args, ctx = CTX) => meCancelBooking.invoke(args, deps, ctx),
  };
}

/** Records that show record 5 at the new time once the PUT has been made. */
function setupMoving(): Setup {
  const state = { moved: false };
  return setup({
    records: () =>
      state.moved ? recordsAfterMove() : loadFixture('user_records', 'default'),
    move: () => {
      state.moved = true;
      return loadFixture('book_record_move', 'moved');
    },
  });
}

function textOf(invocation: ToolInvocation): string {
  return invocation.result.content.map((part) => part.text).join('\n');
}

function routesOf(upstream: FakeFetch): string[] {
  return upstream.calls.map(
    (call) => `${call.method} ${call.url.pathname.replace('/api/v1', '')}`
  );
}

interface MoveOut {
  status: string;
  booking: { booking_id: number; status: string; datetime: string } | null;
  preview: {
    business: string | null;
    from: { date: string; time: string; utc_offset: string };
    to: { date: string; time: string; utc_offset: string };
    move_rule: string | null;
  } | null;
  confirmation_token: string | null;
  expires_at: string | null;
}

function outOf(invocation: ToolInvocation): MoveOut {
  return invocation.result.structuredContent as unknown as MoveOut;
}

function expectNoBait(invocation: ToolInvocation): void {
  const everything = `${textOf(invocation)}\n${JSON.stringify(
    invocation.result.structuredContent ?? null
  )}`;
  for (const bait of BAIT) expect(everything).not.toContain(bait);
  expect(everything).not.toContain('Upstream API message');
}

/** The preview call, then the confirm call with its token; the upstream calls are cleared between. */
async function previewThenConfirm(
  made: Setup
): Promise<{ preview: ToolInvocation; confirm: ToolInvocation }> {
  const preview = await made.invoke(MOVE);
  expect(preview.result.isError).not.toBe(true);
  const token = outOf(preview).confirmation_token;
  made.upstream.calls.length = 0;
  const confirm = await made.invoke({
    ...MOVE,
    confirmation_token: token,
  });
  return { preview, confirm };
}

function authorizationOf(call: RecordedCall): string | null {
  return call.headers.get('authorization');
}

describe('me_reschedule_booking: the tool', () => {
  it('is a write tool for the book tier, annotated destructive and open-world', () => {
    expect(meRescheduleBooking.name).toBe('me_reschedule_booking');
    expect(meRescheduleBooking.spec.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    });
    expect(meRescheduleBooking.meta.scopes).toEqual(
      expect.arrayContaining([SCOPE_READ, SCOPE_BOOK])
    );
  });

  it('takes a booking id, a slot datetime and a token, and no personal data', () => {
    const properties = Object.keys(
      (
        meRescheduleBooking.spec.inputSchema as {
          properties: Record<string, unknown>;
        }
      ).properties
    );
    expect(properties.sort()).toEqual([
      'booking_id',
      'confirmation_token',
      'datetime',
    ]);
  });
});

describe('me_reschedule_booking, first call: the preview', () => {
  it('shows the booking, the old and new time and the move rule, and writes nothing', async () => {
    const made = setup();
    const preview = await made.invoke(MOVE);
    expect(preview.result.isError).not.toBe(true);
    const out = outOf(preview);
    expect(out.status).toBe('preview');
    expect(out.booking).toMatchObject({
      booking_id: 5,
      status: 'upcoming',
      datetime: '2099-01-12T10:00:00+0300',
    });
    expect(out.preview).toEqual({
      business: 'Fixture Barber',
      from: { date: '2099-01-12', time: '10:00', utc_offset: '+03:00' },
      to: { date: '2099-01-13', time: '11:00', utc_offset: '+03:00' },
      move_rule: 'Online moving is allowed until 2 hours before the start.',
    });
    expect(out.confirmation_token).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(out.expires_at ?? '')).toBeGreaterThan(Date.now());
    const text = textOf(preview);
    expect(text).toContain('Preview, nothing is moved yet');
    expect(text).toContain('only after the user agrees');
    expect(text).toContain(out.confirmation_token ?? 'missing');
    expect(text).toContain('Online moving is allowed until 2 hours');
    expectNoBait(preview);
  });

  it('reads the records, the card and checks the slot with the booking services and team member', async () => {
    const made = setup();
    await made.invoke(MOVE);
    expect(made.upstream.unmatched).toEqual([]);
    expect(routesOf(made.upstream)).toEqual([
      'GET /user/records',
      `GET /company/${LOCATION}`,
      `POST /book_check/${LOCATION}`,
    ]);
    const [recordsCall, , checkCall] = made.upstream.calls;
    expect(JSON.parse(checkCall?.body ?? 'null')).toEqual({
      appointments: [
        {
          id: 1,
          services: [10303531],
          staff_id: 2098145,
          datetime: NEW_TIME,
        },
      ],
    });
    // The user token goes on the records call only.
    expect(recordsCall ? authorizationOf(recordsCall) : null).toBe(
      USER_AUTHORIZATION
    );
    for (const call of made.upstream.calls.slice(1)) {
      expect(authorizationOf(call)).toBe(PARTNER_AUTHORIZATION);
    }
  });

  it('names another time and issues no token when the new time is taken', async () => {
    const made = setup({ check: loadFixture('book_check', 'taken_433') });
    const preview = await made.invoke(MOVE);
    expect(preview.result.isError).toBe(true);
    expect(textOf(preview)).toContain('business_list_time_slots');
    expect(textOf(preview)).not.toContain('confirmation_token ');
    expect(routesOf(made.upstream)).not.toContain(
      `PUT /book_record/${LOCATION}/5`
    );
  });

  it('says the time could not be checked, with a move wording, for a 503 on the check', async () => {
    const made = setup({ check: loadFixture('book_check', 'unavailable_503') });
    const preview = await made.invoke(MOVE);
    expect(preview.result.isError).toBe(true);
    expect(textOf(preview)).toContain(
      'Nothing was moved: the time could not be checked just now.'
    );
  });
});

describe('me_reschedule_booking: refusals before any slot check or write', () => {
  it('refuses a booking id that is not among the records, naming me_list_bookings, after the records call only', async () => {
    const made = setup();
    const preview = await made.invoke({ ...MOVE, booking_id: 777 });
    expect(preview.result.isError).toBe(true);
    const text = textOf(preview);
    expect(text.startsWith('Nothing was moved')).toBe(true);
    expect(text).toContain('me_list_bookings');
    expect(routesOf(made.upstream)).toEqual(['GET /user/records']);
  });

  it('refuses a cancelled booking and a past one, saying why, after the records call only', async () => {
    for (const [bookingId, reason] of [
      [4, 'cancelled'],
      [1, 'in the past'],
    ] as const) {
      const made = setup();
      const preview = await made.invoke({ ...MOVE, booking_id: bookingId });
      expect(preview.result.isError).toBe(true);
      const text = textOf(preview);
      expect(text.startsWith('Nothing was moved')).toBe(true);
      expect(text).toContain(reason);
      expect(routesOf(made.upstream)).toEqual(['GET /user/records']);
    }
  });

  it('refuses a record whose flag forbids the change online, naming the business contacts, with no slot check', async () => {
    const made = setup({
      records: records((body) => {
        recordFive(body).allow_change_record = false;
      }),
    });
    const preview = await made.invoke(MOVE);
    expect(preview.result.isError).toBe(true);
    const text = textOf(preview);
    expect(text).toContain(
      'the business does not allow moving this booking online'
    );
    expect(text).toContain('business_get');
    expect(routesOf(made.upstream)).toEqual(['GET /user/records']);
  });

  it('refuses a business whose card forbids moves, with no slot check', async () => {
    const made = setup({
      company: card((data) => {
        data.allow_change_record = false;
      }),
    });
    const preview = await made.invoke(MOVE);
    expect(preview.result.isError).toBe(true);
    const text = textOf(preview);
    expect(text).toContain(
      'the business does not allow moving this booking online'
    );
    expect(text).toContain('business_get');
    expect(routesOf(made.upstream)).toEqual([
      'GET /user/records',
      `GET /company/${LOCATION}`,
    ]);
  });

  it('refuses without any upstream call for a caller with no client sign-in', async () => {
    const made = setup();
    const preview = await made.invoke(MOVE, NO_TOOL_CONTEXT);
    expect(preview.result.isError).toBe(true);
    expect(textOf(preview)).toContain('sign-in');
    expect(made.upstream.calls).toEqual([]);
  });
});

describe('me_reschedule_booking, second call: the move', () => {
  it('moves with exactly the new datetime and the user token, then returns the moved booking', async () => {
    const made = setupMoving();
    const { confirm: moved } = await previewThenConfirm(made);
    expect(moved.result.isError).not.toBe(true);
    const out = outOf(moved);
    expect(out.status).toBe('moved');
    expect(out.preview).toBeNull();
    expect(out.confirmation_token).toBeNull();
    expect(out.booking).toMatchObject({
      booking_id: 5,
      status: 'upcoming',
      datetime: '2099-01-13T11:00:00+0300',
    });
    expect(textOf(moved)).toContain('Moved: booking 5');

    expect(routesOf(made.upstream)).toEqual([
      'GET /user/records',
      `PUT /book_record/${LOCATION}/5`,
      'GET /user/records',
    ]);
    const put = made.upstream.calls[1];
    expect(JSON.parse(put?.body ?? 'null')).toEqual({ datetime: NEW_TIME });
    for (const call of made.upstream.calls) {
      expect(authorizationOf(call)).toBe(USER_AUTHORIZATION);
    }
    expectNoBait(moved);
  });

  it('sends the PUT to the location of the own record, never one from the input', async () => {
    const made = setup();
    const { confirm } = await previewThenConfirm(made);
    expect(confirm.result.isError).not.toBe(true);
    const put = made.upstream.calls.find((call) => call.method === 'PUT');
    expect(put?.url.pathname).toBe(`/api/v1/book_record/${LOCATION}/5`);
  });

  it('keeps the moved status with a null booking when the records cannot be re-read', async () => {
    let reads = 0;
    const made = setup({
      records: () => {
        reads += 1;
        return reads <= 2
          ? loadFixture('user_records', 'default')
          : { status: 500, body: { success: false, meta: {} } };
      },
    });
    const { confirm } = await previewThenConfirm(made);
    expect(confirm.result.isError).not.toBe(true);
    const out = outOf(confirm);
    expect(out.status).toBe('moved');
    expect(out.booking).toBeNull();
  });

  it('refuses a booking that was cancelled between the preview and the confirm, with no PUT', async () => {
    let reads = 0;
    const made = setup({
      records: () => {
        reads += 1;
        return reads === 1
          ? loadFixture('user_records', 'default')
          : records((body) => {
              recordFive(body).deleted = true;
            });
      },
    });
    const { confirm } = await previewThenConfirm(made);
    expect(confirm.result.isError).toBe(true);
    expect(textOf(confirm)).toContain('Nothing was moved');
    expect(textOf(confirm)).toContain('cancelled');
    expect(routesOf(made.upstream)).toEqual(['GET /user/records']);
  });
});

describe('me_reschedule_booking: the PUT fails', () => {
  it('says the time was taken meanwhile and names the slots, for 433', async () => {
    const made = setup({ move: loadFixture('book_record_move', 'taken_433') });
    const { confirm } = await previewThenConfirm(made);
    expect(confirm.result.isError).toBe(true);
    const text = textOf(confirm);
    expect(text).toContain('Nothing was moved: this time was taken meanwhile.');
    expect(text).toContain('business_list_time_slots');
    expectNoBait(confirm);
  });

  it('gives the sign-in text of the shared mapping for a 403', async () => {
    const made = setup({
      move: loadFixture('book_record_move', 'forbidden_403'),
    });
    const { confirm } = await previewThenConfirm(made);
    expect(confirm.result.isError).toBe(true);
    expect(textOf(confirm)).toContain("did not accept the client's sign-in");
    expectNoBait(confirm);
  });

  it('says it is not known whether the booking moved, and names me_list_bookings, for a 503', async () => {
    const made = setup({
      move: { status: 503, body: { success: false, meta: { message: 'x' } } },
    });
    const { confirm } = await previewThenConfirm(made);
    expect(confirm.result.isError).toBe(true);
    const text = textOf(confirm);
    expect(text).toContain('not known whether the booking was moved');
    expect(text).toContain('me_list_bookings');
  });

  it('keeps the token used after the failure, so the same confirmation cannot be repeated', async () => {
    const made = setup({
      move: { status: 503, body: { success: false, meta: { message: 'x' } } },
    });
    const preview = await made.invoke(MOVE);
    const args = {
      ...MOVE,
      confirmation_token: outOf(preview).confirmation_token,
    };
    await made.invoke(args);
    made.upstream.calls.length = 0;
    const again = await made.invoke(args);
    expect(again.result.isError).toBe(true);
    expect(textOf(again)).toContain('already used');
    expect(made.upstream.calls).toEqual([]);
  });
});

describe('me_reschedule_booking: tokens of another tool, time or booking', () => {
  async function expectRefused(
    made: Setup,
    args: Record<string, unknown>
  ): Promise<void> {
    made.upstream.calls.length = 0;
    const result = await made.invoke(args);
    expect(result.result.isError).toBe(true);
    const text = textOf(result);
    expect(text.startsWith('Nothing was moved')).toBe(true);
    expect(text).toContain('Next:');
    expect(made.upstream.calls).toEqual([]);
  }

  it('refuses a token issued by me_book, even for the same arguments', async () => {
    const made = setup();
    const issued = made.confirmations.issue('me_book', USER_TOKEN, MOVE);
    await expectRefused(made, { ...MOVE, confirmation_token: issued.token });
  });

  it('refuses a token for booking 5 with another datetime', async () => {
    const made = setup();
    const preview = await made.invoke(MOVE);
    await expectRefused(made, {
      ...MOVE,
      datetime: '2099-01-13T12:00:00+03:00',
      confirmation_token: outOf(preview).confirmation_token,
    });
  });

  it('refuses a token for another booking', async () => {
    const made = setup();
    const preview = await made.invoke(MOVE);
    await expectRefused(made, {
      ...MOVE,
      booking_id: 6,
      confirmation_token: outOf(preview).confirmation_token,
    });
  });

  it('refuses a token made for another sign-in', async () => {
    const made = setup();
    const preview = await made.invoke(MOVE);
    made.upstream.calls.length = 0;
    const result = await made.invoke(
      { ...MOVE, confirmation_token: outOf(preview).confirmation_token },
      { ...NO_TOOL_CONTEXT, userToken: 'client-user-token-0002-abcdef' }
    );
    expect(result.result.isError).toBe(true);
    expect(textOf(result).startsWith('Nothing was moved')).toBe(true);
    expect(made.upstream.calls).toEqual([]);
  });
});

// me_cancel_booking (ME-07, ADR 0006, D-02, D-03)

const CANCEL = { booking_id: 5 };

interface CancelOut {
  status: string;
  booking_id: number;
  booking: { booking_id: number; status: string; datetime: string } | null;
  cancellation_rule: string | null;
  confirmation_token: string | null;
  expires_at: string | null;
}

function cancelOutOf(invocation: ToolInvocation): CancelOut {
  return invocation.result.structuredContent as unknown as CancelOut;
}

async function cancelPreviewThenConfirm(
  made: Setup
): Promise<{ preview: ToolInvocation; confirm: ToolInvocation }> {
  const preview = await made.invokeCancel(CANCEL);
  expect(preview.result.isError).not.toBe(true);
  const token = cancelOutOf(preview).confirmation_token;
  made.upstream.calls.length = 0;
  const confirm = await made.invokeCancel({
    ...CANCEL,
    confirmation_token: token,
  });
  return { preview, confirm };
}

describe('me_cancel_booking: the tool', () => {
  it('is a write tool for the book tier, annotated destructive and open-world', () => {
    expect(meCancelBooking.name).toBe('me_cancel_booking');
    expect(meCancelBooking.spec.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    });
    expect(meCancelBooking.meta.scopes).toEqual(
      expect.arrayContaining([SCOPE_READ, SCOPE_BOOK])
    );
  });

  it('takes a booking id and a token, and no personal data', () => {
    const properties = Object.keys(
      (
        meCancelBooking.spec.inputSchema as {
          properties: Record<string, unknown>;
        }
      ).properties
    );
    expect(properties.sort()).toEqual(['booking_id', 'confirmation_token']);
  });

  it('is named by me_list_bookings as one of the tools that take its booking_id', () => {
    const description = String(meListBookings.spec.description);
    expect(description).toContain('booking_id');
    expect(description).toContain('me_reschedule_booking');
    expect(description).toContain('me_cancel_booking');
  });
});

describe('me_cancel_booking, first call: the preview', () => {
  it('shows the booking and the cancellation rule, and writes nothing', async () => {
    const made = setup();
    const preview = await made.invokeCancel(CANCEL);
    expect(preview.result.isError).not.toBe(true);
    const out = cancelOutOf(preview);
    expect(out.status).toBe('preview');
    expect(out.booking_id).toBe(5);
    expect(out.booking).toMatchObject({ booking_id: 5, status: 'upcoming' });
    expect(out.cancellation_rule).toBe(
      'Online cancellation is allowed until 2 hours before the start.'
    );
    expect(out.confirmation_token).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
    const text = textOf(preview);
    expect(text).toContain('Preview, nothing is cancelled yet');
    expect(text).toContain('Online cancellation is allowed until 2 hours');
    expect(text).toContain('only after the user agrees');
    expect(text).toContain(out.confirmation_token ?? 'missing');
    expectNoBait(preview);
    expect(routesOf(made.upstream)).toEqual([
      'GET /user/records',
      `GET /company/${LOCATION}`,
    ]);
    const [recordsCall, cardCall] = made.upstream.calls;
    expect(recordsCall ? authorizationOf(recordsCall) : null).toBe(
      USER_AUTHORIZATION
    );
    expect(cardCall ? authorizationOf(cardCall) : null).toBe(
      PARTNER_AUTHORIZATION
    );
  });

  it('gives a null rule when the card states none', async () => {
    const made = setup({
      company: card((data) => {
        delete data.allow_delete_record;
        delete data.allow_delete_record_delay_step;
      }),
    });
    const preview = await made.invokeCancel(CANCEL);
    expect(preview.result.isError).not.toBe(true);
    expect(cancelOutOf(preview).cancellation_rule).toBeNull();
  });
});

describe('me_cancel_booking: refusals before any write', () => {
  it('refuses a booking id that is not among the records, naming me_list_bookings, after the records call only', async () => {
    const made = setup();
    const preview = await made.invokeCancel({ booking_id: 777 });
    expect(preview.result.isError).toBe(true);
    const text = textOf(preview);
    expect(text.startsWith('Nothing was cancelled')).toBe(true);
    expect(text).toContain('me_list_bookings');
    expect(routesOf(made.upstream)).toEqual(['GET /user/records']);
  });

  it('refuses a cancelled booking and a past one, saying why, after the records call only', async () => {
    for (const [bookingId, reason] of [
      [4, 'already cancelled'],
      [1, 'in the past'],
    ] as const) {
      const made = setup();
      const preview = await made.invokeCancel({ booking_id: bookingId });
      expect(preview.result.isError).toBe(true);
      const text = textOf(preview);
      expect(text.startsWith('Nothing was cancelled')).toBe(true);
      expect(text).toContain(reason);
      expect(routesOf(made.upstream)).toEqual(['GET /user/records']);
    }
  });

  it('refuses a record whose flag forbids cancelling online, naming the business contacts', async () => {
    const made = setup({
      records: records((body) => {
        recordFive(body).allow_delete_record = false;
      }),
    });
    const preview = await made.invokeCancel(CANCEL);
    expect(preview.result.isError).toBe(true);
    const text = textOf(preview);
    expect(text).toContain(
      'Nothing was cancelled: the business does not allow cancelling this booking online.'
    );
    expect(text).toContain('business_get');
    expect(routesOf(made.upstream)).toEqual(['GET /user/records']);
  });

  it('refuses a business whose card forbids cancelling online', async () => {
    const made = setup({
      company: card((data) => {
        data.allow_delete_record = false;
      }),
    });
    const preview = await made.invokeCancel(CANCEL);
    expect(preview.result.isError).toBe(true);
    expect(textOf(preview)).toContain(
      'Nothing was cancelled: the business does not allow cancelling this booking online.'
    );
    expect(made.upstream.calls.some((call) => call.method === 'DELETE')).toBe(
      false
    );
  });

  it('refuses without any upstream call for a caller with no client sign-in', async () => {
    const made = setup();
    const preview = await made.invokeCancel(CANCEL, NO_TOOL_CONTEXT);
    expect(preview.result.isError).toBe(true);
    expect(textOf(preview)).toContain('sign-in');
    expect(made.upstream.calls).toEqual([]);
  });
});

describe('me_cancel_booking, second call: the cancellation', () => {
  it('re-reads the records, sends one DELETE with the user token and shows the booking as cancelled', async () => {
    const made = setup();
    const { confirm } = await cancelPreviewThenConfirm(made);
    expect(confirm.result.isError).not.toBe(true);
    const out = cancelOutOf(confirm);
    expect(out.status).toBe('cancelled');
    expect(out.booking_id).toBe(5);
    expect(out.booking).toMatchObject({ booking_id: 5, status: 'cancelled' });
    expect(out.confirmation_token).toBeNull();
    expect(textOf(confirm)).toContain('Cancelled: booking 5');
    expect(routesOf(made.upstream)).toEqual([
      'GET /user/records',
      'DELETE /user/records/5/0',
    ]);
    const [, del] = made.upstream.calls;
    expect(del?.body).toBeNull();
    for (const call of made.upstream.calls) {
      expect(authorizationOf(call)).toBe(USER_AUTHORIZATION);
    }
  });

  it('never puts the hash segment, a record token or the path into a response', async () => {
    const made = setup();
    const { preview, confirm } = await cancelPreviewThenConfirm(made);
    for (const invocation of [preview, confirm]) {
      expectNoBait(invocation);
      const everything = `${textOf(invocation)}${JSON.stringify(
        invocation.result.structuredContent ?? null
      )}`;
      expect(everything).not.toContain('/user/records');
    }
  });

  it('refuses a booking that was cancelled between the preview and the confirm, with no DELETE', async () => {
    let reads = 0;
    const made = setup({
      records: () => {
        reads += 1;
        return reads === 1
          ? loadFixture('user_records', 'default')
          : records((body) => {
              recordFive(body).deleted = true;
            });
      },
    });
    const { confirm } = await cancelPreviewThenConfirm(made);
    expect(confirm.result.isError).toBe(true);
    expect(textOf(confirm)).toContain('already cancelled');
    expect(routesOf(made.upstream)).toEqual(['GET /user/records']);
  });
});

describe('me_cancel_booking: the DELETE fails', () => {
  it('says the business did not accept the cancellation, naming its contacts, for a 403', async () => {
    const made = setup({
      cancel: loadFixture('user_record_cancel', 'forbidden_403'),
    });
    const { confirm } = await cancelPreviewThenConfirm(made);
    expect(confirm.result.isError).toBe(true);
    const text = textOf(confirm);
    expect(text).toContain(
      'Nothing was cancelled: the business did not accept the cancellation online, for example because it is too close to the start.'
    );
    expect(text).toContain('business_get');
    expect(text).not.toContain('sign-in');
    expectNoBait(confirm);
  });

  it('keeps the sign-in text for a 401', async () => {
    const made = setup({
      cancel: { status: 401, body: { success: false, meta: { message: 'x' } } },
    });
    const { confirm } = await cancelPreviewThenConfirm(made);
    expect(confirm.result.isError).toBe(true);
    expect(textOf(confirm)).toContain("did not accept the client's sign-in");
  });

  it('says the booking was not found and names me_list_bookings, for a 404', async () => {
    const made = setup({
      cancel: loadFixture('user_record_cancel', 'not_found_404'),
    });
    const { confirm } = await cancelPreviewThenConfirm(made);
    expect(confirm.result.isError).toBe(true);
    const text = textOf(confirm);
    expect(text).toContain('Nothing was cancelled: the booking was not found.');
    expect(text).toContain('me_list_bookings');
  });

  it('says it is not known whether the booking was cancelled, for a 503, and the token stays used', async () => {
    const made = setup({
      cancel: { status: 503, body: { success: false, meta: { message: 'x' } } },
    });
    const preview = await made.invokeCancel(CANCEL);
    const args = {
      ...CANCEL,
      confirmation_token: cancelOutOf(preview).confirmation_token,
    };
    const first = await made.invokeCancel(args);
    expect(first.result.isError).toBe(true);
    expect(textOf(first)).toContain(
      'not known whether the booking was cancelled'
    );
    expect(textOf(first)).toContain('me_list_bookings');
    made.upstream.calls.length = 0;
    const again = await made.invokeCancel(args);
    expect(textOf(again)).toContain('already used');
    expect(made.upstream.calls).toEqual([]);
  });
});

describe('me_cancel_booking: tokens of another tool or booking', () => {
  async function expectRefused(
    made: Setup,
    args: Record<string, unknown>
  ): Promise<void> {
    made.upstream.calls.length = 0;
    const result = await made.invokeCancel(args);
    expect(result.result.isError).toBe(true);
    const text = textOf(result);
    expect(text.startsWith('Nothing was cancelled')).toBe(true);
    expect(text).toContain('Next:');
    expect(made.upstream.calls).toEqual([]);
  }

  it('refuses the token of the reschedule preview for the same booking', async () => {
    const made = setup();
    const preview = await made.invoke(MOVE);
    await expectRefused(made, {
      ...CANCEL,
      confirmation_token: outOf(preview).confirmation_token,
    });
  });

  it('refuses a token issued by me_book', async () => {
    const made = setup();
    const issued = made.confirmations.issue('me_book', USER_TOKEN, CANCEL);
    await expectRefused(made, { ...CANCEL, confirmation_token: issued.token });
  });

  it('refuses a token for another booking', async () => {
    const made = setup();
    const preview = await made.invokeCancel(CANCEL);
    await expectRefused(made, {
      booking_id: 6,
      confirmation_token: cancelOutOf(preview).confirmation_token,
    });
  });

  it('refuses a cancel token for the reschedule tool', async () => {
    const made = setup();
    const preview = await made.invokeCancel(CANCEL);
    made.upstream.calls.length = 0;
    const result = await made.invoke({
      ...MOVE,
      confirmation_token: cancelOutOf(preview).confirmation_token,
    });
    expect(result.result.isError).toBe(true);
    expect(textOf(result).startsWith('Nothing was moved')).toBe(true);
    expect(made.upstream.calls).toEqual([]);
  });
});
