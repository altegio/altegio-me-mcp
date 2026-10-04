import { z } from 'zod';
import {
  BOOKING_ROUTES,
  type BusinessCard,
  type ServiceCatalog,
  type TeamMember,
} from '../booking/client.js';
import {
  SLOT_DATETIME_PATTERN,
  buildBookingLink,
  canTakeOnlineBookings,
  formatUtcOffset,
  parseSlotDatetime,
  plainBookingLink,
  type BookingLink,
} from '../booking/deep-link.js';
import { UpstreamError } from '../booking/errors.js';
import {
  LABEL_MAX_CHARS,
  MAX_SERVICE_IDS,
  NAME_MAX_CHARS,
  PREPAYMENT,
  PREPAYMENT_TEXT,
  locationIdInput,
  priceText,
  teamMemberOrAnyInput,
  teamMemberText,
  uniqueServiceIds,
  untrustedText,
} from './business.js';
import { ToolError } from './errors.js';
import { defineTool } from './factory.js';
import type { ToolDeps } from './registry.js';
import {
  toToolError,
  type UpstreamErrorOverrides,
  type UpstreamErrorText,
} from './upstream-errors.js';
import { sanitizeUntrusted, withUntrustedBlock } from './untrusted.js';

// book_check (BOOK-01, BOOK-03, BOOK-05): the hand-off. It checks the chosen
// services, team member (0 = any) and slot datetime through the validation
// route, which creates no record and no hold (D-04), then returns a link to
// the business's booking widget with that selection already made. Only a 201
// for exactly this selection, in this call, makes a slot "verified". Titles,
// prices and names are read from the Altegio API after the 201, never taken
// from the model's input. No client personal data goes in or out (D-08): the
// client enters it only in the widget.

export const CONFIRMATION_STATEMENT =
  "The client completes the booking in the business's Altegio booking widget, under the business's phone confirmation and prepayment rules. Nothing is booked yet, and no personal details are needed in this conversation.";

export const NOTE_REPEAT_SELECTION =
  "This link opens the business's booking form without the selection; the client chooses the service, team member and time again there.";

export const NOTE_UNVERIFIED =
  'The slot could not be checked just now; the booking widget shows whether it is still free.';

export const NOTE_PREPAYMENT =
  'The booking widget shows the final price and any prepayment terms before the client confirms.';

export const NOTE_NAMES_UNAVAILABLE =
  'Service or team member names could not be loaded; the booking widget shows them.';

const bookCheckInput = z.strictObject({
  location_id: locationIdInput,
  service_ids: uniqueServiceIds(
    1,
    `Services to book, 1 to ${MAX_SERVICE_IDS} unique service ids, in the order the client chose them.`
  ),
  team_member_id: teamMemberOrAnyInput,
  datetime: z
    .string()
    .regex(SLOT_DATETIME_PATTERN)
    .refine((value) => parseSlotDatetime(value) !== null, {
      message: 'must be a slot datetime with a valid date, time and offset',
    })
    .describe(
      'The datetime of a free slot exactly as business_list_time_slots returned it.'
    ),
});

type BookCheckInput = z.infer<typeof bookCheckInput>;

const selectedServiceSchema = z.strictObject({
  id: z.number().int().describe('Service id.'),
  title: untrustedText(
    'Service title, an empty string when the business gave none, or null when it could not be loaded.'
  ),
  price: z
    .strictObject({
      min: z.number().describe('Lowest price.'),
      max: z.number().describe('Highest price; equal to min for one price.'),
      currency: untrustedText('Currency of the business.'),
    })
    .nullable()
    .describe(
      'Price range as the business set it, or null when no price is set (price on request) or it could not be loaded.'
    ),
  prepayment: z
    .enum(['not_offered', 'optional', 'required', 'unknown'])
    .describe(
      'Online prepayment for this service: not_offered, optional, required or unknown. The booking widget shows the final terms.'
    ),
});

type SelectedService = z.infer<typeof selectedServiceSchema>;

const bookCheckOutput = z.strictObject({
  status: z
    .enum(['verified', 'unverified'])
    .describe(
      'verified: the booking service confirmed in this call that the selection can be booked. unverified: the check was inconclusive.'
    ),
  link: z.strictObject({
    url: z.string().describe("Link to the business's booking widget."),
    kind: z
      .enum(['preselected', 'booking_form'])
      .describe(
        'preselected: the widget opens with the services, team member and time already selected. booking_form: the widget opens without the selection.'
      ),
  }),
  business: z.strictObject({
    location_id: z.number().int().describe('Location id of the business.'),
    name: untrustedText('Business name.'),
  }),
  selection: z.strictObject({
    services: z
      .array(selectedServiceSchema)
      .describe('The chosen services, in the order the client gave them.'),
    team_member: z
      .strictObject({
        id: z.number().int().describe('Team member id.'),
        name: untrustedText(
          'Team member name as the business shows it, or null when it could not be loaded.'
        ),
      })
      .nullable()
      .describe('The chosen team member, or null for any team member.'),
    date: z
      .string()
      .describe("Date of the slot, YYYY-MM-DD, in the business's local time."),
    time: z
      .string()
      .describe("Start time, HH:MM, in the business's local time."),
    utc_offset: z
      .string()
      .describe('UTC offset of the slot, for example +03:00.'),
    time_zone: untrustedText('Time zone name of the business.'),
  }),
  notes: z
    .array(z.string())
    .describe('What the client should know about the link and the terms.'),
  confirmation: z
    .string()
    .describe('How the booking is completed after this check.'),
});

type BookCheckOutput = z.infer<typeof bookCheckOutput>;

const ANOTHER_TIME_NEXT = 'choose another time with business_list_time_slots.';

const TIME_NOT_AVAILABLE: UpstreamErrorText = {
  message:
    'This time is no longer available for the chosen services and team member.',
  nextAction: ANOTHER_TIME_NEXT,
};

const SERVICE_NOT_AVAILABLE: UpstreamErrorText = {
  message: 'One of the chosen services cannot be booked at this time.',
  nextAction: 'choose different services with business_list_services.',
};

const SELECTION_NOT_ACCEPTED: UpstreamErrorText = {
  message: 'The booking service did not accept this selection.',
  nextAction: ANOTHER_TIME_NEXT,
};

/** BookingErrorCodesDict: 433 time, 436 no team member, 437 not enough time, 438 service. */
const SERVICE_NOT_AVAILABLE_CODE = 438;
const TIME_NOT_AVAILABLE_CODES: ReadonlySet<number> = new Set([433, 436, 437]);

/** Branches on the numeric codes, never on the localized upstream message. */
function rejectedText(error: UpstreamError): UpstreamErrorText {
  if (error.codes.includes(SERVICE_NOT_AVAILABLE_CODE)) {
    return SERVICE_NOT_AVAILABLE;
  }
  if (error.codes.some((code) => TIME_NOT_AVAILABLE_CODES.has(code))) {
    return TIME_NOT_AVAILABLE;
  }
  return SELECTION_NOT_ACCEPTED;
}

const CHECK_ERRORS: UpstreamErrorOverrides = {
  rejected: rejectedText,
  bad_request: rejectedText,
  not_found: {
    message: 'The business or one of the chosen services was not found.',
    nextAction:
      'check the location id with business_get and the service ids with business_list_services.',
  },
};

const NO_BOOKING_WIDGET = {
  message:
    'This business does not take online bookings through a booking widget right now.',
  nextAction:
    'tell the user to contact the business directly, using the contact details from business_get.',
} as const;

/** The same predicate as business_get's `enabled`: an active widget and a booking form; otherwise a link would lead nowhere. */
function requireBookingWidget(card: BusinessCard): void {
  if (!canTakeOnlineBookings(card)) {
    throw new ToolError(
      NO_BOOKING_WIDGET.message,
      NO_BOOKING_WIDGET.nextAction
    );
  }
}

/** Date, time and offset from the slot string's digits; never through a Date. */
function slotFields(datetime: string): {
  date: string;
  time: string;
  utc_offset: string;
} {
  const parts = parseSlotDatetime(datetime);
  if (parts === null) {
    // The input schema already refuses such a value.
    throw new TypeError('datetime must be a valid slot datetime');
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    utc_offset: formatUtcOffset(parts.offsetMinutes),
  };
}

function unknownService(id: number): SelectedService {
  return { id, title: null, price: null, prepayment: 'unknown' };
}

/** The chosen services in input order, with titles and prices from the catalog. */
function selectedServices(
  serviceIds: readonly number[],
  catalog: ServiceCatalog | null,
  currency: string | null
): { services: SelectedService[]; complete: boolean } {
  if (catalog === null) {
    return { services: serviceIds.map(unknownService), complete: false };
  }
  const byId = new Map(
    catalog.services.map((service) => [service.id, service])
  );
  let complete = true;
  const services = serviceIds.map((id): SelectedService => {
    const service = byId.get(id);
    if (service === undefined) {
      complete = false;
      return unknownService(id);
    }
    return {
      id,
      // null means "not loaded" (see servicePriceText), so a service the
      // catalog does carry keeps an empty title when its title cleans to nothing.
      title:
        sanitizeUntrusted(service.title, { maxChars: LABEL_MAX_CHARS }) ?? '',
      // 0 and 0 is no price set (price on request); prices stay unrounded.
      price:
        service.priceMin === 0 && service.priceMax === 0
          ? null
          : { min: service.priceMin, max: service.priceMax, currency },
      prepayment:
        service.prepaid === null ? 'unknown' : PREPAYMENT[service.prepaid],
    };
  });
  return { services, complete };
}

function selectedTeamMember(
  teamMemberId: number,
  members: TeamMember[] | null
): {
  teamMember: BookCheckOutput['selection']['team_member'];
  complete: boolean;
} {
  if (teamMemberId === 0) return { teamMember: null, complete: true };
  const member = members?.find((entry) => entry.id === teamMemberId);
  return {
    teamMember: {
      id: teamMemberId,
      name:
        member === undefined
          ? null
          : sanitizeUntrusted(member.name, { maxChars: LABEL_MAX_CHARS }),
    },
    complete: member !== undefined,
  };
}

function settled<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null;
}

function output(
  input: BookCheckInput,
  card: BusinessCard,
  status: BookCheckOutput['status'],
  link: BookingLink,
  services: SelectedService[],
  teamMember: BookCheckOutput['selection']['team_member'],
  notes: string[]
): BookCheckOutput {
  return {
    status,
    link: { url: link.url, kind: link.kind },
    business: {
      location_id: input.location_id,
      name: sanitizeUntrusted(card.name, { maxChars: NAME_MAX_CHARS }),
    },
    selection: {
      services,
      team_member: teamMember,
      ...slotFields(input.datetime),
      time_zone: sanitizeUntrusted(card.timeZoneName, {
        maxChars: LABEL_MAX_CHARS,
      }),
    },
    notes,
    confirmation: CONFIRMATION_STATEMENT,
  };
}

/** After a 201: the card, the services and the named team member, in parallel through the gate. */
async function verified(
  input: BookCheckInput,
  deps: ToolDeps
): Promise<BookCheckOutput> {
  const id = input.location_id;
  const [cardResult, catalogResult, membersResult] = await Promise.allSettled([
    deps.booking.company(id),
    deps.booking.services(id),
    input.team_member_id > 0
      ? deps.booking.teamMembers(id)
      : Promise.resolve(null),
  ]);
  if (cardResult.status === 'rejected') {
    // The kind decides the advice: a 429 keeps its advised wait, a 404 says the
    // business was not found. Only a transient failure asks for a quick repeat.
    throw toToolError(cardResult.reason, {
      unavailable: {
        message:
          'The slot check passed, but the booking link could not be prepared.',
        nextAction: 'call book_check again in a few seconds.',
      },
    });
  }
  const card = cardResult.value;
  requireBookingWidget(card);

  const currency = sanitizeUntrusted(card.currency, {
    maxChars: LABEL_MAX_CHARS,
  });
  const services = selectedServices(
    input.service_ids,
    settled(catalogResult),
    currency
  );
  const member = selectedTeamMember(
    input.team_member_id,
    settled(membersResult)
  );
  const link = buildBookingLink({
    locationId: id,
    formUrl: card.bookingFormUrl,
    teamMemberId: input.team_member_id,
    serviceIds: input.service_ids,
    slotDatetime: input.datetime,
    businessUtcOffsetHours: card.utcOffsetHours,
    anyTeamMemberAllowed: card.anyTeamMemberAllowed,
  });

  const notes: string[] = [];
  if (link.kind === 'booking_form') notes.push(NOTE_REPEAT_SELECTION);
  if (!services.complete || !member.complete) {
    notes.push(NOTE_NAMES_UNAVAILABLE);
  }
  notes.push(NOTE_PREPAYMENT);
  return output(
    input,
    card,
    'verified',
    link,
    services.services,
    member.teamMember,
    notes
  );
}

/**
 * An inconclusive check (5xx, timeout, an unexpected status or body): only the
 * card is read, to keep load low while the API struggles, and the link is the
 * plain booking form.
 */
async function unverified(
  input: BookCheckInput,
  deps: ToolDeps,
  checkError: UpstreamError
): Promise<BookCheckOutput> {
  let card: BusinessCard;
  try {
    card = await deps.booking.company(input.location_id);
  } catch {
    throw toToolError(checkError);
  }
  requireBookingWidget(card);
  const link = plainBookingLink(input.location_id, card.bookingFormUrl);
  return output(
    input,
    card,
    'unverified',
    link,
    input.service_ids.map(unknownService),
    input.team_member_id === 0
      ? null
      : { id: input.team_member_id, name: null },
    [NOTE_UNVERIFIED, NOTE_REPEAT_SELECTION, NOTE_PREPAYMENT]
  );
}

function servicePriceText(service: SelectedService): string {
  if (service.price !== null) return priceText(service.price);
  // A null title is only ever a service that was not read from the catalog.
  return service.title === null ? 'price not loaded' : 'price on request';
}

function renderBookCheck(out: BookCheckOutput): string {
  const { selection } = out;
  const who = selection.team_member;
  const when = `${selection.date} at ${selection.time} (UTC${selection.utc_offset}, the business's local time)`;
  const lines = [
    out.status === 'verified'
      ? `Verified: location ${out.business.location_id} can take this selection on ${when}. Nothing is booked yet.`
      : `Not verified: the booking service could not check this selection for location ${out.business.location_id} on ${when} just now.`,
    out.link.kind === 'preselected'
      ? `Booking link with the services, team member and time already selected: ${out.link.url}`
      : `Booking link to the business's booking form, without the selection: ${out.link.url}`,
    'Services, in the order chosen:',
    ...selection.services.map(
      (service) =>
        `- service ${service.id}: ${servicePriceText(service)}, ${PREPAYMENT_TEXT[service.prepayment]}.`
    ),
    `Team member: ${who === null ? teamMemberText(0) : teamMemberText(who.id)}.`,
    'Prices are in the currency of the business.',
    ...out.notes,
    out.confirmation,
  ];

  const fields: Record<string, unknown> = {
    Business: out.business.name,
    'Time zone': selection.time_zone,
  };
  const currency = selection.services.find((service) => service.price !== null)
    ?.price?.currency;
  if (currency !== undefined) fields.Currency = currency;
  for (const service of selection.services) {
    fields[`service ${service.id}`] = service.title;
  }
  if (who !== null) fields[`team member ${who.id}`] = who.name;
  return withUntrustedBlock(lines.join('\n'), fields);
}

export const bookCheck = defineTool<
  typeof bookCheckInput,
  typeof bookCheckOutput,
  ToolDeps
>({
  name: 'book_check',
  title: 'Check a slot and get the booking link',
  description:
    "Checks with the business that the chosen services, team member and time can still be booked, without booking anything, and returns a link to the business's booking widget with that selection already made. The client completes the booking in the widget.",
  // D-04: the validation route creates no record and no hold, so the tool is
  // read-only although its first call is a POST. Confirmed live by the "D-04"
  // test in src/booking/__tests__/client.live.test.ts (plan 02-09).
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: true,
  },
  upstream: [
    BOOKING_ROUTES.check,
    BOOKING_ROUTES.company,
    BOOKING_ROUTES.services,
    BOOKING_ROUTES.teamMembers,
  ],
  input: bookCheckInput,
  output: bookCheckOutput,
  render: renderBookCheck,
  handler: async ({ input, deps }) => {
    try {
      await deps.booking.check(input.location_id, {
        serviceIds: input.service_ids,
        teamMemberId: input.team_member_id,
        datetime: input.datetime,
      });
    } catch (error) {
      if (
        error instanceof UpstreamError &&
        (error.kind === 'unavailable' || error.kind === 'contract_drift')
      ) {
        return unverified(input, deps, error);
      }
      // A taken or rejected slot gets no link at all (D-06).
      throw toToolError(error, CHECK_ERRORS);
    }
    return verified(input, deps);
  },
});
