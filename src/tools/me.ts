import { z } from 'zod';
import { USER_ROUTES, type OwnPlace } from '../booking/client.js';
import { userCall } from './context.js';
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
import { toToolError } from './upstream-errors.js';
import { sanitizeUntrusted, withUntrustedBlock } from './untrusted.js';

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
      'Date of the last visit as YYYY-MM-DD, or null when the places route does not give it.'
    ),
});

type PlaceItem = z.infer<typeof placeItemSchema>;

const placesOutput = listOutputSchema(placeItemSchema);

const placesInput = z.strictObject(pageInputShape());

function toPlaceItem(place: OwnPlace): PlaceItem {
  return {
    location_id: place.locationId,
    name: sanitizeUntrusted(place.name, { maxChars: NAME_MAX_CHARS }),
    address: sanitizeUntrusted(place.address),
    city: sanitizeUntrusted(place.city),
    logo_url: place.logoUrl,
    online_booking: place.onlineBooking,
    last_visit: place.lastVisit,
  };
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
        `- location ${item.location_id}: online booking ${item.online_booking ? 'on' : 'off'}, last visit ${item.last_visit ?? 'not given'}.`
    ),
    'Next: pass a location_id to business_get or business_list_services to look at that business.',
  ];
  if (pagination.next_page !== null) {
    lines.push(`More: request page ${pagination.next_page}.`);
  }

  const fields: Record<string, unknown> = {};
  for (const item of items) {
    fields[`name of location ${item.location_id}`] = item.name;
    fields[`address of location ${item.location_id}`] = item.address;
    fields[`city of location ${item.location_id}`] = item.city;
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
    "Lists the signed-in client's own places: businesses where the client already has bookings and that take bookings through Altegio.me. Each place has the location_id the business tools take, whether online booking is on, and the last visit when known. Needs the client's sign-in. The places route is undocumented, so some fields can be empty.",
  kind: 'list',
  annotations: UPSTREAM_READ_HINTS,
  upstream: [USER_ROUTES.places],
  input: placesInput,
  output: placesOutput,
  render: renderPlaces,
  handler: async ({ input, deps, ctx }) => {
    try {
      const places = await deps.booking.myPlaces(userCall(ctx));
      return paginateArray(places.map(toPlaceItem), input);
    } catch (error) {
      // Every upstream failure becomes an in-band error that names the next action.
      throw toToolError(error);
    }
  },
});
