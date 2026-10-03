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

/**
 * The origin of an allow-listed booking-form URL, or null. Accepts https only,
 * no user info, no explicit port, and a host equal to an allowed suffix or a
 * subdomain of one (so `n1.alteg.io.evil.com` is refused).
 */
function allowedFormOrigin(formUrl: string): string | null {
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
  return allowed ? url.origin : null;
}

function fallbackLink(
  locationId: number,
  reason: LinkFallbackReason
): BookingLink {
  return {
    kind: 'booking_form',
    url: `${FALLBACK_BOOKING_ORIGIN}/book/${locationId}`,
    reason,
  };
}

/** Builds the pre-selected widget link of D-05, or a plain booking-form link with a reason (D-06). */
export function buildBookingLink(input: BookingLinkInput): BookingLink {
  const { locationId, formUrl, teamMemberId, serviceIds, slotDatetime } = input;
  if (formUrl === null) return fallbackLink(locationId, 'no_form_url');
  const origin = allowedFormOrigin(formUrl);
  if (origin === null) return fallbackLink(locationId, 'host_not_allowed');
  const slot = parseSlotDatetime(slotDatetime);
  if (slot === null) {
    return {
      kind: 'booking_form',
      url: `${origin}/company/${locationId}`,
      reason: 'bad_datetime',
    };
  }
  // d + YY + DD + MM + HH + mm: day before month, business wall clock.
  const time = `d${slot.year.slice(2)}${slot.day}${slot.month}${slot.hour}${slot.minute}`;
  const staff = `m${teamMemberId === 0 ? '-1' : String(teamMemberId)}`;
  const services = serviceIds.map((id) => `s${id}`).join('');
  return {
    kind: 'preselected',
    url: `${origin}/company/${locationId}?o=${staff}${services}${time}`,
    reason: null,
  };
}

/** RED stub for Task 2; not implemented yet. */
export function plainBookingLink(
  locationId: number,
  _formUrl: string | null
): BookingLink {
  return fallbackLink(locationId, 'no_form_url');
}
