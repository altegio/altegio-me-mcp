import { z } from 'zod';
import {
  BOOKING_ROUTES,
  CLIENT_WRITE_ROUTES,
  USER_ROUTES,
  type BusinessCard,
  type BusinessRules,
  type CheckSelection,
} from '../booking/client.js';
import {
  bookableFormUrl,
  buildBookingLink,
  canTakeOnlineBookings,
  plainBookingLink,
} from '../booking/deep-link.js';
import { UpstreamError } from '../booking/errors.js';
import {
  BOOK_CHECK_STEP_MS,
  CHECK_ERRORS,
  CONFIRMATION_STATEMENT,
  SERVICE_NOT_AVAILABLE,
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
import {
  defaultText,
  toToolError,
  waitSeconds,
  type UpstreamErrorOverrides,
  type UpstreamErrorText,
} from './upstream-errors.js';
import { sanitizeUntrusted, withUntrustedBlock } from './untrusted.js';

// me_book (ME-06, ADR 0006, D-02, D-03): a signed-in client books at one of
// their own places in two calls. The first checks the slot and returns a
// preview with a confirmation_token; the second, with the identical arguments
// and that token, reads the client's profile, creates the booking with the
// user token and returns it as me_list_bookings shows it. The name and phone
// come from the client's Altegio profile and never from a tool input, and
// never back out of the server.
//
// Two people side by side (CASE-02, D-01): an optional second_appointment, with
// its own services and a different, named team member, books two appointments
// at the same start in one preview, one confirmation and one create. Both
// bookings are under the client's name; nothing about the second person is
// taken or sent. The same token rules apply: it is bound to the whole selection,
// the second appointment included.
//
// What the chat cannot do ends at the business's own booking widget (ME-08,
// D-04): a place the client has no record at, a service that needs online
// prepayment (or whose prepayment is not known), a membership-only service and
// an inactive widget each return status "fallback" with the reason and the
// pre-filled link, in band and with no token.

const TOOL_NAME = 'me_book';

const secondAppointmentInput = z
  .strictObject({
    service_ids: uniqueServiceIds(
      1,
      'Services of the second appointment, 1 to 10 unique service ids.'
    ),
    team_member_id: z
      .number()
      .int()
      .min(0)
      .describe(
        'Team member of the second appointment: an id above 0, other than the first appointment team member.'
      ),
  })
  .describe(
    'A second appointment at the same datetime, with its own services and a different, named team member, booked for the same client; both appointments are previewed and confirmed together.'
  );

const bookInput = z.strictObject({
  location_id: locationIdInput,
  service_ids: uniqueServiceIds(
    1,
    'Services to book, 1 to 10 unique service ids, in the order the client chose them.'
  ),
  team_member_id: teamMemberOrAnyInput,
  datetime: slotDatetimeInput,
  second_appointment: secondAppointmentInput.optional(),
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

const previewTeamMemberSchema = z
  .strictObject({
    id: z.number().int().describe('Team member id.'),
    name: untrustedText('Team member name, or null when not loaded.'),
  })
  .nullable();

const previewSchema = z.strictObject({
  business: untrustedText('Business name.'),
  services: z
    .array(previewServiceSchema)
    .describe('The chosen services, in the order the client gave them.'),
  team_member: previewTeamMemberSchema.describe(
    'The chosen team member, or null for any team member.'
  ),
  second_appointment: z
    .strictObject({
      services: z
        .array(previewServiceSchema)
        .describe(
          'The services of the second appointment, in the order the client gave them.'
        ),
      team_member: previewTeamMemberSchema.describe(
        'The team member of the second appointment.'
      ),
    })
    .nullable()
    .describe(
      'The second appointment of a pair, booked at the same date and time; null for a single booking.'
    ),
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
  optional_prepayment: z
    .boolean()
    .describe(
      'True when the business also offers optional online prepayment for a chosen service in its booking widget; this booking is made without it.'
    ),
});

const FALLBACK_REASONS = [
  'not_own_place',
  'prepayment',
  'membership',
  'widget_inactive',
  'not_confirmed',
  'required_field',
] as const;

type FallbackReason = (typeof FALLBACK_REASONS)[number];

const bookOutput = z.strictObject({
  status: z
    .enum(['preview', 'booked', 'fallback'])
    .describe(
      "preview: the slot was checked and nothing is booked. booked: the booking was created. fallback: the booking cannot be made from here, nothing was booked, and the client completes it with the pre-filled link in the business's booking widget, or through the business's contacts when there is no link."
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
  second_booking_id: z
    .number()
    .int()
    .nullable()
    .describe(
      'Id of the second booking of a pair; null for a single booking and for a preview.'
    ),
  second_booking: bookingItemSchema
    .nullable()
    .describe(
      'The second booking of a pair as me_list_bookings shows it; null for a single booking, for a preview, or when the bookings could not be read back just now.'
    ),
  fallback: z
    .strictObject({
      reason: z
        .enum(FALLBACK_REASONS)
        .describe(
          "not_own_place: the client has no earlier booking at this business. prepayment: a chosen service needs online prepayment, or its prepayment is not known. membership: a chosen service is for membership holders. widget_inactive: the business takes no online bookings right now. not_confirmed: the business's booking service could not confirm the booking from here. required_field: the business needs a detail the client's Altegio profile does not have."
        ),
      link: z
        .strictObject({
          url: z.string().describe("Link to the business's booking widget."),
          kind: z
            .enum(['preselected', 'booking_form'])
            .describe(
              'preselected: the widget opens with the services, team member and time already selected. booking_form: the widget opens without the selection.'
            ),
        })
        .nullable()
        .describe(
          'The booking widget link, or null when the business has no usable booking form.'
        ),
    })
    .nullable()
    .describe('Set only when status is fallback.'),
});

type BookOutput = z.infer<typeof bookOutput>;

/** The arguments a confirmation token is bound to: the selection, never the token. */
function boundArguments(input: BookInput): Record<string, unknown> {
  return {
    location_id: input.location_id,
    service_ids: input.service_ids,
    team_member_id: input.team_member_id,
    datetime: input.datetime,
    // Explicit, null for a single booking: a single token and a pair token
    // never verify for each other (T-05-05).
    second_appointment: input.second_appointment ?? null,
  };
}

/** One appointment of a request: its services and its team member. */
interface Appointment {
  serviceIds: readonly number[];
  teamMemberId: number;
}

function firstAppointment(input: BookInput): Appointment {
  return { serviceIds: input.service_ids, teamMemberId: input.team_member_id };
}

function secondAppointment(input: BookInput): Appointment | null {
  const second = input.second_appointment;
  return second === undefined
    ? null
    : { serviceIds: second.service_ids, teamMemberId: second.team_member_id };
}

function selectionOf(
  appointment: Appointment,
  datetime: string
): CheckSelection {
  return {
    serviceIds: appointment.serviceIds,
    teamMemberId: appointment.teamMemberId,
    datetime,
  };
}

/**
 * Two appointments need two different named team members: team member 0 means
 * "any", which the API would resolve itself, possibly to the same team member
 * twice (D-01, T-05-04). Refused before any upstream call.
 */
function assertPairRule(input: BookInput): void {
  const second = input.second_appointment;
  if (second === undefined) return;
  if (
    input.team_member_id === 0 ||
    second.team_member_id === 0 ||
    input.team_member_id === second.team_member_id
  ) {
    throw new ToolError(
      'Nothing was booked: two appointments need two different named team members.',
      'choose two different team members with business_list_team_members, then call me_book again without confirmation_token.'
    );
  }
}

export function durationText(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/** The business's online cancellation rule from its card, or null when the card states none. */
export function cancellationText(rules: BusinessRules): string | null {
  if (rules.cancelAllowed === null) return null;
  if (!rules.cancelAllowed) {
    return 'This business does not allow online cancellation.';
  }
  return rules.cancelBeforeSeconds !== null && rules.cancelBeforeSeconds > 0
    ? `Online cancellation is allowed until ${durationText(rules.cancelBeforeSeconds)} before the start.`
    : 'Online cancellation is allowed.';
}

type FallbackLink = { url: string; kind: 'preselected' | 'booking_form' };

/** The pre-filled widget link for the selection, built from the card as book_check builds it. */
function selectionLink(input: BookInput, card: BusinessCard): FallbackLink {
  const link = buildBookingLink({
    locationId: input.location_id,
    formUrl: card.bookingFormUrl,
    teamMemberId: input.team_member_id,
    serviceIds: input.service_ids,
    slotDatetime: input.datetime,
    businessUtcOffsetHours: card.utcOffsetHours,
    anyTeamMemberAllowed: card.anyTeamMemberAllowed,
  });
  return { url: link.url, kind: link.kind };
}

function fallbackOutput(
  input: BookInput,
  reason: FallbackReason,
  link: FallbackLink | null
): BookOutput {
  return {
    status: 'fallback',
    location_id: input.location_id,
    preview: null,
    confirmation_token: null,
    expires_at: null,
    booking_id: null,
    booking: null,
    second_booking_id: null,
    second_booking: null,
    fallback: { reason, link },
  };
}

/**
 * An inactive widget (or a card without a booking form): the plain booking-form
 * link when the card has a form on an allowed host, else no link at all and the
 * business's contacts as the way on.
 */
function widgetInactiveFallback(
  input: BookInput,
  card: BusinessCard
): BookOutput {
  const usable =
    card.bookingFormUrl !== null &&
    bookableFormUrl(card.bookingFormUrl) !== null;
  const link = usable
    ? plainBookingLink(input.location_id, card.bookingFormUrl)
    : null;
  return fallbackOutput(
    input,
    'widget_inactive',
    link === null ? null : { url: link.url, kind: link.kind }
  );
}

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
  const call = upstreamCall(ctx);

  // A place with no record of the client's: the widget completes it (D-04).
  if (!records.some((record) => record.locationId === input.location_id)) {
    const card = await deps.booking
      .company(input.location_id, call)
      .catch((error) => {
        throw toToolError(error);
      });
    return canTakeOnlineBookings(card)
      ? fallbackOutput(input, 'not_own_place', selectionLink(input, card))
      : widgetInactiveFallback(input, card);
  }

  const first = firstAppointment(input);
  const second = secondAppointment(input);
  const appointments = second === null ? [first] : [first, second];
  const [cardResult, catalogResult, membersResult] = await Promise.allSettled([
    deps.booking.company(input.location_id, call),
    deps.booking.services(input.location_id, {}, call),
    appointments.some((appointment) => appointment.teamMemberId > 0)
      ? deps.booking.teamMembers(input.location_id, {}, call)
      : Promise.resolve(null),
  ]);
  if (cardResult.status === 'rejected') throw toToolError(cardResult.reason);
  if (catalogResult.status === 'rejected') {
    throw toToolError(catalogResult.reason);
  }
  const card = cardResult.value;
  if (!canTakeOnlineBookings(card)) return widgetInactiveFallback(input, card);

  const currency = sanitizeUntrusted(card.currency, {
    maxChars: LABEL_MAX_CHARS,
  });
  const firstChosen = selectedServices(
    first.serviceIds,
    catalogResult.value,
    currency
  );
  const secondChosen =
    second === null
      ? null
      : selectedServices(second.serviceIds, catalogResult.value, currency);
  const chosen =
    secondChosen === null ? [firstChosen] : [firstChosen, secondChosen];
  if (chosen.some((entry) => !entry.complete)) {
    throw new ToolError(
      `Nothing was booked: ${SERVICE_NOT_AVAILABLE.message}`,
      SERVICE_NOT_AVAILABLE.nextAction
    );
  }
  // Online prepayment is taken only by the widget; a service whose prepayment
  // is required, or not known, must not be booked here (T-04.1-12).
  if (
    chosen.some((entry) =>
      entry.services.some(
        (service) =>
          service.prepayment === 'required' || service.prepayment === 'unknown'
      )
    )
  ) {
    return fallbackOutput(input, 'prepayment', selectionLink(input, card));
  }
  const membershipOnly = new Set(
    catalogResult.value.services
      .filter((service) => service.membershipOnly)
      .map((service) => service.id)
  );
  if (
    appointments.some((appointment) =>
      appointment.serviceIds.some((id) => membershipOnly.has(id))
    )
  ) {
    return fallbackOutput(input, 'membership', selectionLink(input, card));
  }
  const teamMembers =
    membersResult.status === 'fulfilled' ? membersResult.value : null;
  const firstMember = selectedTeamMember(first.teamMemberId, teamMembers);
  const secondMember =
    second === null
      ? null
      : selectedTeamMember(second.teamMemberId, teamMembers);

  try {
    // The check has its own budget inside the call deadline.
    const checkCall = {
      ...call,
      signal: AbortSignal.any([ctx.signal, ctx.timeout(BOOK_CHECK_STEP_MS)]),
    };
    if (second === null) {
      await deps.booking.check(
        input.location_id,
        selectionOf(first, input.datetime),
        checkCall
      );
    } else {
      await deps.booking.checkPair(
        input.location_id,
        selectionOf(first, input.datetime),
        selectionOf(second, input.datetime),
        checkCall
      );
    }
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
  const serviceItems = (entry: typeof firstChosen) =>
    entry.services.map((service) => ({
      id: service.id,
      title: service.title,
      price: service.price,
    }));
  return {
    status: 'preview',
    location_id: input.location_id,
    preview: {
      business: sanitizeUntrusted(card.name, { maxChars: NAME_MAX_CHARS }),
      services: serviceItems(firstChosen),
      team_member: firstMember.teamMember,
      second_appointment:
        secondChosen === null || secondMember === null
          ? null
          : {
              services: serviceItems(secondChosen),
              team_member: secondMember.teamMember,
            },
      ...slot,
      time_zone: sanitizeUntrusted(card.timeZoneName, {
        maxChars: LABEL_MAX_CHARS,
      }),
      cancellation: cancellationText(card.rules),
      optional_prepayment: chosen.some((entry) =>
        entry.services.some((service) => service.prepayment === 'optional')
      ),
    },
    confirmation_token: issued.token,
    expires_at: new Date(issued.expiresAt).toISOString(),
    booking_id: null,
    booking: null,
    second_booking_id: null,
    second_booking: null,
    fallback: null,
  };
}

const NEW_PREVIEW_NEXT =
  'call me_book again without confirmation_token for a new preview, and confirm it with the client.';

// Errors of the create call (D-02). The numeric code decides, never the upstream
// text, and no write error quotes the upstream message: a create rejection can
// repeat the phone or name that was sent. A used token cannot be redeemed
// again, so every advice that retries starts from a new preview.

const NEW_PREVIEW_AFTER_TIME =
  'choose another time with business_list_time_slots, then call me_book without confirmation_token for a new preview.';
const BOOK_CHECK_LINK_NEXT =
  "call book_check with the same selection for the business's pre-filled booking link.";

/** BookingErrorCodesDict: 431 phone, 432 code, 433 time, 434 blacklisted, 435 name, 436 team member, 437 overlap. */
const TAKEN_CODE = 433;
const BLACKLISTED_CODE = 434;
const NO_TEAM_MEMBER_CODE = 436;
const OVERLAP_CODE = 437;
const PROFILE_CODES: readonly number[] = [431, 435];
const WIDGET_CODE_CODE = 432;

function writeRejectedText(error: UpstreamError): UpstreamErrorText {
  const has = (code: number): boolean => error.codes.includes(code);
  if (has(TAKEN_CODE)) {
    return {
      message: 'Nothing was booked: this time was taken meanwhile.',
      nextAction: NEW_PREVIEW_AFTER_TIME,
    };
  }
  if (has(NO_TEAM_MEMBER_CODE)) {
    return {
      message: 'Nothing was booked: no team member is available at this time.',
      nextAction:
        'choose a team member with business_list_team_members or another time with business_list_time_slots, then call me_book without confirmation_token for a new preview.',
    };
  }
  if (has(OVERLAP_CODE)) {
    return {
      message:
        'Nothing was booked: the selected times overlap another booking.',
      nextAction: NEW_PREVIEW_AFTER_TIME,
    };
  }
  if (PROFILE_CODES.some(has)) {
    return {
      message:
        "Nothing was booked: the business could not use the name or phone in the client's Altegio profile.",
      nextAction: `tell the user to check the name and phone in their Altegio profile, or ${BOOK_CHECK_LINK_NEXT}`,
    };
  }
  if (has(WIDGET_CODE_CODE)) {
    return {
      message:
        'Nothing was booked: this business confirms bookings with a code that only its booking widget can request.',
      nextAction: BOOK_CHECK_LINK_NEXT,
    };
  }
  return {
    message: 'Nothing was booked: the business did not accept this booking.',
    nextAction: 'call me_book without confirmation_token for a new preview.',
  };
}

const UNKNOWN_OUTCOME: UpstreamErrorText = {
  message:
    'The booking service did not answer, so it is not known whether the booking was made.',
  nextAction:
    'call me_list_bookings to check before booking again; do not repeat this confirmation.',
};

/**
 * What a failed create says (D-02, T-04.1-08): a code the API gave, the
 * blacklist (434 comes as HTTP 403), an outcome that is not known (a timeout, a
 * 5xx or an unexpected answer may hide a booking that exists), and busy.
 */
export const WRITE_ERRORS: UpstreamErrorOverrides = {
  rejected: writeRejectedText,
  bad_request: writeRejectedText,
  unauthorized: (error) =>
    error.codes.includes(BLACKLISTED_CODE)
      ? {
          message:
            'Nothing was booked: this business does not accept online bookings from this client.',
          nextAction:
            'tell the user to contact the business directly, using the contact details from business_get.',
        }
      : defaultText(error),
  unavailable: UNKNOWN_OUTCOME,
  contract_drift: UNKNOWN_OUTCOME,
  rate_limited: (error) => ({
    message: 'Nothing was booked: the booking service is busy right now.',
    nextAction: `wait ${waitSeconds(error)} seconds, then call me_book without confirmation_token for a new preview.`,
  }),
};

/** A failed create as an in-band error that quotes nothing the business wrote back. */
export function toWriteToolError(error: unknown): Error {
  return toToolError(error, WRITE_ERRORS, { quoteUpstream: false });
}

const PROFILE_READ_FAILED: UpstreamErrorText = {
  message:
    "Nothing was booked: the booking service did not answer when the client's profile was read.",
  nextAction: NEW_PREVIEW_NEXT,
};

/** The profile read comes before the create: a failure there means nothing was booked, and the token is spent. */
const PROFILE_ERRORS: UpstreamErrorOverrides = {
  unavailable: PROFILE_READ_FAILED,
  contract_drift: PROFILE_READ_FAILED,
  rate_limited: (error) => ({
    message: 'Nothing was booked: the booking service is busy right now.',
    nextAction: `wait ${waitSeconds(error)} seconds, then call me_book without confirmation_token for a new preview.`,
  }),
};

/**
 * The create did not book and the business's own booking widget is the way on:
 * the anti-fraud paths, and a business that requires a detail the profile lacks.
 * The pre-filled link is built from the card, as book_check builds it.
 */
async function fallbackResult(
  input: BookInput,
  deps: ToolDeps,
  ctx: ToolContext,
  reason: 'not_confirmed' | 'required_field'
): Promise<BookOutput> {
  let card;
  try {
    card = await deps.booking.company(input.location_id, upstreamCall(ctx));
  } catch {
    throw new ToolError(
      "Nothing was booked, and the business's booking link could not be prepared just now.",
      BOOK_CHECK_LINK_NEXT
    );
  }
  return fallbackOutput(input, reason, selectionLink(input, card));
}

/** Confirm: redeems the token, reads the profile, creates the booking(s) and reads them back. */
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
        : verdict === 'used'
          ? 'Nothing was booked: this confirmation_token was already used.'
          : 'Nothing was booked: this confirmation_token is not valid for this selection and sign-in.',
      NEW_PREVIEW_NEXT
    );
  }

  const profile = await deps.booking.myProfile(userSide).catch((error) => {
    throw toToolError(error, PROFILE_ERRORS, { quoteUpstream: false });
  });
  if (profile === null) {
    throw new ToolError(
      "Nothing was booked: the client's Altegio profile has no name or phone, which the business needs for a booking.",
      "tell the user to complete their profile in Altegio.me, or call book_check for the business's pre-filled booking link."
    );
  }

  const first = firstAppointment(input);
  const second = secondAppointment(input);
  let bookingIds: readonly [number | null, number | null];
  try {
    if (second === null) {
      const created = await deps.booking.createBooking(
        input.location_id,
        selectionOf(first, input.datetime),
        profile,
        userSide
      );
      bookingIds = [created.bookingId, null];
    } else {
      const created = await deps.booking.createPairBooking(
        input.location_id,
        selectionOf(first, input.datetime),
        selectionOf(second, input.datetime),
        profile,
        userSide
      );
      bookingIds = created.bookingIds;
    }
  } catch (error) {
    if (error instanceof UpstreamError) {
      if (error.kind === 'anti_fraud') {
        return fallbackResult(input, deps, ctx, 'not_confirmed');
      }
      // A business that requires a field the profile lacks (the e-mail) answers
      // 422 with no code; the widget collects it.
      if (
        error.kind === 'rejected' &&
        error.codes.length === 0 &&
        error.requiredFields.length > 0
      ) {
        return fallbackResult(input, deps, ctx, 'required_field');
      }
    }
    throw toWriteToolError(error);
  }
  const [firstId, secondId] = bookingIds;
  if (firstId === null || (second !== null && secondId === null)) {
    // The answer names one of the two bookings only; what exists is not known
    // from here, and me_list_bookings shows it.
    throw new ToolError(UNKNOWN_OUTCOME.message, UNKNOWN_OUTCOME.nextAction);
  }

  // Read the new bookings back as me_list_bookings shows them; a failed or
  // empty re-read keeps the bookings, which exist upstream either way.
  let booking: BookingItem | null = null;
  let secondBooking: BookingItem | null = null;
  try {
    const records = await deps.booking.myRecords(userSide);
    const now = Date.now();
    const record = records.find((entry) => entry.id === firstId);
    if (record !== undefined) booking = toBookingItem(record, now);
    const secondRecord = records.find((entry) => entry.id === secondId);
    if (secondRecord !== undefined) {
      secondBooking = toBookingItem(secondRecord, now);
    }
  } catch {
    booking = null;
    secondBooking = null;
  }
  return {
    status: 'booked',
    location_id: input.location_id,
    preview: null,
    confirmation_token: null,
    expires_at: null,
    booking_id: firstId,
    booking,
    second_booking_id: secondId,
    second_booking: secondBooking,
    fallback: null,
  };
}

type PreviewService = z.infer<typeof previewServiceSchema>;

function renderAppointment(
  label: string,
  services: PreviewService[],
  who: { id: number } | null
): string[] {
  return [
    label,
    ...services.map(
      (service) => `- service ${service.id}: ${priceText(service.price)}.`
    ),
    `Team member: ${who === null ? teamMemberText(0) : teamMemberText(who.id)}.`,
  ];
}

function renderPreview(out: BookOutput): string {
  const shown = out.preview;
  if (shown === null) return 'No preview was produced.';
  const who = shown.team_member;
  const pair = shown.second_appointment;
  const lines = [
    'Preview, nothing is booked yet:',
    `Location ${out.location_id}, ${shown.date} at ${shown.time} (UTC${shown.utc_offset}, the business's local time).`,
  ];
  if (pair === null) {
    lines.push('Services, in the order chosen:');
    lines.push(
      ...shown.services.map(
        (service) => `- service ${service.id}: ${priceText(service.price)}.`
      )
    );
    lines.push(
      `Team member: ${who === null ? teamMemberText(0) : teamMemberText(who.id)}.`
    );
  } else {
    lines.push(
      ...renderAppointment('First appointment:', shown.services, who),
      ...renderAppointment(
        'Second appointment:',
        pair.services,
        pair.team_member
      )
    );
  }
  lines.push('Prices are in the currency of the business.');
  if (shown.optional_prepayment) {
    lines.push(
      'The business also offers optional online prepayment in its booking widget; this booking is made without it.'
    );
  }
  if (pair !== null) {
    lines.push(
      "Both bookings are under the client's name; nothing about the second person is sent."
    );
  }
  if (shown.cancellation !== null) lines.push(shown.cancellation);
  lines.push(
    `Next: show this to the user; only after the user agrees, call me_book again with the same location_id, service_ids, team_member_id, datetime${pair === null ? '' : ', second_appointment'} and confirmation_token ${out.confirmation_token ?? ''} (valid until ${out.expires_at ?? ''} UTC).`
  );

  const fields: Record<string, unknown> = {
    Business: shown.business,
    'Time zone': shown.time_zone,
  };
  const everyService = [...shown.services, ...(pair?.services ?? [])];
  const currency = everyService.find((service) => service.price !== null)?.price
    ?.currency;
  if (currency !== undefined) fields.Currency = currency;
  for (const service of everyService) {
    fields[`service ${service.id}`] = service.title;
  }
  for (const member of [who, pair?.team_member ?? null]) {
    if (member !== null) fields[`team member ${member.id}`] = member.name;
  }
  return withUntrustedBlock(lines.join('\n'), fields);
}

const FALLBACK_TEXT: Record<FallbackReason, string> = {
  not_own_place:
    "Not booked. This client has no earlier booking at this business, so the booking is completed in the business's booking widget.",
  prepayment:
    "Not booked. A chosen service needs online prepayment, which only the business's booking widget takes.",
  membership:
    "Not booked. A chosen service is for membership holders, which only the business's booking widget checks.",
  widget_inactive:
    'Not booked. This business does not take online bookings right now.',
  not_confirmed:
    'Not booked: the business could not confirm this booking from here.',
  required_field:
    "Not booked: the business needs more details for this booking than the client's Altegio profile has.",
};

function renderFallback(out: BookOutput): string {
  const { fallback } = out;
  const lines = [
    fallback === null
      ? FALLBACK_TEXT.not_confirmed
      : FALLBACK_TEXT[fallback.reason],
  ];
  if (fallback?.link != null) {
    lines.push(
      fallback.link.kind === 'preselected'
        ? `Booking link with the services, team member and time already selected: ${fallback.link.url}`
        : `Booking link to the business's booking form, without the selection: ${fallback.link.url}`
    );
    lines.push(CONFIRMATION_STATEMENT);
  } else {
    lines.push(
      'Next: tell the user to contact the business directly, using the contact details from business_get.'
    );
  }
  return lines.join('\n');
}

function renderBooked(out: BookOutput): string {
  const { booking, second_booking: secondBooking } = out;
  const pair = out.second_booking_id !== null;
  const lines = [
    pair
      ? `Booked: two appointments at location ${out.location_id}${
          booking === null ? '' : `, ${booking.datetime}`
        }: booking ${out.booking_id ?? ''} and booking ${out.second_booking_id ?? ''}. Both are under the client's name.`
      : `Booked: booking ${out.booking_id ?? ''} at location ${out.location_id}${
          booking === null ? '' : `, ${booking.datetime}`
        }.`,
  ];
  if (booking === null || (pair && secondBooking === null)) {
    lines.push(
      `The ${pair ? 'bookings' : 'booking'} could not be read back just now; me_list_bookings shows ${pair ? 'them' : 'it'}.`
    );
  }
  lines.push(
    pair
      ? 'Next: me_list_bookings lists both; each one is moved or cancelled on its own with me_reschedule_booking or me_cancel_booking.'
      : 'Next: me_list_bookings lists it.'
  );
  const blocks: Record<string, unknown> = {};
  if (booking !== null) blocks.Booking = bookingBlockValue(booking);
  if (secondBooking !== null) {
    blocks['Second booking'] = bookingBlockValue(secondBooking);
  }
  return withUntrustedBlock(lines.join('\n'), blocks);
}

export const meBook = defineTool<typeof bookInput, typeof bookOutput, ToolDeps>(
  {
    name: TOOL_NAME,
    title: 'Book at one of my places',
    description:
      "Books for the signed-in client at one of their own places, in two calls. The first call checks the time with the business and returns a preview and a confirmation_token valid for 10 minutes; nothing is booked. After the client agrees, the second call with the same selection and that token creates the booking and returns it. The client's name and phone come from their Altegio profile. Where the chat cannot complete a booking, namely online prepayment, a membership-only service, an inactive booking widget or a place without an earlier booking, the answer states the reason and carries the pre-filled booking widget link. With the optional second_appointment (a different named team member, the same start) it books two people side by side in one preview and one confirmation, both under the client's name. Needs the client's sign-in.",
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
      out.status === 'preview'
        ? renderPreview(out)
        : out.status === 'fallback'
          ? renderFallback(out)
          : renderBooked(out),
    handler: async ({ input, deps, ctx }) => {
      assertPairRule(input);
      const token = input[CONFIRMATION_TOKEN_ARG];
      return token === undefined
        ? preview(input, deps, ctx)
        : confirm(input, token, deps, ctx);
    },
  }
);
