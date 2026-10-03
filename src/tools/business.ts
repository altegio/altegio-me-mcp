import { z } from 'zod';
import {
  BOOKING_ROUTES,
  type BusinessCard,
  type PrepaidSlug,
  type ServiceCatalog,
  type TeamMember,
  type TimeSlot,
} from '../booking/client.js';
import {
  SLOT_DATETIME_PATTERN,
  formatUtcOffset,
  parseSlotDatetime,
} from '../booking/deep-link.js';
import { defineTool, type ToolHints } from './factory.js';
import {
  listOutputSchema,
  pageInputShape,
  paginateArray,
  paginationSchema,
  type Pagination,
} from './pagination.js';
import type { ToolDeps } from './registry.js';
import {
  toToolError,
  type UpstreamErrorOverrides,
  type UpstreamErrorText,
} from './upstream-errors.js';
import {
  UNTRUSTED_NOTE,
  sanitizeUntrusted,
  withUntrustedBlock,
} from './untrusted.js';

// Business tools over the public booking routes (DISC-01). "Business" is the
// user-facing term (D-07); the API calls the same thing a location.

/** Read-only tools that call the Altegio API carry openWorldHint, as in Altegio.Pro MCP (D-10). */
const UPSTREAM_READ_HINTS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
  idempotentHint: true,
} as const satisfies ToolHints;

function untrustedText(label: string) {
  return z.string().nullable().describe(`${label} ${UNTRUSTED_NOTE}`);
}

const bookingFormSchema = z.strictObject({
  id: z.number().int().describe('Booking form id.'),
  title: untrustedText('Booking form title.'),
  url: z.string().describe('Booking form address.'),
  is_default: z.boolean().describe('Whether this is the default form.'),
});

const businessCardSchema = z.strictObject({
  location_id: z.number().int().describe('Location id of the business.'),
  name: untrustedText('Business name.'),
  category: untrustedText('Short category description.'),
  address: untrustedText('Street address.'),
  city: untrustedText('City.'),
  country: untrustedText('Country.'),
  phone: untrustedText('Public business phone, when the business shows one.'),
  website: untrustedText('Business website.'),
  time_zone: z.strictObject({
    name: untrustedText('Time zone name.'),
    utc_offset_hours: z
      .number()
      .nullable()
      .describe('UTC offset in hours, may be fractional.'),
  }),
  currency: untrustedText('Currency.'),
  online_booking: z.strictObject({
    enabled: z
      .boolean()
      .describe(
        'Whether the business takes online bookings: its widget is active and it has a booking form.'
      ),
    widget_active: z
      .boolean()
      .describe('Whether the booking widget is active.'),
    phone_confirmation: z
      .boolean()
      .nullable()
      .describe('Whether a booking needs phone confirmation in the widget.'),
    any_team_member_allowed: z
      .boolean()
      .describe('Whether a client may book without choosing a team member.'),
    prepayment_policy: untrustedText('Prepayment policy type.'),
    booking_form_url: z
      .string()
      .nullable()
      .describe('Address of the default booking form.'),
    booking_forms: z.array(bookingFormSchema),
  }),
  next_free_slot: z
    .string()
    .nullable()
    .describe(
      'Next free slot as an ISO 8601 datetime with offset, or null when the booking service does not provide it.'
    ),
});

type BusinessCardOutput = z.infer<typeof businessCardSchema>;

/** Cap on the business name, in code points; other text fields use the default. */
const NAME_MAX_CHARS = 200;

/**
 * A booking-form address we may hand to a client: an https URL that parses
 * and needed no cleaning. Anything else is dropped (T-02-38).
 */
function httpsUrl(value: string | null): string | null {
  if (value === null) return null;
  const text = sanitizeUntrusted(value);
  if (text === null || text !== value) return null;
  try {
    return new URL(text).protocol === 'https:' ? text : null;
  } catch {
    return null;
  }
}

function renderPhoneConfirmation(required: boolean | null): string {
  if (required === null) return 'unknown';
  return required ? 'required' : 'not required';
}

function renderOffset(hours: number | null): string {
  if (hours === null) return 'unknown';
  return `${hours >= 0 ? '+' : ''}${hours} hours`;
}

function renderCard(out: BusinessCardOutput): string {
  const booking = out.online_booking;
  const defaultForm = booking.booking_forms.find((form) => form.is_default);
  const summary = [
    `Business card for location ${out.location_id}.`,
    `Online booking: ${booking.enabled ? 'enabled' : 'not available'}.`,
    `Phone confirmation: ${renderPhoneConfirmation(booking.phone_confirmation)}.`,
    `UTC offset: ${renderOffset(out.time_zone.utc_offset_hours)}.`,
    `Next free slot: ${out.next_free_slot ?? 'not available from the booking service'}.`,
    `Booking forms: ${booking.booking_forms.length}${defaultForm === undefined ? '' : `, default form ${defaultForm.id}`}.`,
  ].join('\n');

  const fields: Record<string, unknown> = {
    Name: out.name,
    Category: out.category,
    Address: out.address,
    City: out.city,
    Country: out.country,
    Phone: out.phone,
    Website: out.website,
    'Time zone': out.time_zone.name,
    Currency: out.currency,
  };
  for (const form of booking.booking_forms) {
    fields[`Booking form ${form.id}`] = form.title;
  }
  return withUntrustedBlock(summary, fields);
}

const businessGetInput = z.strictObject({
  location_id: z
    .number()
    .int()
    .positive()
    .describe('Location id of the business.'),
});

export const businessGet = defineTool<
  typeof businessGetInput,
  typeof businessCardSchema,
  ToolDeps
>({
  name: 'business_get',
  title: 'Get business card',
  description:
    'Returns the card of one business that takes online bookings through Altegio: name, category, address, contact details, time zone, currency, whether online booking is enabled, the next free slot when the booking service provides one, and its booking forms.',
  annotations: UPSTREAM_READ_HINTS,
  upstream: [BOOKING_ROUTES.company],
  input: businessGetInput,
  output: businessCardSchema,
  render: renderCard,
  handler: async ({ input, deps }) => {
    let card: BusinessCard;
    try {
      card = await deps.booking.company(input.location_id);
    } catch (error) {
      // Every upstream failure becomes an in-band error that names the next action (BAPI-01).
      throw toToolError(error);
    }
    const forms = card.bookingForms.flatMap((form) => {
      const url = httpsUrl(form.url);
      return url === null
        ? []
        : [
            {
              id: form.id,
              title: sanitizeUntrusted(form.title),
              url,
              is_default: form.isDefault,
            },
          ];
    });
    // The client's precedence (default form, default_bookform_url, first
    // form), restricted to https addresses.
    const formUrl =
      forms.find((form) => form.is_default)?.url ??
      httpsUrl(card.bookingFormUrl) ??
      forms[0]?.url ??
      null;
    const nextSlot =
      card.nextFreeSlot !== null &&
      SLOT_DATETIME_PATTERN.test(card.nextFreeSlot)
        ? card.nextFreeSlot
        : null;
    return {
      location_id: card.locationId,
      name: sanitizeUntrusted(card.name, { maxChars: NAME_MAX_CHARS }),
      category: sanitizeUntrusted(card.category),
      address: sanitizeUntrusted(card.address),
      city: sanitizeUntrusted(card.city),
      country: sanitizeUntrusted(card.country),
      phone: sanitizeUntrusted(card.phone),
      website: sanitizeUntrusted(card.website),
      time_zone: {
        name: sanitizeUntrusted(card.timeZoneName),
        utc_offset_hours: card.utcOffsetHours,
      },
      currency: sanitizeUntrusted(card.currency),
      online_booking: {
        enabled: card.widgetActive && formUrl !== null,
        widget_active: card.widgetActive,
        phone_confirmation: card.phoneConfirmation,
        any_team_member_allowed: card.anyTeamMemberAllowed,
        prepayment_policy: sanitizeUntrusted(card.paymentPolicyType),
        booking_form_url: formUrl,
        booking_forms: forms,
      },
      next_free_slot: nextSlot,
    };
  },
});

// List tools for the next booking steps (DISC-02, DISC-03): the services a
// client can book online and the team members who can be booked. Both read
// the whole upstream list and page it here, so pages keep the upstream order.
// Business text (titles, names, positions) is sanitised and capped, and the
// render keeps it inside the UNTRUSTED block; our own sentences carry only
// ids, numbers and fixed words.

/** Cap on business labels in list items (titles, names, categories), in code points. */
const LABEL_MAX_CHARS = 200;

const DATETIME_FILTER_DESCRIPTION =
  'Only those free at this time, in the format business_list_time_slots returns, for example 2026-10-05T14:00:00+03:00.';

const datetimeFilter = z
  .string()
  .regex(SLOT_DATETIME_PATTERN)
  .optional()
  .describe(DATETIME_FILTER_DESCRIPTION);

const locationIdInput = z
  .number()
  .int()
  .positive()
  .describe('Location id of the business.');

/** A 422 on a datetime filter means a time in the past (02-RESEARCH Pitfall 6). */
const CHOSEN_TIME_REJECTED: UpstreamErrorText = {
  message: 'The booking service rejected the chosen time.',
  nextAction:
    'choose a time in the future, for example one returned by business_list_time_slots.',
};

/** The chosen-time wording only when the call carried a datetime filter. */
function listErrorOverrides(
  hasDatetime: boolean,
  notFound: UpstreamErrorText
): UpstreamErrorOverrides {
  return hasDatetime
    ? { not_found: notFound, rejected: CHOSEN_TIME_REJECTED }
    : { not_found: notFound };
}

function pageLine(noun: string, pagination: Pagination): string {
  return `${noun}, page ${pagination.page}: ${pagination.returned} returned of ${pagination.total ?? 'unknown'} in total.`;
}

function moreLine(pagination: Pagination): string | null {
  return pagination.next_page === null
    ? null
    : `More: request page ${pagination.next_page}.`;
}

/** YYYY-MM-DD, the only date shape our own sentences may carry. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// business_list_services (DISC-02)

/**
 * The service-link prepayment status, worded so it never promises the final
 * terms: those also depend on the business and the team member, and the
 * widget shows them (02-RESEARCH Pitfall 8).
 */
const PREPAYMENT: Readonly<
  Record<PrepaidSlug, 'not_offered' | 'optional' | 'required'>
> = {
  forbidden: 'not_offered',
  allowed: 'optional',
  required: 'required',
};

const PREPAYMENT_TEXT = {
  not_offered: 'no online prepayment',
  optional: 'prepayment optional',
  required: 'prepayment required',
  unknown: 'prepayment unknown',
} as const;

const WIDGET_TERMS_NOTE =
  'The booking widget shows the final price and any prepayment terms.';

const serviceItemSchema = z.strictObject({
  id: z.number().int().describe('Service id.'),
  title: untrustedText('Service title.'),
  category: untrustedText('Category title, or null when none is set.'),
  price: z
    .strictObject({
      min: z.number().describe('Lowest price.'),
      max: z.number().describe('Highest price; equal to min for one price.'),
      currency: untrustedText('Currency of the business.'),
    })
    .nullable()
    .describe(
      'Price range as the business set it, or null when no price is set (price on request).'
    ),
  duration_minutes: z
    .number()
    .int()
    .nullable()
    .describe(
      'Duration in whole minutes with the chosen team member, or null without a team member filter.'
    ),
  prepayment: z
    .enum(['not_offered', 'optional', 'required', 'unknown'])
    .describe(
      'Online prepayment for this service: not_offered, optional, required or unknown. The booking widget shows the final terms.'
    ),
});

type ServiceItem = z.infer<typeof serviceItemSchema>;

const servicesOutput = listOutputSchema(serviceItemSchema);

const servicesInput = z.strictObject({
  location_id: locationIdInput,
  team_member_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Only services this team member provides.'),
  datetime: datetimeFilter,
  ...pageInputShape(),
});

function priceText(price: ServiceItem['price']): string {
  if (price === null) return 'price on request';
  return price.min === price.max
    ? `price ${price.min}`
    : `price ${price.min} to ${price.max}`;
}

function durationText(minutes: number | null): string {
  return minutes === null ? 'duration not given' : `${minutes} min`;
}

function renderServices(out: z.infer<typeof servicesOutput>): string {
  const { items, pagination } = out;
  if (pagination.total === 0) {
    return 'No service can be booked online at this business for this selection.';
  }
  const lines = [
    pageLine('Bookable services', pagination),
    ...items.map(
      (item) =>
        `- service ${item.id}: ${priceText(item.price)}, ${durationText(item.duration_minutes)}, ${PREPAYMENT_TEXT[item.prepayment]}.`
    ),
    'Prices are in the currency of the business.',
    WIDGET_TERMS_NOTE,
  ];
  const more = moreLine(pagination);
  if (more !== null) lines.push(more);

  const fields: Record<string, unknown> = {};
  const currency = items.find((item) => item.price !== null)?.price?.currency;
  if (currency !== undefined) fields.Currency = currency;
  for (const item of items) {
    fields[`service ${item.id}`] = item.title;
    fields[`category of service ${item.id}`] = item.category;
  }
  return withUntrustedBlock(lines.join('\n'), fields);
}

function toServiceItems(
  catalog: ServiceCatalog,
  currency: string | null
): ServiceItem[] {
  const categories = new Map(
    catalog.categories.map((category) => [category.id, category.title])
  );
  return catalog.services.map((service) => ({
    id: service.id,
    title: sanitizeUntrusted(service.title, { maxChars: LABEL_MAX_CHARS }),
    category:
      service.categoryId === null
        ? null
        : sanitizeUntrusted(categories.get(service.categoryId), {
            maxChars: LABEL_MAX_CHARS,
          }),
    // 0 and 0 is no price set: never shown as a price of 0 (Pitfall 7).
    price:
      service.priceMin === 0 && service.priceMax === 0
        ? null
        : { min: service.priceMin, max: service.priceMax, currency },
    duration_minutes:
      service.durationSeconds === null
        ? null
        : Math.round(service.durationSeconds / 60),
    prepayment:
      service.prepaid === null ? 'unknown' : PREPAYMENT[service.prepaid],
  }));
}

export const businessListServices = defineTool<
  typeof servicesInput,
  typeof servicesOutput,
  ToolDeps
>({
  name: 'business_list_services',
  title: 'List bookable services',
  description:
    'Lists the services of a business that can be booked online, with category, price range and currency, duration and whether online prepayment applies. The list can be limited to the services of one team member or to services free at a given time. Final prices and prepayment terms are shown in the booking widget.',
  annotations: UPSTREAM_READ_HINTS,
  kind: 'list',
  upstream: [BOOKING_ROUTES.company, BOOKING_ROUTES.services],
  input: servicesInput,
  output: servicesOutput,
  render: renderServices,
  handler: async ({ input, deps }) => {
    let card: BusinessCard;
    let catalog: ServiceCatalog;
    try {
      // The currency is on the card; both reads go through the shared gate.
      [card, catalog] = await Promise.all([
        deps.booking.company(input.location_id),
        deps.booking.services(input.location_id, {
          teamMemberId: input.team_member_id,
          datetime: input.datetime,
        }),
      ]);
    } catch (error) {
      throw toToolError(
        error,
        listErrorOverrides(input.datetime !== undefined, {
          message: 'No business or team member was found for these ids.',
          nextAction:
            'check the location id and the team member id; business_list_team_members returns the team member ids.',
        })
      );
    }
    const currency = sanitizeUntrusted(card.currency, {
      maxChars: LABEL_MAX_CHARS,
    });
    return paginateArray(toServiceItems(catalog, currency), input);
  },
});

// business_list_team_members (DISC-03)

const teamMemberItemSchema = z.strictObject({
  id: z.number().int().describe('Team member id.'),
  name: untrustedText('Team member name as the business shows it.'),
  position: untrustedText('Position title, or null when none is set.'),
  specialization: untrustedText('Specialization, or null when none is set.'),
  rating: z
    .number()
    .nullable()
    .describe(
      'Rating from client reviews, or null when the business does not show one.'
    ),
  next_free_date: z
    .string()
    .nullable()
    .describe('Next date with a free slot, YYYY-MM-DD, or null when unknown.'),
});

type TeamMemberItem = z.infer<typeof teamMemberItemSchema>;

const teamMembersOutput = listOutputSchema(teamMemberItemSchema);

const MAX_SERVICE_IDS = 10;

const teamMembersInput = z.strictObject({
  location_id: locationIdInput,
  service_ids: z
    .array(z.number().int().positive())
    .max(MAX_SERVICE_IDS)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'service ids must be unique',
    })
    .default([])
    .describe(
      `Only team members who provide these services, up to ${MAX_SERVICE_IDS} unique service ids.`
    ),
  datetime: datetimeFilter,
  ...pageInputShape(),
});

function ratingText(rating: number | null): string {
  return rating === null ? 'no rating shown' : `rating ${rating}`;
}

function renderTeamMembers(out: z.infer<typeof teamMembersOutput>): string {
  const { items, pagination } = out;
  if (pagination.total === 0) {
    return 'No team member can be booked for this selection.';
  }
  const lines = [
    pageLine('Bookable team members', pagination),
    ...items.map(
      (item) =>
        `- team member ${item.id}: ${ratingText(item.rating)}, next free date ${item.next_free_date ?? 'unknown'}.`
    ),
  ];
  const more = moreLine(pagination);
  if (more !== null) lines.push(more);

  const fields: Record<string, unknown> = {};
  for (const item of items) {
    fields[`team member ${item.id}`] = item.name;
    fields[`position of team member ${item.id}`] = item.position;
    fields[`specialization of team member ${item.id}`] = item.specialization;
  }
  return withUntrustedBlock(lines.join('\n'), fields);
}

function toTeamMemberItem(member: TeamMember): TeamMemberItem {
  return {
    id: member.id,
    name: sanitizeUntrusted(member.name, { maxChars: LABEL_MAX_CHARS }),
    position: sanitizeUntrusted(member.positionTitle, {
      maxChars: LABEL_MAX_CHARS,
    }),
    specialization: sanitizeUntrusted(member.specialization, {
      maxChars: LABEL_MAX_CHARS,
    }),
    rating: member.rating,
    // Our own sentence carries this date, so only the plain date shape passes.
    next_free_date:
      member.nextFreeDate !== null && DATE_PATTERN.test(member.nextFreeDate)
        ? member.nextFreeDate
        : null,
  };
}

export const businessListTeamMembers = defineTool<
  typeof teamMembersInput,
  typeof teamMembersOutput,
  ToolDeps
>({
  name: 'business_list_team_members',
  title: 'List bookable team members',
  description:
    'Lists the team members of a business who can be booked online, optionally only those who provide the chosen services or are free at a given time, with position, specialization and rating.',
  annotations: UPSTREAM_READ_HINTS,
  kind: 'list',
  upstream: [BOOKING_ROUTES.teamMembers],
  input: teamMembersInput,
  output: teamMembersOutput,
  render: renderTeamMembers,
  handler: async ({ input, deps }) => {
    let members: TeamMember[];
    try {
      members = await deps.booking.teamMembers(input.location_id, {
        serviceIds: input.service_ids,
        datetime: input.datetime,
      });
    } catch (error) {
      throw toToolError(
        error,
        listErrorOverrides(input.datetime !== undefined, {
          message: 'No business or service was found for these ids.',
          nextAction:
            'check the location id and the service ids; business_list_services returns the service ids.',
        })
      );
    }
    // DISC-03 lists bookable team members only; the HTML bio is never read.
    const bookable = members.filter((member) => member.bookable);
    return paginateArray(bookable.map(toTeamMemberItem), input);
  },
});

// Availability steps (DISC-04, DISC-05): the dates with free time, then the
// free slots of one date, for one team member or any team member (0). The
// slot datetime is passed through exactly as the API wrote it, because
// book_check verifies it and the widget applies a preselected time only when
// it equals a free slot exactly. Display times come from the datetime digits,
// never from the upstream G:i `time` and never through a Date conversion.
// Neither tool returns business-authored text, so the render needs no fence.

/** Widest date range business_list_dates asks for, in days (02-RESEARCH Pitfall 6). */
export const MAX_DATE_RANGE_DAYS = 62;

/** Day number of a YYYY-MM-DD date that exists in the calendar, else null. */
function calendarDayNumber(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const [, year, month, day] = match ?? [];
  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const date = new Date(ms);
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return ms / 86_400_000;
}

function calendarDate(description: string) {
  return z
    .string()
    .regex(DATE_PATTERN)
    .refine((value) => calendarDayNumber(value) !== null, {
      message: 'must be a date that exists in the calendar',
    })
    .describe(description);
}

const teamMemberOrAnyInput = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe('Team member id. 0 means any team member.');

function uniqueServiceIds(min: number, description: string) {
  return z
    .array(z.number().int().positive())
    .min(min)
    .max(MAX_SERVICE_IDS)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'service ids must be unique',
    })
    .describe(description);
}

function teamMemberText(teamMemberId: number): string {
  return teamMemberId === 0 ? 'any team member' : `team member ${teamMemberId}`;
}

// business_list_dates (DISC-04)

const dateItemSchema = z.strictObject({
  date: z.string().describe('A date with free time, YYYY-MM-DD.'),
});

const datesOutput = listOutputSchema(dateItemSchema).extend({
  date_from: z
    .string()
    .nullable()
    .describe(
      "First searched date, YYYY-MM-DD, or null for the business's booking window."
    ),
  date_to: z
    .string()
    .nullable()
    .describe(
      "Last searched date (inclusive), YYYY-MM-DD, or null for the business's booking window."
    ),
  team_member_id: z
    .number()
    .int()
    .describe('Team member searched for; 0 means any team member.'),
});

type DatesOutput = z.infer<typeof datesOutput>;

const datesInput = z
  .strictObject({
    location_id: locationIdInput,
    service_ids: uniqueServiceIds(
      0,
      `Services to book, up to ${MAX_SERVICE_IDS} unique service ids.`
    ).default([]),
    team_member_id: teamMemberOrAnyInput,
    date_from: calendarDate(
      `First date to search, YYYY-MM-DD. Give date_from and date_to together, at most ${MAX_DATE_RANGE_DAYS} days apart.`
    ).optional(),
    date_to: calendarDate(
      `Last date to search (inclusive), YYYY-MM-DD, not before date_from.`
    ).optional(),
    ...pageInputShape(),
  })
  .superRefine((input, ctx) => {
    const hasFrom = input.date_from !== undefined;
    const hasTo = input.date_to !== undefined;
    if (hasFrom !== hasTo) {
      ctx.addIssue({
        code: 'custom',
        path: [hasFrom ? 'date_to' : 'date_from'],
        message: 'date_from and date_to go together: give both or neither',
      });
      return;
    }
    if (input.date_from === undefined || input.date_to === undefined) return;
    const from = calendarDayNumber(input.date_from);
    const to = calendarDayNumber(input.date_to);
    // Field checks report a date that does not exist.
    if (from === null || to === null) return;
    if (to < from) {
      ctx.addIssue({
        code: 'custom',
        path: ['date_to'],
        message: 'date_to must not be before date_from',
      });
    } else if (to - from > MAX_DATE_RANGE_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['date_to'],
        message: `date_to must be at most ${MAX_DATE_RANGE_DAYS} days after date_from`,
      });
    }
  });

function searchedRange(out: DatesOutput): string {
  return out.date_from === null || out.date_to === null
    ? "in the business's booking window"
    : `from ${out.date_from} to ${out.date_to}`;
}

function renderDates(out: DatesOutput): string {
  const { items, pagination } = out;
  const who = teamMemberText(out.team_member_id);
  if (pagination.total === 0) {
    return `No date has free time ${searchedRange(out)} for this selection of services and ${who}.`;
  }
  const lines = [
    pageLine(`Dates with free time for ${who}`, pagination),
    ...items.map((item) => `- ${item.date}`),
    `Searched ${searchedRange(out)}.`,
  ];
  const more = moreLine(pagination);
  if (more !== null) lines.push(more);
  return lines.join('\n');
}

export const businessListDates = defineTool<
  typeof datesInput,
  typeof datesOutput,
  ToolDeps
>({
  name: 'business_list_dates',
  title: 'List dates with free time',
  description:
    "Lists the dates on which a business has free time for the chosen services, for one team member or any team member, within a date range of up to 62 days. Without a range the business's own booking window is used.",
  annotations: UPSTREAM_READ_HINTS,
  kind: 'list',
  upstream: [BOOKING_ROUTES.dates],
  input: datesInput,
  output: datesOutput,
  render: renderDates,
  handler: async ({ input, deps }) => {
    let dates: string[];
    try {
      dates = await deps.booking.dates(input.location_id, {
        serviceIds: input.service_ids,
        teamMemberId: input.team_member_id,
        dateFrom: input.date_from,
        dateTo: input.date_to,
      });
    } catch (error) {
      throw toToolError(error, {
        not_found: {
          message:
            'No business, team member or service was found for these ids.',
          nextAction:
            'check the location id, the team member id and the service ids; business_list_services and business_list_team_members return them.',
        },
        rejected: {
          message: 'The booking service rejected the chosen dates.',
          nextAction: `choose dates from today on, at most ${MAX_DATE_RANGE_DAYS} days apart.`,
        },
      });
    }
    // Ascending and without duplicates; YYYY-MM-DD sorts as text.
    const unique = [...new Set(dates)].sort();
    return {
      ...paginateArray(
        unique.map((date) => ({ date })),
        input
      ),
      date_from: input.date_from ?? null,
      date_to: input.date_to ?? null,
      team_member_id: input.team_member_id,
    };
  },
});

// business_list_time_slots (DISC-05)

const slotItemSchema = z.strictObject({
  time: z.string().describe("Start time, HH:MM, in the business's local time."),
  datetime: z
    .string()
    .describe(
      'Start as an ISO 8601 datetime with UTC offset, exactly as the booking service returned it; book_check takes this value unchanged.'
    ),
  duration_minutes: z
    .number()
    .int()
    .nullable()
    .describe('Duration in whole minutes, or null when not given.'),
  utc_offset: z
    .string()
    .describe("UTC offset of this slot's local time, for example +03:00."),
});

type SlotItem = z.infer<typeof slotItemSchema>;

const timeSlotsOutput = z.strictObject({
  items: z.array(slotItemSchema),
  pagination: paginationSchema,
  date: z.string().describe('The searched date, YYYY-MM-DD.'),
  team_member_id: z
    .number()
    .int()
    .describe('Team member searched for; 0 means any team member.'),
});

type TimeSlotsOutput = z.infer<typeof timeSlotsOutput>;

const timeSlotsInput = z.strictObject({
  location_id: locationIdInput,
  service_ids: uniqueServiceIds(
    1,
    `Services to book, 1 to ${MAX_SERVICE_IDS} unique service ids.`
  ),
  team_member_id: teamMemberOrAnyInput,
  date: calendarDate('Date to list, YYYY-MM-DD.'),
  ...pageInputShape(),
});

/** A slot with the instant it denotes, for sorting only. */
interface DatedSlot {
  item: SlotItem;
  instantMs: number;
}

function toDatedSlot(slot: TimeSlot): DatedSlot | null {
  const parts = parseSlotDatetime(slot.datetime);
  if (parts === null) return null;
  // Local digits minus the offset: the instant, without a Date parse.
  const localMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return {
    item: {
      time: `${parts.hour}:${parts.minute}`,
      datetime: slot.datetime,
      duration_minutes:
        slot.durationSeconds === null
          ? null
          : Math.round(slot.durationSeconds / 60),
      utc_offset: formatUtcOffset(parts.offsetMinutes),
    },
    instantMs: localMs - parts.offsetMinutes * 60_000,
  };
}

/** Merged by identical datetime string, sorted by instant; ties keep upstream order. */
function toSlotItems(slots: readonly TimeSlot[]): SlotItem[] {
  const seen = new Set<string>();
  const dated: DatedSlot[] = [];
  for (const slot of slots) {
    if (seen.has(slot.datetime)) continue;
    seen.add(slot.datetime);
    const entry = toDatedSlot(slot);
    if (entry !== null) dated.push(entry);
  }
  // Array.prototype.sort is stable, so equal instants keep upstream order.
  dated.sort((a, b) => a.instantMs - b.instantMs);
  return dated.map((entry) => entry.item);
}

function offsetsLine(items: readonly SlotItem[]): string {
  const offsets = [...new Set(items.map((item) => item.utc_offset))];
  return offsets.length === 1
    ? `Times are the business's local times (UTC${offsets[0] ?? ''}).`
    : `Times are the business's local times; the UTC offset differs between slots (${offsets.map((offset) => `UTC${offset}`).join(', ')}).`;
}

function renderTimeSlots(out: TimeSlotsOutput): string {
  const { items, pagination } = out;
  if (pagination.total === 0) {
    return `No free time on ${out.date} for this selection of services and team member.`;
  }
  const lines = [
    pageLine(
      `Free time slots on ${out.date} for ${teamMemberText(out.team_member_id)}`,
      pagination
    ),
    ...items.map(
      (item) =>
        `- ${item.time}, ${durationText(item.duration_minutes)}: ${item.datetime}`
    ),
  ];
  if (items.length > 0) lines.push(offsetsLine(items));
  const more = moreLine(pagination);
  if (more !== null) lines.push(more);
  return lines.join('\n');
}

export const businessListTimeSlots = defineTool<
  typeof timeSlotsInput,
  typeof timeSlotsOutput,
  ToolDeps
>({
  name: 'business_list_time_slots',
  title: 'List free time slots',
  description:
    "Lists the free time slots of a business on one date for the chosen services and one team member or any team member. Each slot carries the exact datetime that book_check takes, in the business's local time with its UTC offset.",
  annotations: UPSTREAM_READ_HINTS,
  kind: 'list',
  upstream: [BOOKING_ROUTES.timeSlots],
  input: timeSlotsInput,
  output: timeSlotsOutput,
  render: renderTimeSlots,
  handler: async ({ input, deps }) => {
    let slots: TimeSlot[];
    try {
      slots = await deps.booking.timeSlots(
        input.location_id,
        input.team_member_id,
        input.date,
        input.service_ids
      );
    } catch (error) {
      throw toToolError(error, {
        not_found: {
          message:
            'No business, team member or service was found for these ids.',
          nextAction:
            'check the location id, the team member id and the service ids; business_list_services and business_list_team_members return them.',
        },
        rejected: {
          message: 'The booking service rejected the chosen date.',
          nextAction:
            'choose a date from today on, for example one returned by business_list_dates.',
        },
      });
    }
    return {
      ...paginateArray(toSlotItems(slots), input),
      date: input.date,
      team_member_id: input.team_member_id,
    };
  },
});
