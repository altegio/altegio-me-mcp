import { z } from 'zod';
import { BOOKING_ROUTES } from '../booking/client.js';
import {
  SLOT_DATETIME_PATTERN,
  parseSlotDatetime,
} from '../booking/deep-link.js';
import {
  MAX_SERVICE_IDS,
  locationIdInput,
  teamMemberOrAnyInput,
  uniqueServiceIds,
  untrustedText,
} from './business.js';
import { defineTool } from './factory.js';
import type { ToolDeps } from './registry.js';

// RED stub of book_check: final names, schemas and constants; the handler is
// written in the GREEN step.

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

const selectedServiceSchema = z.strictObject({
  id: z.number().int().describe('Service id.'),
  title: untrustedText('Service title, or null when it could not be loaded.'),
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
  // read-only although its first call is a POST (plan 02-09 confirms live).
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
  render: () => '',
  handler: () => Promise.reject(new Error('book_check is not implemented yet')),
});
