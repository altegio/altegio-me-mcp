import { z } from 'zod';
import { BOOKING_ROUTES, type BusinessCard } from '../booking/client.js';
import { SLOT_DATETIME_PATTERN } from '../booking/deep-link.js';
import { defineTool, type ToolHints } from './factory.js';
import { listOutputSchema } from './pagination.js';
import type { ToolDeps } from './registry.js';
import { toToolError } from './upstream-errors.js';
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

// Contract stubs until GREEN: not registered, every call fails.
const stubInput = z.strictObject({ location_id: z.number() }).loose();
const stubOutput = listOutputSchema(z.strictObject({ id: z.number() }));

export const businessListServices = defineTool<
  typeof stubInput,
  typeof stubOutput,
  ToolDeps
>({
  name: 'business_list_services',
  title: 'List bookable services',
  description: 'Not implemented yet.',
  annotations: UPSTREAM_READ_HINTS,
  kind: 'list',
  input: stubInput,
  output: stubOutput,
  render: () => '',
  handler: () => Promise.reject(new Error('not implemented')),
});

export const businessListTeamMembers = defineTool<
  typeof stubInput,
  typeof stubOutput,
  ToolDeps
>({
  name: 'business_list_team_members',
  title: 'List bookable team members',
  description: 'Not implemented yet.',
  annotations: UPSTREAM_READ_HINTS,
  kind: 'list',
  input: stubInput,
  output: stubOutput,
  render: () => '',
  handler: () => Promise.reject(new Error('not implemented')),
});
