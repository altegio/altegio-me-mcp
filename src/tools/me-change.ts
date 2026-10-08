import { z } from 'zod';
import {
  BOOKING_ROUTES,
  CLIENT_WRITE_ROUTES,
  USER_ROUTES,
  type BusinessRules,
  type OwnRecord,
} from '../booking/client.js';
import { UpstreamError } from '../booking/errors.js';
import {
  BOOK_CHECK_STEP_MS,
  CHECK_ERRORS,
  slotDatetimeInput,
  slotFields,
} from './book.js';
import { untrustedText } from './business.js';
import {
  CONFIRMATION_TOKEN_ARG,
  DEFAULT_CONFIRMATIONS,
  confirmationTokenInput,
  type ConfirmationVerdict,
} from './confirmation.js';
import { upstreamCall, userCall, type ToolContext } from './context.js';
import { ToolError } from './errors.js';
import { defineTool } from './factory.js';
import {
  bookingBlockValue,
  bookingItemSchema,
  toBookingItem,
  type BookingItem,
} from './me.js';
import { durationText } from './me-book.js';
import type { ToolDeps } from './registry.js';
import { SCOPE_BOOK, SCOPE_READ } from './scopes.js';
import {
  toToolError,
  waitSeconds,
  type UpstreamErrorOverrides,
  type UpstreamErrorText,
} from './upstream-errors.js';
import { withUntrustedBlock } from './untrusted.js';
import { bookingStatus } from './usual.js';

// me_reschedule_booking (ME-07, ADR 0006, D-02, D-03): a signed-in client moves
// one of their own upcoming bookings in two calls. The first checks the new
// time and returns a preview with a confirmation_token; the second, with the
// identical arguments and that token, sends the move with the user token. Only
// a booking among the client's own records is ever changed, and the write goes
// to the location of that record, never to one a caller names. Nothing about
// the client, and no comment, is sent with a move.

type Change = 'move';

const NOTHING_DONE: Record<Change, string> = {
  move: 'Nothing was moved',
};

const MOVE_TOOL = 'me_reschedule_booking';

const LIST_BOOKINGS_NEXT =
  "call me_list_bookings for the booking_id of one of the client's upcoming bookings.";
const CONTACT_ACTION =
  'tell the user to contact the business directly, using the contact details from business_get';

function refusal(
  change: Change,
  reason: string,
  nextAction: string
): ToolError {
  return new ToolError(`${NOTHING_DONE[change]}: ${reason}`, nextAction);
}

function notAllowedOnline(change: Change): ToolError {
  return refusal(
    change,
    'the business does not allow moving this booking online.',
    `${CONTACT_ACTION}.`
  );
}

/**
 * The client's own booking `bookingId`, or the refusal that says why it cannot
 * be changed: not among the records, cancelled, past, or locked by the
 * record's own flag. The records are the only source of the booking and of its
 * location, so a booking of someone else is never reached (T-04.1-09).
 */
function changeableRecord(
  records: readonly OwnRecord[],
  bookingId: number,
  change: Change,
  nowMs: number
): OwnRecord {
  const record = records.find((entry) => entry.id === bookingId);
  if (record === undefined) {
    throw refusal(
      change,
      `booking ${bookingId} is not among this client's bookings.`,
      LIST_BOOKINGS_NEXT
    );
  }
  const status = bookingStatus(record, nowMs);
  if (status === 'cancelled') {
    throw refusal(
      change,
      'this booking was already cancelled.',
      LIST_BOOKINGS_NEXT
    );
  }
  if (status !== 'upcoming') {
    throw refusal(change, 'this booking is in the past.', LIST_BOOKINGS_NEXT);
  }
  if (record.moveAllowed === false) throw notAllowedOnline(change);
  return record;
}

function verdictRefusal(
  change: Change,
  verdict: Exclude<ConfirmationVerdict, 'ok'>,
  newPreviewNext: string
): ToolError {
  return refusal(
    change,
    verdict === 'expired'
      ? 'this confirmation_token has expired.'
      : verdict === 'used'
        ? 'this confirmation_token was already used.'
        : 'this confirmation_token is not valid for this booking and sign-in.',
    newPreviewNext
  );
}

const RECORD_DATETIME =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):\d{2}(?:\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)$/;

interface RecordSlot {
  date: string;
  time: string;
  utc_offset: string;
}

/** Date, time and offset from the digits of a record datetime, which writes the offset without a colon. */
function recordSlot(datetime: string): RecordSlot {
  const match = RECORD_DATETIME.exec(datetime);
  const [, date, hour, minute, offset] = match ?? [];
  if (
    date === undefined ||
    hour === undefined ||
    minute === undefined ||
    offset === undefined
  ) {
    // An upcoming record always has a readable datetime (bookingStatus).
    throw new TypeError('record datetime is not readable');
  }
  const digits = offset === 'Z' ? '0000' : offset.slice(1).replace(':', '');
  const sign = offset.startsWith('-') ? '-' : '+';
  const hours = digits.slice(0, 2);
  const minutes = digits.length > 2 ? digits.slice(2) : '00';
  return {
    date,
    time: `${hour}:${minute}`,
    utc_offset: `${sign}${hours}:${minutes}`,
  };
}

const slotSchema = z.strictObject({
  date: z.string().describe("Date, YYYY-MM-DD, in the business's local time."),
  time: z.string().describe("Start time, HH:MM, in the business's local time."),
  utc_offset: z.string().describe('UTC offset, for example +03:00.'),
});

// me_reschedule_booking

const rescheduleInput = z.strictObject({
  booking_id: z
    .number()
    .int()
    .positive()
    .describe('The booking_id of an upcoming booking from me_list_bookings.'),
  datetime: slotDatetimeInput,
  [CONFIRMATION_TOKEN_ARG]: confirmationTokenInput,
});

type RescheduleInput = z.infer<typeof rescheduleInput>;

const rescheduleOutput = z.strictObject({
  status: z
    .enum(['preview', 'moved'])
    .describe(
      'preview: the new time was checked and nothing is moved. moved: the booking was moved.'
    ),
  booking_id: z
    .number()
    .int()
    .describe('Id of the booking, as the booking tools take it.'),
  booking: bookingItemSchema
    .nullable()
    .describe(
      'The booking as it is now for a preview, or as me_list_bookings shows it after the move; null when it could not be read back just now.'
    ),
  preview: z
    .strictObject({
      business: untrustedText('Business name.'),
      from: slotSchema.describe('The current time of the booking.'),
      to: slotSchema.describe('The new time.'),
      move_rule: z
        .string()
        .nullable()
        .describe(
          "The business's online move rule, or null when the business states none."
        ),
    })
    .nullable()
    .describe('What would change, for the client to confirm; null once moved.'),
  confirmation_token: z
    .string()
    .nullable()
    .describe(
      'Token for the second call, valid for 10 minutes, bound to this booking, time and sign-in; null once moved.'
    ),
  expires_at: z
    .string()
    .nullable()
    .describe(
      'When the confirmation_token expires, ISO 8601 UTC; null once moved.'
    ),
});

type RescheduleOutput = z.infer<typeof rescheduleOutput>;

/** The arguments a move token is bound to: the booking and the new time, never the token. */
function moveBoundArguments(input: RescheduleInput): Record<string, unknown> {
  return { booking_id: input.booking_id, datetime: input.datetime };
}

/** The business's online move rule from its card, or null when the card states none. */
function moveRuleText(rules: BusinessRules): string | null {
  if (rules.moveAllowed === null) return null;
  if (!rules.moveAllowed) {
    return 'This business does not allow moving a booking online.';
  }
  return rules.moveBeforeSeconds !== null && rules.moveBeforeSeconds > 0
    ? `Online moving is allowed until ${durationText(rules.moveBeforeSeconds)} before the start.`
    : 'Online moving is allowed.';
}

const NEW_MOVE_PREVIEW_NEXT = `call ${MOVE_TOOL} again without confirmation_token for a new preview, and confirm it with the client.`;
const ANOTHER_TIME_NEXT = `choose another time with business_list_time_slots, then call ${MOVE_TOOL} without confirmation_token for a new preview.`;

const MOVE_UNKNOWN_OUTCOME: UpstreamErrorText = {
  message:
    'The booking service did not answer, so it is not known whether the booking was moved.',
  nextAction:
    "call me_list_bookings to check the booking's time before moving it again; do not repeat this confirmation.",
};

function moveRejectedText(error: UpstreamError): UpstreamErrorText {
  const has = (code: number): boolean => error.codes.includes(code);
  if (has(433)) {
    return {
      message: 'Nothing was moved: this time was taken meanwhile.',
      nextAction: ANOTHER_TIME_NEXT,
    };
  }
  if (has(436) || has(437)) {
    return {
      message:
        'Nothing was moved: the business cannot take this booking at this time.',
      nextAction: ANOTHER_TIME_NEXT,
    };
  }
  return {
    message: 'Nothing was moved: the business did not accept the move.',
    nextAction: `call ${MOVE_TOOL} without confirmation_token for a new preview, or ${CONTACT_ACTION}.`,
  };
}

const MOVE_ERRORS: UpstreamErrorOverrides = {
  rejected: moveRejectedText,
  bad_request: moveRejectedText,
  not_found: {
    message: 'Nothing was moved: the booking was not found.',
    nextAction: LIST_BOOKINGS_NEXT,
  },
  anti_fraud: {
    message:
      "Nothing was moved: the business's booking service could not confirm the move from here.",
    nextAction: `${CONTACT_ACTION}.`,
  },
  unavailable: MOVE_UNKNOWN_OUTCOME,
  contract_drift: MOVE_UNKNOWN_OUTCOME,
  rate_limited: (error) => ({
    message: 'Nothing was moved: the booking service is busy right now.',
    nextAction: `wait ${waitSeconds(error)} seconds, then call ${MOVE_TOOL} without confirmation_token for a new preview.`,
  }),
};

/** Reading the records comes before the move: a failure there means nothing was moved, and the token is spent. */
const MOVE_READ_ERRORS: UpstreamErrorOverrides = {
  unavailable: {
    message:
      'Nothing was moved: the booking service did not answer when the booking was read.',
    nextAction: NEW_MOVE_PREVIEW_NEXT,
  },
  contract_drift: {
    message:
      'Nothing was moved: the booking service did not answer when the booking was read.',
    nextAction: NEW_MOVE_PREVIEW_NEXT,
  },
  rate_limited: MOVE_ERRORS.rate_limited,
};

/** Checks the new time for the booking's own services and team member; nothing is written. */
async function checkNewTime(
  record: OwnRecord,
  datetime: string,
  deps: ToolDeps,
  ctx: ToolContext
): Promise<void> {
  try {
    await deps.booking.check(
      record.locationId,
      {
        serviceIds: record.services.map((service) => service.id),
        teamMemberId: record.teamMember?.id ?? 0,
        datetime,
      },
      {
        ...upstreamCall(ctx),
        // The check has its own budget inside the call deadline.
        signal: AbortSignal.any([ctx.signal, ctx.timeout(BOOK_CHECK_STEP_MS)]),
      }
    );
  } catch (error) {
    if (
      error instanceof UpstreamError &&
      (error.kind === 'unavailable' || error.kind === 'contract_drift') &&
      !ctx.signal.aborted
    ) {
      throw new ToolError(
        'Nothing was moved: the time could not be checked just now.',
        `call ${MOVE_TOOL} again in a few seconds without confirmation_token.`
      );
    }
    throw toToolError(error, CHECK_ERRORS);
  }
}

/** Preview: finds the booking among the client's own, checks the new time and issues the token. Nothing is written. */
async function previewMove(
  input: RescheduleInput,
  deps: ToolDeps,
  ctx: ToolContext
): Promise<RescheduleOutput> {
  const userSide = userCall(ctx);
  const records = await deps.booking.myRecords(userSide).catch((error) => {
    throw toToolError(error);
  });
  const nowMs = Date.now();
  const record = changeableRecord(records, input.booking_id, 'move', nowMs);

  const card = await deps.booking
    .company(record.locationId, upstreamCall(ctx))
    .catch((error) => {
      throw toToolError(error);
    });
  if (card.rules.moveAllowed === false) throw notAllowedOnline('move');
  if (record.services.length === 0) {
    throw refusal(
      'move',
      'this booking lists no service, so its new time cannot be checked here.',
      `${CONTACT_ACTION}.`
    );
  }
  await checkNewTime(record, input.datetime, deps, ctx);

  const confirmations = deps.confirmations ?? DEFAULT_CONFIRMATIONS;
  const issued = confirmations.issue(
    MOVE_TOOL,
    userSide.userToken,
    moveBoundArguments(input)
  );
  const booking = toBookingItem(record, nowMs);
  return {
    status: 'preview',
    booking_id: record.id,
    booking,
    preview: {
      business: booking.business,
      from: recordSlot(record.datetime),
      to: slotFields(input.datetime),
      move_rule: moveRuleText(card.rules),
    },
    confirmation_token: issued.token,
    expires_at: new Date(issued.expiresAt).toISOString(),
  };
}

/** Confirm: redeems the token, re-reads the records, moves with the user token and reads the booking back. */
async function confirmMove(
  input: RescheduleInput,
  token: string,
  deps: ToolDeps,
  ctx: ToolContext
): Promise<RescheduleOutput> {
  const userSide = userCall(ctx);
  const confirmations = deps.confirmations ?? DEFAULT_CONFIRMATIONS;
  const verdict = confirmations.redeem(
    token,
    MOVE_TOOL,
    userSide.userToken,
    moveBoundArguments(input)
  );
  if (verdict !== 'ok') {
    throw verdictRefusal('move', verdict, NEW_MOVE_PREVIEW_NEXT);
  }

  // The booking is read again: one cancelled or moved since the preview is
  // caught here, and the write goes to the location of this own record.
  const records = await deps.booking.myRecords(userSide).catch((error) => {
    throw toToolError(error, MOVE_READ_ERRORS, { quoteUpstream: false });
  });
  const record = changeableRecord(
    records,
    input.booking_id,
    'move',
    Date.now()
  );
  try {
    await deps.booking.moveBooking(
      record.locationId,
      record.id,
      input.datetime,
      userSide
    );
  } catch (error) {
    throw toToolError(error, MOVE_ERRORS, { quoteUpstream: false });
  }

  // A failed or empty re-read keeps the move, which happened upstream either way.
  let booking: BookingItem | null = null;
  try {
    const fresh = await deps.booking.myRecords(userSide);
    const moved = fresh.find((entry) => entry.id === record.id);
    if (moved !== undefined) booking = toBookingItem(moved, Date.now());
  } catch {
    booking = null;
  }
  return {
    status: 'moved',
    booking_id: record.id,
    booking,
    preview: null,
    confirmation_token: null,
    expires_at: null,
  };
}

function renderMovePreview(out: RescheduleOutput): string {
  const { booking, preview: shown } = out;
  if (booking === null || shown === null) return 'No preview was produced.';
  const lines = [
    'Preview, nothing is moved yet:',
    `Booking ${booking.booking_id} at location ${booking.location_id} moves from ${shown.from.date} at ${shown.from.time} to ${shown.to.date} at ${shown.to.time} (UTC${shown.to.utc_offset}, the business's local time).`,
  ];
  if (shown.move_rule !== null) lines.push(shown.move_rule);
  lines.push(
    `Next: show this to the user; only after the user agrees, call ${MOVE_TOOL} again with the same booking_id and datetime and confirmation_token ${out.confirmation_token ?? ''} (valid until ${out.expires_at ?? ''} UTC).`
  );
  return withUntrustedBlock(lines.join('\n'), {
    Business: shown.business,
    Booking: bookingBlockValue(booking),
  });
}

function renderMoved(out: RescheduleOutput): string {
  const { booking } = out;
  const lines = [
    `Moved: booking ${out.booking_id}${
      booking === null
        ? ''
        : ` at location ${booking.location_id}, now ${booking.datetime}`
    }.`,
  ];
  if (booking === null) {
    lines.push(
      'The booking could not be read back just now; me_list_bookings shows it.'
    );
  }
  lines.push('Next: me_list_bookings lists it.');
  return withUntrustedBlock(
    lines.join('\n'),
    booking === null ? {} : { Booking: bookingBlockValue(booking) }
  );
}

export const meRescheduleBooking = defineTool<
  typeof rescheduleInput,
  typeof rescheduleOutput,
  ToolDeps
>({
  name: MOVE_TOOL,
  title: 'Move one of my bookings',
  description:
    "Moves one of the signed-in client's upcoming bookings to another free time, in two calls. The first call checks the new time with the business and returns a preview and a confirmation_token valid for 10 minutes; nothing is moved. After the client agrees, the second call with the same booking_id and datetime and that token moves the booking and returns it. The booking_id comes from me_list_bookings. Needs the client's sign-in.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
    idempotentHint: false,
  },
  scopes: [SCOPE_READ, SCOPE_BOOK],
  upstream: [
    USER_ROUTES.records,
    BOOKING_ROUTES.company,
    BOOKING_ROUTES.check,
    CLIENT_WRITE_ROUTES.move,
  ],
  input: rescheduleInput,
  output: rescheduleOutput,
  render: (out) =>
    out.status === 'preview' ? renderMovePreview(out) : renderMoved(out),
  handler: async ({ input, deps, ctx }) => {
    const token = input[CONFIRMATION_TOKEN_ARG];
    return token === undefined
      ? previewMove(input, deps, ctx)
      : confirmMove(input, token, deps, ctx);
  },
});
