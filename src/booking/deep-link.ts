// Booking widget deep link (BOOK-02, BOOK-05). Pure, no I/O.
// RED stub: the contract types and constants are final; the functions are not
// implemented yet.

export const SLOT_DATETIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

export const ALLOWED_FORM_HOST_SUFFIXES: readonly string[] = [
  'alteg.io',
  'altegio.asia',
  'altegio.org',
];

export const FALLBACK_BOOKING_ORIGIN = 'https://app.alteg.io';

export interface SlotParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  offsetMinutes: number;
}

export type LinkFallbackReason =
  | 'no_form_url'
  | 'host_not_allowed'
  | 'no_services'
  | 'bad_datetime'
  | 'fractional_offset'
  | 'offset_unknown'
  | 'offset_mismatch'
  | 'any_team_member_disabled';

export interface BookingLinkInput {
  locationId: number;
  formUrl: string | null;
  teamMemberId: number;
  serviceIds: readonly number[];
  slotDatetime: string;
  businessUtcOffsetHours: number | null;
  anyTeamMemberAllowed: boolean;
}

export interface BookingLink {
  kind: 'preselected' | 'booking_form';
  url: string;
  reason: LinkFallbackReason | null;
}

export function parseSlotDatetime(_value: string): SlotParts | null {
  return null;
}

export function formatUtcOffset(_offsetMinutes: number): string {
  return '';
}

export function buildBookingLink(input: BookingLinkInput): BookingLink {
  return {
    kind: 'booking_form',
    url: `${FALLBACK_BOOKING_ORIGIN}/book/${input.locationId}`,
    reason: 'no_form_url',
  };
}
