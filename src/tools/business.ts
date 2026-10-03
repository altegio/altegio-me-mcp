import { z } from 'zod';
import { BOOKING_ROUTES } from '../booking/client.js';
import { SLOT_DATETIME_PATTERN } from '../booking/deep-link.js';
import { defineTool, type ToolHints } from './factory.js';
import type { ToolDeps } from './registry.js';
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

function renderOffset(hours: number | null): string {
  if (hours === null) return 'unknown';
  return `${hours >= 0 ? '+' : ''}${hours} hours`;
}

function renderCard(out: BusinessCardOutput): string {
  const booking = out.online_booking;
  const defaultForm = booking.booking_forms.find((form) => form.is_default);
  const summary = [
    `Business card for location ${out.location_id}.`,
    `Online booking: ${booking.enabled ? 'enabled' : 'not enabled'}.`,
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
    const card = await deps.booking.company(input.location_id);
    const forms = card.bookingForms.flatMap((form) => {
      const url = sanitizeUntrusted(form.url);
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
    const formUrl = sanitizeUntrusted(card.bookingFormUrl);
    const nextSlot =
      card.nextFreeSlot !== null &&
      SLOT_DATETIME_PATTERN.test(card.nextFreeSlot)
        ? card.nextFreeSlot
        : null;
    return {
      location_id: card.locationId,
      name: sanitizeUntrusted(card.name),
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
