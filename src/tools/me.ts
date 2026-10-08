import { z } from 'zod';
import {
  USER_ROUTES,
  type OwnPlace,
  type OwnRecord,
} from '../booking/client.js';
import { UpstreamError } from '../booking/errors.js';
import { userCall, type ToolContext } from './context.js';
import { defineTool } from './factory.js';
import {
  NAME_MAX_CHARS,
  UPSTREAM_READ_HINTS,
  untrustedText,
} from './business.js';
import {
  listOutputSchema,
  pageInputShape,
  paginateArray,
  type Pagination,
} from './pagination.js';
import type { ToolDeps } from './registry.js';
import { SCOPE_READ } from './scopes.js';
import { toToolError } from './upstream-errors.js';
import {
  UNTRUSTED_NOTE,
  sanitizeUntrusted,
  withUntrustedBlock,
} from './untrusted.js';
import {
  bookingStatus,
  orderBookings,
  usualByLocation,
  type Usual,
} from './usual.js';

// Tools for the signed-in client's own data (ADR 0005, D-02). They read the
// client's places and, in a later plan, bookings through the user token the
// caller check admitted; the location_id they return is the one the business
// tools take. "Business" is the user-facing term (D-07).

const placeItemSchema = z.strictObject({
  location_id: z
    .number()
    .int()
    .describe('Location id of the business, as the business tools take it.'),
  name: untrustedText('Business name.'),
  address: untrustedText('Street address.'),
  city: untrustedText('City, when the places route gives one.'),
  logo_url: z
    .string()
    .nullable()
    .describe('Address of the business logo (https), or null.'),
  online_booking: z
    .boolean()
    .describe('Whether online booking is on for this business.'),
  last_visit: z
    .string()
    .nullable()
    .describe(
      'Date of the last kept visit as YYYY-MM-DD, taken from the own bookings, or null when there is none or the bookings could not be read.'
    ),
  usual: z
    .strictObject({
      service_ids: z
        .array(z.number().int())
        .describe(
          'Service ids of the last kept visit, for business_list_dates.'
        ),
      service_titles: z
        .array(z.string().nullable())
        .describe(`Titles of those services. ${UNTRUSTED_NOTE}`),
      team_member_id: z
        .number()
        .int()
        .describe(
          'Team member of the last kept visit; 0 means any team member.'
        ),
      team_member_name: untrustedText('Team member name.'),
      last_booked: z.string().describe('Date of that visit, YYYY-MM-DD.'),
    })
    .nullable()
    .describe(
      'The usual service and team member at this place, from the last visit that was not cancelled; null when there is none yet or the bookings could not be read.'
    ),
});

type PlaceItem = z.infer<typeof placeItemSchema>;

const placesOutput = listOutputSchema(placeItemSchema).extend({
  usual_available: z
    .boolean()
    .describe(
      'False when the own bookings could not be read just now, so every usual is null for that reason.'
    ),
});

const placesInput = z.strictObject(pageInputShape());

function toPlaceItem(
  place: OwnPlace,
  usual: Usual | undefined,
  city: string | null
): PlaceItem {
  return {
    location_id: place.locationId,
    name: sanitizeUntrusted(place.name, { maxChars: NAME_MAX_CHARS }),
    address: sanitizeUntrusted(place.address),
    city: sanitizeUntrusted(place.city ?? city),
    logo_url: place.logoUrl,
    online_booking: place.onlineBooking,
    last_visit: place.lastVisit ?? usual?.date ?? null,
    usual:
      usual === undefined
        ? null
        : {
            service_ids: usual.serviceIds,
            service_titles: usual.serviceTitles.map((title) =>
              sanitizeUntrusted(title, { maxChars: NAME_MAX_CHARS })
            ),
            team_member_id: usual.teamMemberId,
            team_member_name: sanitizeUntrusted(usual.teamMemberName, {
              maxChars: NAME_MAX_CHARS,
            }),
            last_booked: usual.date,
          },
  };
}

/** The city text of each place, from the latest record that has one. */
function cityByLocation(records: readonly OwnRecord[]): Map<number, string> {
  const cities = new Map<number, string>();
  for (const record of records) {
    if (record.city !== null) cities.set(record.locationId, record.city);
  }
  return cities;
}

function placesPageLine(pagination: Pagination): string {
  return `Your places, page ${pagination.page}: ${pagination.returned} returned of ${pagination.total ?? 'unknown'} in total.`;
}

function renderPlaces(out: z.infer<typeof placesOutput>): string {
  const { items, pagination } = out;
  if (pagination.total === 0) {
    return 'No own places were found for this sign-in: the list holds businesses where the client already has bookings and that take bookings through Altegio.me.';
  }
  const lines = [
    placesPageLine(pagination),
    ...items.map(
      (item) =>
        `- location ${item.location_id}: online booking ${item.online_booking ? 'on' : 'off'}, last visit ${item.last_visit ?? 'not known'}, usual service ${item.usual === null ? 'not known' : 'listed below'}.`
    ),
    'Next: pass a location_id to business_get or business_list_services to look at that business.',
  ];
  if (items.some((item) => item.usual !== null)) {
    lines.push(
      'Next: to book a usual again, pass its location_id, service_ids and team_member_id to business_list_dates.'
    );
  }
  if (!out.usual_available) {
    lines.push(
      'The usual service is unknown right now because the own bookings could not be read; call me_list_places again later.'
    );
  }
  if (pagination.next_page !== null) {
    lines.push(`More: request page ${pagination.next_page}.`);
  }

  const fields: Record<string, unknown> = {};
  for (const item of items) {
    fields[`name of location ${item.location_id}`] = item.name;
    fields[`address of location ${item.location_id}`] = item.address;
    fields[`city of location ${item.location_id}`] = item.city;
    if (item.usual !== null) {
      fields[`Usual at location ${item.location_id}`] =
        `${servicesPhrase(item.usual.service_ids, item.usual.service_titles)} with ${teamMemberPhrase(item.usual.team_member_id, item.usual.team_member_name)}, last booked ${item.usual.last_booked}`;
    }
  }
  return withUntrustedBlock(lines.join('\n'), fields);
}

export const meListPlaces = defineTool<
  typeof placesInput,
  typeof placesOutput,
  ToolDeps
>({
  name: 'me_list_places',
  title: 'List my places',
  description:
    "Lists the signed-in client's own places: businesses where the client already has bookings and that take bookings through Altegio.me. Each place has the location_id the business tools take, whether online booking is on, the last visit and the usual service and team member from the client's own earlier bookings when known. Needs the client's sign-in. The places and bookings routes are undocumented, so some fields can be empty.",
  kind: 'list',
  scopes: [SCOPE_READ],
  annotations: UPSTREAM_READ_HINTS,
  upstream: [USER_ROUTES.places, USER_ROUTES.records],
  input: placesInput,
  output: placesOutput,
  render: renderPlaces,
  handler: async ({ input, deps, ctx }) => {
    try {
      const call = userCall(ctx);
      const places = await deps.booking.myPlaces(call);
      const records = await readRecordsForUsual(deps, call, ctx);
      const usual =
        records === null
          ? new Map<number, Usual>()
          : usualByLocation(records, Date.now());
      const cities =
        records === null ? new Map<number, string>() : cityByLocation(records);
      return {
        ...paginateArray(
          places.map((place) =>
            toPlaceItem(
              place,
              usual.get(place.locationId),
              cities.get(place.locationId) ?? null
            )
          ),
          input
        ),
        usual_available: records !== null,
      };
    } catch (error) {
      // Every upstream failure becomes an in-band error that names the next action.
      throw toToolError(error);
    }
  },
});

/**
 * The records the usual comes from. A failure that says nothing about the
 * sign-in leaves the places useful on their own, so it gives null (no usual);
 * a refused sign-in and a call that was dropped or timed out still fail.
 */
async function readRecordsForUsual(
  deps: ToolDeps,
  call: ReturnType<typeof userCall>,
  ctx: ToolContext
): Promise<OwnRecord[] | null> {
  try {
    return await deps.booking.myRecords(call);
  } catch (error) {
    if (
      ctx.signal.aborted ||
      (error instanceof UpstreamError && error.kind === 'unauthorized')
    ) {
      throw error;
    }
    return null;
  }
}

// me_list_bookings (ME-03, D-02): the client's own records, ordered, with the
// usual service and team member per place (D-03). A record's own id is the
// booking id the write tools take (ADR 0006); its hash and token, and any
// client name, phone or e-mail, are never read, so none can be returned
// (ME-05); the strict schemas below make that a property of the output.

const BOOKING_STATUSES = [
  'upcoming',
  'visited',
  'no_show',
  'cancelled',
  'past',
] as const;

export const bookingItemSchema = z.strictObject({
  booking_id: z
    .number()
    .int()
    .describe('Id of the booking, as the booking tools take it.'),
  location_id: z
    .number()
    .int()
    .describe('Location id of the business, as the business tools take it.'),
  business: untrustedText('Business name.'),
  services: z
    .array(
      z.strictObject({
        id: z.number().int().describe('Service id.'),
        title: untrustedText('Service title.'),
        price: z
          .number()
          .nullable()
          .describe('Price of the service line, or null when not known.'),
      })
    )
    .describe('The booked services; empty when the record lists none.'),
  team_member: z
    .strictObject({
      id: z.number().int().describe('Team member id.'),
      name: untrustedText('Team member name.'),
    })
    .nullable()
    .describe('The team member, or null when the record has none.'),
  datetime: z
    .string()
    .describe(
      "Start of the booking as the booking service recorded it: ISO 8601 with the business's UTC offset, for example 2026-10-12T14:00:00+0300."
    ),
  status: z
    .enum(BOOKING_STATUSES)
    .describe(
      'upcoming: still ahead. visited or no_show: past, by the recorded attendance (inferred, not documented). cancelled: cancelled by either side. past: past with no attendance recorded.'
    ),
  price: z
    .number()
    .nullable()
    .describe(
      'Sum of the service prices, or null when any is not known or the record has no service.'
    ),
  currency: untrustedText('Currency sign of the business.'),
});

export type BookingItem = z.infer<typeof bookingItemSchema>;

const usualItemSchema = z.strictObject({
  location_id: z
    .number()
    .int()
    .describe('Location id of the business, as the business tools take it.'),
  business: untrustedText('Business name.'),
  service_ids: z
    .array(z.number().int())
    .describe('Service ids of the last kept visit, for business_list_dates.'),
  service_titles: z
    .array(z.string().nullable())
    .describe(`Titles of those services. ${UNTRUSTED_NOTE}`),
  team_member_id: z
    .number()
    .int()
    .describe('Team member of the last kept visit; 0 means any team member.'),
  team_member_name: untrustedText('Team member name.'),
  last_booked: z.string().describe('Date of that visit, YYYY-MM-DD.'),
});

type UsualItem = z.infer<typeof usualItemSchema>;

const bookingsOutput = listOutputSchema(bookingItemSchema).extend({
  usual: z
    .array(usualItemSchema)
    .describe(
      'The usual service and team member of every place with an earlier kept visit, most recent first; it covers all places, not only this page.'
    ),
});

type BookingsOutput = z.infer<typeof bookingsOutput>;

const bookingsInput = z.strictObject(pageInputShape());

export function toBookingItem(record: OwnRecord, nowMs: number): BookingItem {
  return {
    booking_id: record.id,
    location_id: record.locationId,
    business: sanitizeUntrusted(record.businessName, {
      maxChars: NAME_MAX_CHARS,
    }),
    services: record.services.map((service) => ({
      id: service.id,
      title: sanitizeUntrusted(service.title, { maxChars: NAME_MAX_CHARS }),
      price: service.price,
    })),
    team_member:
      record.teamMember === null
        ? null
        : {
            id: record.teamMember.id,
            name: sanitizeUntrusted(record.teamMember.name, {
              maxChars: NAME_MAX_CHARS,
            }),
          },
    datetime: record.datetime,
    status: bookingStatus(record, nowMs),
    price: record.price,
    currency: sanitizeUntrusted(record.currency, { maxChars: 20 }),
  };
}

function toUsualItem(locationId: number, usual: Usual): UsualItem {
  return {
    location_id: locationId,
    business: sanitizeUntrusted(usual.businessName, {
      maxChars: NAME_MAX_CHARS,
    }),
    service_ids: usual.serviceIds,
    service_titles: usual.serviceTitles.map((title) =>
      sanitizeUntrusted(title, { maxChars: NAME_MAX_CHARS })
    ),
    team_member_id: usual.teamMemberId,
    team_member_name: sanitizeUntrusted(usual.teamMemberName, {
      maxChars: NAME_MAX_CHARS,
    }),
    last_booked: usual.date,
  };
}

/** The usual of every place, the most recently visited first. */
function usualItems(usual: ReadonlyMap<number, Usual>): UsualItem[] {
  return [...usual]
    .sort(([idA, a], [idB, b]) => b.date.localeCompare(a.date) || idA - idB)
    .map(([locationId, entry]) => toUsualItem(locationId, entry));
}

function teamMemberPhrase(id: number, name: string | null): string {
  return id === 0
    ? 'any team member (team_member_id 0)'
    : `${name ?? 'a team member'} (team_member_id ${id})`;
}

function servicesPhrase(
  ids: readonly number[],
  titles: readonly (string | null)[]
): string {
  return ids
    .map((id, index) => `${titles[index] ?? 'a service'} (service_id ${id})`)
    .join(', ');
}

export function bookingBlockValue(item: BookingItem): string {
  const price =
    item.price === null ? '' : `, price ${item.price} ${item.currency ?? ''}`;
  const member =
    item.team_member === null
      ? 'any team member'
      : (item.team_member.name ?? 'a team member');
  return `${item.business ?? 'a business'}: ${
    item.services.length === 0
      ? 'no service listed'
      : item.services.map((service) => service.title ?? 'a service').join(', ')
  } with ${member}${price}`.trimEnd();
}

function renderBookings(out: BookingsOutput): string {
  const { items, pagination } = out;
  if (pagination.total === 0) {
    return 'No bookings were found for this sign-in.';
  }
  const first = (pagination.page - 1) * pagination.page_size;
  const numbered = items.map((item, index) => ({
    item,
    number: first + index + 1,
  }));
  const line = ({ item, number }: (typeof numbered)[number]): string =>
    `${number}. booking ${item.booking_id}, location ${item.location_id}, ${item.datetime}, ${item.status}.`;
  const upcoming = numbered.filter(({ item }) => item.status === 'upcoming');
  const past = numbered.filter(({ item }) => item.status !== 'upcoming');

  const lines = [
    `Your bookings, page ${pagination.page}: ${pagination.returned} returned of ${pagination.total ?? 'unknown'} in total.`,
  ];
  if (upcoming.length > 0) lines.push('Upcoming:', ...upcoming.map(line));
  if (past.length > 0) lines.push('Past:', ...past.map(line));
  if (out.usual.length > 0) {
    lines.push(
      `A usual service and team member is listed for ${out.usual.length} of these places (Usual lines below).`,
      'Next: to book a usual again, pass its location_id, service_ids and team_member_id to business_list_dates.'
    );
  }
  if (pagination.next_page !== null) {
    lines.push(`More: request page ${pagination.next_page}.`);
  }

  const fields: Record<string, unknown> = {};
  for (const entry of numbered) {
    fields[`Booking ${entry.number}`] = bookingBlockValue(entry.item);
  }
  for (const usual of out.usual) {
    fields[`Usual at location ${usual.location_id}`] =
      `${usual.business ?? 'a business'}: ${servicesPhrase(usual.service_ids, usual.service_titles)} with ${teamMemberPhrase(usual.team_member_id, usual.team_member_name)}, last booked ${usual.last_booked}`;
  }
  return withUntrustedBlock(lines.join('\n'), fields);
}

export const meListBookings = defineTool<
  typeof bookingsInput,
  typeof bookingsOutput,
  ToolDeps
>({
  name: 'me_list_bookings',
  title: 'List my bookings',
  description:
    "Lists the signed-in client's own bookings, upcoming first, then past ones with the latest first, each with the business, services, team member, time, status and price, and the usual service and team member per place. Each booking's booking_id is the id me_reschedule_booking and me_cancel_booking take. Needs the client's sign-in. The records route is undocumented, so some fields can be empty.",
  kind: 'list',
  scopes: [SCOPE_READ],
  annotations: UPSTREAM_READ_HINTS,
  upstream: [USER_ROUTES.records],
  input: bookingsInput,
  output: bookingsOutput,
  render: renderBookings,
  handler: async ({ input, deps, ctx }) => {
    try {
      const records = await deps.booking.myRecords(userCall(ctx));
      const now = Date.now();
      const items = orderBookings(records, now).map((record) =>
        toBookingItem(record, now)
      );
      return {
        ...paginateArray(items, input),
        usual: usualItems(usualByLocation(records, now)),
      };
    } catch (error) {
      throw toToolError(error);
    }
  },
});
