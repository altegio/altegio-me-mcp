import { isCalendarDay } from '../booking/calendar.js';
import type { OwnRecord } from '../booking/client.js';

// Pure logic over the client's own records (ME-03, ME-04, D-02, D-03):
// when a record happens, what status it has, the order a client reads them in
// and the usual service and team member of a place. SDK-free.

export type BookingStatus =
  'upcoming' | 'visited' | 'no_show' | 'cancelled' | 'past';

/** The usual service and team member of a place, from the client's own records. */
export interface Usual {
  businessName: string | null;
  serviceIds: number[];
  serviceTitles: (string | null)[];
  /** 0 means any team member. */
  teamMemberId: number;
  teamMemberName: string | null;
  /** YYYY-MM-DD of the record it comes from, in the business's local time. */
  date: string;
}

// The records route writes the offset without a colon (+0700); the slot routes
// write it with one. Both are read, and Z.
const RECORD_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)$/;

const MS_PER_MINUTE = 60_000;

/**
 * The instant of a record datetime in epoch milliseconds, read from the
 * offset the string carries (never from the business's time zone setting,
 * which can disagree with it); null when it is not a real moment.
 */
export function recordTimeMs(datetime: string): number | null {
  const match = RECORD_DATETIME.exec(datetime);
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
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    !isCalendarDay(Number(year), Number(month), Number(day))
  ) {
    return null;
  }
  let offsetMinutes = 0;
  if (offset !== 'Z') {
    const digits = offset.slice(1).replace(':', '');
    const hours = Number(digits.slice(0, 2));
    const minutes = digits.length > 2 ? Number(digits.slice(2)) : 0;
    if (minutes > 59) return null;
    offsetMinutes = (offset.startsWith('-') ? -1 : 1) * (hours * 60 + minutes);
  }
  const local = new Date(0);
  local.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  local.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  return local.getTime() - offsetMinutes * MS_PER_MINUTE;
}

/**
 * cancelled for a cancelled record whatever its date; upcoming after now;
 * otherwise visited (attendance 1), no_show (-1) or past. The attendance
 * meanings are inferred from a recording, not documented. A record whose
 * datetime cannot be read is past.
 */
export function bookingStatus(record: OwnRecord, nowMs: number): BookingStatus {
  if (record.cancelled) return 'cancelled';
  const at = recordTimeMs(record.datetime);
  if (at !== null && at > nowMs) return 'upcoming';
  if (record.attendance === 1) return 'visited';
  if (record.attendance === -1) return 'no_show';
  return 'past';
}

/**
 * Upcoming records first, soonest first, then every other record, latest
 * first; records of equal time keep their input order. Returns a new array.
 */
export function orderBookings(
  records: readonly OwnRecord[],
  nowMs: number
): OwnRecord[] {
  const timed = records.map((record) => ({
    record,
    at: recordTimeMs(record.datetime),
    upcoming: bookingStatus(record, nowMs) === 'upcoming',
  }));
  const upcoming = timed
    .filter((entry) => entry.upcoming)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const others = timed
    .filter((entry) => !entry.upcoming)
    .sort((a, b) => {
      // An unreadable moment sorts after every readable one.
      if (a.at === null || b.at === null) {
        return a.at === b.at ? 0 : a.at === null ? 1 : -1;
      }
      return b.at - a.at;
    });
  return [...upcoming, ...others].map((entry) => entry.record);
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}/;

/**
 * The usual service and team member per place: the latest record at that
 * place that is not cancelled, not in the future and has a service. Of two
 * records at the same moment the one later in the list wins (the route lists
 * oldest first). A place with no such record has no entry.
 */
export function usualByLocation(
  records: readonly OwnRecord[],
  nowMs: number
): Map<number, Usual> {
  const latest = new Map<number, { at: number; record: OwnRecord }>();
  for (const record of records) {
    if (record.cancelled || record.services.length === 0) continue;
    const at = recordTimeMs(record.datetime);
    if (at === null || at > nowMs) continue;
    const held = latest.get(record.locationId);
    if (held === undefined || at >= held.at) {
      latest.set(record.locationId, { at, record });
    }
  }

  const usual = new Map<number, Usual>();
  for (const [locationId, { record }] of latest) {
    usual.set(locationId, {
      businessName: record.businessName,
      serviceIds: record.services.map((service) => service.id),
      serviceTitles: record.services.map((service) => service.title),
      teamMemberId: record.teamMember?.id ?? 0,
      teamMemberName: record.teamMember?.name ?? null,
      date: LOCAL_DATE.exec(record.datetime)?.[0] ?? '',
    });
  }
  return usual;
}
