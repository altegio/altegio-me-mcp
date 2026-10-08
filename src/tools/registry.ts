import type { BookingClient } from '../booking/client.js';
import { bookCheck } from './book.js';
import {
  businessGet,
  businessListDates,
  businessListServices,
  businessListTeamMembers,
  businessListTimeSlots,
} from './business.js';
import type { DefinedTool } from './factory.js';
import { meListBookings, meListPlaces } from './me.js';

/** What every production tool receives: one booking client built from config. */
export interface ToolDeps {
  booking: BookingClient;
}

// Every tool is read-only (ADR-0001-D2); the compliance suite checks it.
// Listed in booking-flow order: the signed-in client's own places and bookings
// first (the flow now starts there, ADR 0005), then the card, services, team members,
// dates with free time, the free slots of one date, and the check that hands
// off to the booking widget.
export const productionTools: readonly DefinedTool<ToolDeps>[] = Object.freeze([
  meListPlaces,
  meListBookings,
  businessGet,
  businessListServices,
  businessListTeamMembers,
  businessListDates,
  businessListTimeSlots,
  bookCheck,
]);
