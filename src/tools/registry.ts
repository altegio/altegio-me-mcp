import type { BookingClient } from '../booking/client.js';
import type { InstallationGate } from '../booking/installation.js';
import { bookCheck } from './book.js';
import {
  businessGet,
  businessListDates,
  businessListServices,
  businessListTeamMembers,
  businessListTimeSlots,
} from './business.js';
import { businessSearch } from './business-search.js';
import type { Confirmations } from './confirmation.js';
import type { DefinedTool } from './factory.js';
import { meListBookings, meListPlaces } from './me.js';
import { meBook } from './me-book.js';
import { meCancelBooking, meRescheduleBooking } from './me-change.js';

/** What every production tool receives: one booking client built from config. */
export interface ToolDeps {
  booking: BookingClient;
  /** Confirmation tokens of the write tools; absent uses the process-wide default. */
  confirmations?: Confirmations;
  /**
   * The assistant-booking gate (ADR 0006, D3 amended 2026-10-27): whether a
   * business takes bookings from the chat. Absent, every business does.
   */
  installations?: InstallationGate;
}

// Every tool reads, apart from me_book and the tools that change a booking, which
// write for a signed-in client after a confirmed preview (ADR 0006); the
// compliance suite checks both.
// Listed in booking-flow order: the signed-in client's own places and bookings
// first (the flow now starts there, ADR 0005), then the card, services, team members,
// dates with free time, the free slots of one date, the check that hands
// off to the booking widget, and the client's writes at an own place.
export const productionTools: readonly DefinedTool<ToolDeps>[] = Object.freeze([
  meListPlaces,
  meListBookings,
  businessSearch,
  businessGet,
  businessListServices,
  businessListTeamMembers,
  businessListDates,
  businessListTimeSlots,
  bookCheck,
  meBook,
  meRescheduleBooking,
  meCancelBooking,
]);
