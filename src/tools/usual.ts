import type { OwnRecord } from '../booking/client.js';

// Pure logic over the client's own records (ME-03, ME-04). SDK-free.

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
  /** YYYY-MM-DD of the record it comes from. */
  date: string;
}

export function recordTimeMs(_datetime: string): number | null {
  throw new Error('not implemented');
}

export function bookingStatus(
  _record: OwnRecord,
  _nowMs: number
): BookingStatus {
  throw new Error('not implemented');
}

export function orderBookings(
  _records: readonly OwnRecord[],
  _nowMs: number
): OwnRecord[] {
  throw new Error('not implemented');
}

export function usualByLocation(
  _records: readonly OwnRecord[],
  _nowMs: number
): Map<number, Usual> {
  throw new Error('not implemented');
}
