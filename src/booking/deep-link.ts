// Booking widget deep link (BOOK-02, BOOK-05, D-05, D-06). Pure: no I/O and
// no clock. The grammar comes from our reading of the widget code
// (docs/research/widget-deep-link.md):
//
//   {form origin}/company/{location}?o=m{staff}s{service}[s{service}...]d{YYDDMMHHmm}
//
// Staff first (the staff regex could otherwise match the m inside a later
// sub-service token), services concatenated (the comma form is deprecated),
// m-1 for any team member, and the time token is the business's wall clock
// with the day before the month. The widget applies the time only when it
// equals a free slot's datetime exactly, so the token is copied from the
// digits of the slot string as the API returned it and never recomputed
// through a JavaScript date object or converted to UTC.

import { isCalendarDay } from './calendar.js';

/** The slot datetime shape `book_times` returns (milliseconds optional, offset with or without a colon). */
export const SLOT_DATETIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** Booking-form hosts a link may point at: the suffix itself or any subdomain of it. */
export const ALLOWED_FORM_HOST_SUFFIXES: readonly string[] = [
  'alteg.io',
  'altegio.asia',
  'altegio.org',
];

/** Plain booking link when the card has no usable form URL: `/book/{location}` redirects to the default form. */
export const FALLBACK_BOOKING_ORIGIN = 'https://app.alteg.io';

/** A slot datetime split into the digit strings exactly as written. */
export interface SlotParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  /** Z = 0, '+03:00' or '+0300' = 180, '-05:30' = -330. */
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
  /** The business's booking-form URL from the card (`showBookforms=1`). */
  formUrl: string | null;
  /** 0 = any team member. */
  teamMemberId: number;
  /** In the client's order. */
  serviceIds: readonly number[];
  /** The slot's datetime exactly as the API returned it. */
  slotDatetime: string;
  /** Card `timezone`, in hours; may be fractional. */
  businessUtcOffsetHours: number | null;
  /** Card `show_any_master`. */
  anyTeamMemberAllowed: boolean;
}

export interface BookingLink {
  kind: 'preselected' | 'booking_form';
  url: string;
  reason: LinkFallbackReason | null;
}

const MAX_OFFSET_HOURS = 14;

function inRange(digits: string, min: number, max: number): boolean {
  const value = Number(digits);
  return value >= min && value <= max;
}

function parseOffset(text: string): number | null {
  if (text === 'Z') return 0;
  const sign = text.startsWith('-') ? -1 : 1;
  const digits = text.slice(1).replace(':', '');
  const hours = digits.slice(0, 2);
  const minutes = digits.slice(2);
  if (!inRange(hours, 0, MAX_OFFSET_HOURS) || !inRange(minutes, 0, 59)) {
    return null;
  }
  return sign * (Number(hours) * 60 + Number(minutes));
}

/** Splits a slot datetime into its digit strings; null on a pattern or range failure. */
export function parseSlotDatetime(value: string): SlotParts | null {
  const match = SLOT_DATETIME_PATTERN.exec(value);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, offset] = match;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    offset === undefined
  ) {
    return null;
  }
  if (
    !inRange(month, 1, 12) ||
    !inRange(day, 1, 31) ||
    !inRange(hour, 0, 23) ||
    !inRange(minute, 0, 59) ||
    !inRange(second, 0, 59)
  ) {
    return null;
  }
  // The range checks above allow 31 for every month; the day must exist.
  if (!isCalendarDay(Number(year), Number(month), Number(day))) return null;
  const offsetMinutes = parseOffset(offset);
  if (offsetMinutes === null) return null;
  return { year, month, day, hour, minute, second, offsetMinutes };
}

/** Renders an offset in minutes as ±HH:MM: 180 -> '+03:00', -330 -> '-05:30', 0 -> '+00:00'. */
export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const total = Math.abs(Math.round(offsetMinutes));
  const hours = String(Math.floor(total / 60)).padStart(2, '0');
  const minutes = String(total % 60).padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

// Whitespace and control characters never belong in an address; the URL parser
// would silently drop some of them, which hides text the model would then read.
const UNSAFE_URL_CHARS = /[\s\p{Cc}]/u;

/**
 * The one rule for a booking-form URL taken from a business card: the URL
 * itself when it is https, parses, carries no whitespace or control characters,
 * no user info and no explicit port, and its host equals an allowed suffix or
 * is a subdomain of one (so `n1.alteg.io.evil.com` is refused); otherwise null.
 * Both business_get and book_check hand out only what passes here (T-03-09).
 */
export function bookableFormUrl(formUrl: string | null): string | null {
  if (formUrl === null || UNSAFE_URL_CHARS.test(formUrl)) return null;
  let url: URL;
  try {
    url = new URL(formUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== ''
  ) {
    return null;
  }
  const host = url.hostname;
  const allowed = ALLOWED_FORM_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
  return allowed ? formUrl : null;
}

/**
 * Whether a business takes online bookings: its widget is active and its card
 * has a booking form. One answer for business_get and book_check. A form whose
 * URL fails `bookableFormUrl` still counts: both tools then hand out the plain
 * app.alteg.io link instead of the form's own address.
 */
export function canTakeOnlineBookings(card: {
  widgetActive: boolean;
  bookingFormUrl: string | null;
}): boolean {
  return card.widgetActive && card.bookingFormUrl !== null;
}

function requireId(value: number, name: string, min: 0 | 1): void {
  // Ids reach the URL as decimal digits only; anything else is a caller bug
  // (tool input is validated upstream), never a link.
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(
      `${name} must be an integer of at least ${min}, got ${String(value)}`
    );
  }
}

/**
 * A plain booking link with no pre-selection: `{form origin}/company/{location}`
 * for an allow-listed form URL (reason null), else
 * `https://app.alteg.io/book/{location}` with 'no_form_url' or
 * 'host_not_allowed'. Used for every fallback of buildBookingLink and by
 * book_check when the slot could not be verified.
 */
export function plainBookingLink(
  locationId: number,
  formUrl: string | null
): BookingLink {
  requireId(locationId, 'locationId', 1);
  if (formUrl === null || formUrl.trim() === '') {
    return {
      kind: 'booking_form',
      url: `${FALLBACK_BOOKING_ORIGIN}/book/${locationId}`,
      reason: 'no_form_url',
    };
  }
  const allowed = bookableFormUrl(formUrl);
  if (allowed === null) {
    return {
      kind: 'booking_form',
      url: `${FALLBACK_BOOKING_ORIGIN}/book/${locationId}`,
      reason: 'host_not_allowed',
    };
  }
  return {
    kind: 'booking_form',
    url: `${new URL(allowed).origin}/company/${locationId}`,
    reason: null,
  };
}

/** The offset and team-member guards (steps 4 to 7 of D-06) for a parsed slot, or null. */
function offsetOrTeamMemberBlocker(
  input: BookingLinkInput,
  slot: SlotParts
): LinkFallbackReason | null {
  // The widget renders a 5.5 hour zone as +05:50 (02-RESEARCH Pitfall 4).
  if (slot.offsetMinutes % 60 !== 0) return 'fractional_offset';
  const businessOffset = input.businessUtcOffsetHours;
  if (businessOffset === null || !Number.isFinite(businessOffset)) {
    return 'offset_unknown';
  }
  // A daylight-saving change or a stale card offset: the widget would add a
  // different offset than the slot's and drop the time.
  if (slot.offsetMinutes !== Math.round(businessOffset * 60)) {
    return 'offset_mismatch';
  }
  if (input.teamMemberId === 0 && !input.anyTeamMemberAllowed) {
    return 'any_team_member_disabled';
  }
  return null;
}

/**
 * Builds the pre-selected widget link of D-05. When pre-selection cannot be
 * built exactly it returns a plain booking-form link with the first failing
 * reason (D-06, BOOK-05), never a link the widget would silently reset.
 */
export function buildBookingLink(input: BookingLinkInput): BookingLink {
  const { locationId, teamMemberId, serviceIds } = input;
  requireId(locationId, 'locationId', 1);
  requireId(teamMemberId, 'teamMemberId', 0);
  for (const id of serviceIds) requireId(id, 'serviceIds[]', 1);

  const plain = plainBookingLink(locationId, input.formUrl);
  if (plain.reason !== null) return plain;

  if (serviceIds.length === 0) return { ...plain, reason: 'no_services' };
  const slot = parseSlotDatetime(input.slotDatetime);
  // The d token has minute precision, and the widget keeps a time only when
  // it equals a free slot's datetime exactly.
  if (slot === null || slot.second !== '00') {
    return { ...plain, reason: 'bad_datetime' };
  }
  const blocker = offsetOrTeamMemberBlocker(input, slot);
  if (blocker !== null) return { ...plain, reason: blocker };

  // d + YY + DD + MM + HH + mm: day before month, business wall clock.
  const time = `d${slot.year.slice(2)}${slot.day}${slot.month}${slot.hour}${slot.minute}`;
  const staff = `m${teamMemberId === 0 ? '-1' : String(teamMemberId)}`;
  const services = serviceIds.map((id) => `s${id}`).join('');
  return {
    kind: 'preselected',
    url: `${plain.url}?o=${staff}${services}${time}`,
    reason: null,
  };
}
