import { z } from 'zod';
import {
  BOOKING_ROUTES,
  CLIENT_WRITE_ROUTES,
  USER_ROUTES,
  type BusinessRules,
} from '../booking/client.js';
import { UpstreamError } from '../booking/errors.js';
import {
  BOOK_CHECK_STEP_MS,
  CHECK_ERRORS,
  SERVICE_NOT_AVAILABLE,
  requireBookingWidget,
  selectedServices,
  selectedTeamMember,
  slotDatetimeInput,
  slotFields,
} from './book.js';
import {
  LABEL_MAX_CHARS,
  NAME_MAX_CHARS,
  locationIdInput,
  priceText,
  teamMemberOrAnyInput,
  teamMemberText,
  uniqueServiceIds,
  untrustedText,
} from './business.js';
import {
  CONFIRMATION_TOKEN_ARG,
  DEFAULT_CONFIRMATIONS,
  confirmationTokenInput,
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
import type { ToolDeps } from './registry.js';
import { SCOPE_BOOK, SCOPE_READ } from './scopes.js';
import { toToolError } from './upstream-errors.js';
import { sanitizeUntrusted, withUntrustedBlock } from './untrusted.js';

// me_book (ME-06, ADR 0006, D-02, D-03): a signed-in client books at one of
// their own places in two calls. The first checks the slot and returns a
// preview with a confirmation_token; the second, with the identical arguments
// and that token, reads the client's profile, creates the booking with the
// user token and returns it as me_list_bookings shows it. The name and phone
// come from the client's Altegio profile and never from a tool input, and
// never back out of the server.

const TOOL_NAME = 'me_book';

const bookInput = z.strictObject({
  location_id: locationIdInput,
  service_ids: uniqueServiceIds(
    1,
    'Services to book, 1 to 10 unique service ids, in the order the client chose them.'
  ),
  team_member_id: teamMemberOrAnyInput,
  datetime: slotDatetimeInput,
  [CONFIRMATION_TOKEN_ARG]: confirmationTokenInput,
});

type BookInput = z.infer<typeof bookInput>;

const previewServiceSchema = z.strictObject({
  id: z.number().int().describe('Service id.'),
  title: untrustedText('Service title.'),
  price: z
    .strictObject({
      min: z.number().describe('Lowest price.'),
      max: z.number().describe('Highest price; equal to min for one price.'),
      currency: untrustedText('Currency of the business.'),
    })
    .nullable()
    .describe('Price range as the business set it, or null for no set price.'),
});

const previewSchema = z.strictObject({
  business: untrustedText('Business name.'),
  services: z
    .array(previewServiceSchema)
    .describe('The chosen services, in the order the client gave them.'),
  team_member: z
    .strictObject({
      id: z.number().int().describe('Team member id.'),
      name: untrustedText('Team member name, or null when not loaded.'),
    })
    .nullable()
    .describe('The chosen team member, or null for any team member.'),
  date: z
    .string()
    .describe("Date of the slot, YYYY-MM-DD, in the business's local time."),
  time: z.string().describe("Start time, HH:MM, in the business's local time."),
  utc_offset: z
    .string()
    .describe('UTC offset of the slot, for example +03:00.'),
  time_zone: untrustedText('Time zone name of the business.'),
  cancellation: z
    .string()
    .nullable()
    .describe(
      "The business's online cancellation rule, or null when the business states none."
    ),
});

const bookOutput = z.strictObject({
  status: z
    .enum(['preview', 'booked'])
    .describe(
      'preview: the slot was checked and nothing is booked. booked: the booking was created.'
    ),
  location_id: z.number().int().describe('Location id of the business.'),
  preview: previewSchema
    .nullable()
    .describe(
      'What would be booked, for the client to confirm; null once booked.'
    ),
  confirmation_token: z
    .string()
    .nullable()
    .describe(
      'Token for the second call, valid for 10 minutes, bound to this selection and sign-in; null once booked.'
    ),
  expires_at: z
    .string()
    .nullable()
    .describe(
      'When the confirmation_token expires, ISO 8601 UTC; null once booked.'
    ),
  booking_id: z
    .number()
    .int()
    .nullable()
    .describe(
      'Id of the new booking, as the booking tools take it; null for a preview.'
    ),
  booking: bookingItemSchema
    .nullable()
    .describe(
      'The new booking as me_list_bookings shows it; null for a preview, or when the bookings could not be read back just now.'
    ),
});

type BookOutput = z.infer<typeof bookOutput>;

/** The arguments a confirmation token is bound to: the selection, never the token. */
function boundArguments(input: BookInput): Record<string, unknown> {
  return {
    location_id: input.location_id,
    service_ids: input.service_ids,
    team_member_id: input.team_member_id,
    datetime: input.datetime,
  };
}

function durationText(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/** The business's online cancellation rule from its card, or null when the card states none. */
function cancellationText(rules: BusinessRules): string | null {
  if (rules.cancelAllowed === null) return null;
  if (!rules.cancelAllowed) {
    return 'This business does not allow online cancellation.';
  }
  return rules.cancelBeforeSeconds !== null && rules.cancelBeforeSeconds > 0
    ? `Online cancellation is allowed until ${durationText(rules.cancelBeforeSeconds)} before the start.`
    : 'Online cancellation is allowed.';
}

const NOT_AN_OWN_PLACE_NEXT =
  "call book_check with the same selection for the business's pre-filled booking link.";

/** Preview: validates the slot and issues the confirmation token. Nothing is written upstream. */
async function preview(
  input: BookInput,
  deps: ToolDeps,
  ctx: ToolContext
): Promise<BookOutput> {
  const userSide = userCall(ctx);
  const records = await deps.booking.myRecords(userSide).catch((error) => {
    throw toToolError(error);
  });
  if (!records.some((record) => record.locationId === input.location_id)) {
    throw new ToolError(
      `Nothing was booked: location ${input.location_id} is not among the places this client has booked before.`,
      NOT_AN_OWN_PLACE_NEXT
    );
  }

  const call = upstreamCall(ctx);
  const [cardResult, catalogResult, membersResult] = await Promise.allSettled([
    deps.booking.company(input.location_id, call),
    deps.booking.services(input.location_id, {}, call),
    input.team_member_id > 0
      ? deps.booking.teamMembers(input.location_id, {}, call)
      : Promise.resolve(null),
  ]);
  if (cardResult.status === 'rejected') throw toToolError(cardResult.reason);
  if (catalogResult.status === 'rejected') {
    throw toToolError(catalogResult.reason);
  }
  const card = cardResult.value;
  requireBookingWidget(card);

  const currency = sanitizeUntrusted(card.currency, {
    maxChars: LABEL_MAX_CHARS,
  });
  const chosen = selectedServices(
    input.service_ids,
    catalogResult.value,
    currency
  );
  if (!chosen.complete) {
    throw new ToolError(
      `Nothing was booked: ${SERVICE_NOT_AVAILABLE.message}`,
      SERVICE_NOT_AVAILABLE.nextAction
    );
  }
  const member = selectedTeamMember(
    input.team_member_id,
    membersResult.status === 'fulfilled' ? membersResult.value : null
  );

  try {
    await deps.booking.check(
      input.location_id,
      {
        serviceIds: input.service_ids,
        teamMemberId: input.team_member_id,
        datetime: input.datetime,
      },
      {
        ...call,
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
        'Nothing was booked: the time could not be checked just now.',
        'call me_book again in a few seconds without confirmation_token.'
      );
    }
    throw toToolError(error, CHECK_ERRORS);
  }

  const confirmations = deps.confirmations ?? DEFAULT_CONFIRMATIONS;
  const issued = confirmations.issue(
    TOOL_NAME,
    userSide.userToken,
    boundArguments(input)
  );
  const slot = slotFields(input.datetime);
  return {
    status: 'preview',
    location_id: input.location_id,
    preview: {
      business: sanitizeUntrusted(card.name, { maxChars: NAME_MAX_CHARS }),
      services: chosen.services.map((service) => ({
        id: service.id,
        title: service.title,
        price: service.price,
      })),
      team_member: member.teamMember,
      ...slot,
      time_zone: sanitizeUntrusted(card.timeZoneName, {
        maxChars: LABEL_MAX_CHARS,
      }),
      cancellation: cancellationText(card.rules),
    },
    confirmation_token: issued.token,
    expires_at: new Date(issued.expiresAt).toISOString(),
    booking_id: null,
    booking: null,
  };
}

const NEW_PREVIEW_NEXT =
  'call me_book again without confirmation_token for a new preview, and confirm it with the client.';

/** Confirm: redeems the token, reads the profile, creates the booking and reads it back. */
async function confirm(
  input: BookInput,
  token: string,
  deps: ToolDeps,
  ctx: ToolContext
): Promise<BookOutput> {
  const userSide = userCall(ctx);
  const confirmations = deps.confirmations ?? DEFAULT_CONFIRMATIONS;
  const verdict = confirmations.redeem(
    token,
    TOOL_NAME,
    userSide.userToken,
    boundArguments(input)
  );
  if (verdict !== 'ok') {
    throw new ToolError(
      verdict === 'expired'
        ? 'Nothing was booked: this confirmation_token has expired.'
        : 'Nothing was booked: this confirmation_token is not valid for this selection and sign-in.',
      NEW_PREVIEW_NEXT
    );
  }

  const profile = await deps.booking.myProfile(userSide).catch((error) => {
    throw toToolError(error);
  });
  if (profile === null) {
    throw new ToolError(
      "Nothing was booked: the client's Altegio profile has no name or phone, which the business needs for a booking.",
      "tell the user to complete their profile in Altegio.me, or call book_check for the business's pre-filled booking link."
    );
  }

  const created = await deps.booking
    .createBooking(
      input.location_id,
      {
        serviceIds: input.service_ids,
        teamMemberId: input.team_member_id,
        datetime: input.datetime,
      },
      profile,
      userSide
    )
    .catch((error) => {
      throw toToolError(error);
    });

  // Read the new booking back as me_list_bookings shows it; a failed or empty
  // re-read keeps the booking, which exists upstream either way.
  let booking: BookingItem | null = null;
  try {
    const records = await deps.booking.myRecords(userSide);
    const record = records.find((entry) => entry.id === created.bookingId);
    if (record !== undefined) booking = toBookingItem(record, Date.now());
  } catch {
    booking = null;
  }
  return {
    status: 'booked',
    location_id: input.location_id,
    preview: null,
    confirmation_token: null,
    expires_at: null,
    booking_id: created.bookingId,
    booking,
  };
}

function renderPreview(out: BookOutput): string {
  const shown = out.preview;
  if (shown === null) return 'No preview was produced.';
  const who = shown.team_member;
  const lines = [
    'Preview, nothing is booked yet:',
    `Location ${out.location_id}, ${shown.date} at ${shown.time} (UTC${shown.utc_offset}, the business's local time).`,
    'Services, in the order chosen:',
    ...shown.services.map(
      (service) => `- service ${service.id}: ${priceText(service.price)}.`
    ),
    `Team member: ${who === null ? teamMemberText(0) : teamMemberText(who.id)}.`,
    'Prices are in the currency of the business.',
  ];
  if (shown.cancellation !== null) lines.push(shown.cancellation);
  lines.push(
    `Next: show this to the user; only after the user agrees, call me_book again with the same location_id, service_ids, team_member_id and datetime and confirmation_token ${out.confirmation_token ?? ''} (valid until ${out.expires_at ?? ''} UTC).`
  );

  const fields: Record<string, unknown> = {
    Business: shown.business,
    'Time zone': shown.time_zone,
  };
  const currency = shown.services.find((service) => service.price !== null)
    ?.price?.currency;
  if (currency !== undefined) fields.Currency = currency;
  for (const service of shown.services) {
    fields[`service ${service.id}`] = service.title;
  }
  if (who !== null) fields[`team member ${who.id}`] = who.name;
  return withUntrustedBlock(lines.join('\n'), fields);
}

function renderBooked(out: BookOutput): string {
  const { booking } = out;
  const lines = [
    `Booked: booking ${out.booking_id ?? ''} at location ${out.location_id}${
      booking === null ? '' : `, ${booking.datetime}`
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

export const meBook = defineTool<typeof bookInput, typeof bookOutput, ToolDeps>(
  {
    name: TOOL_NAME,
    title: 'Book at one of my places',
    description:
      "Books for the signed-in client at one of their own places, in two calls. The first call checks the time with the business and returns a preview and a confirmation_token valid for 10 minutes; nothing is booked. After the client agrees, the second call with the same selection and that token creates the booking and returns it. The client's name and phone come from their Altegio profile. Needs the client's sign-in.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
      idempotentHint: false,
    },
    scopes: [SCOPE_READ, SCOPE_BOOK],
    upstream: [
      USER_ROUTES.records,
      BOOKING_ROUTES.company,
      BOOKING_ROUTES.services,
      BOOKING_ROUTES.teamMembers,
      BOOKING_ROUTES.check,
      USER_ROUTES.profile,
      CLIENT_WRITE_ROUTES.create,
    ],
    input: bookInput,
    output: bookOutput,
    render: (out) =>
      out.status === 'preview' ? renderPreview(out) : renderBooked(out),
    handler: async ({ input, deps, ctx }) => {
      const token = input[CONFIRMATION_TOKEN_ARG];
      return token === undefined
        ? preview(input, deps, ctx)
        : confirm(input, token, deps, ctx);
    },
  }
);
