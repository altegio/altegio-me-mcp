import type { BookingClient } from '../booking/client.js';
import {
  businessGet,
  businessListDates,
  businessListServices,
  businessListTeamMembers,
  businessListTimeSlots,
} from './business.js';
import type { DefinedTool } from './factory.js';

/** What every production tool receives: one booking client built from config. */
export interface ToolDeps {
  booking: BookingClient;
}

// Every tool is read-only in v1 (ADR-0001-D2); the compliance suite checks it.
// Listed in booking-flow order: the card, services, team members, dates with
// free time, then the free slots of one date.
export const productionTools: readonly DefinedTool<ToolDeps>[] = Object.freeze([
  businessGet,
  businessListServices,
  businessListTeamMembers,
  businessListDates,
  businessListTimeSlots,
]);
