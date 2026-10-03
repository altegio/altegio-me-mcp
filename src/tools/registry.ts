import type { BookingClient } from '../booking/client.js';
import { businessGet } from './business.js';
import type { DefinedTool } from './factory.js';

/** What every production tool receives: one booking client built from config. */
export interface ToolDeps {
  booking: BookingClient;
}

// Every tool is read-only in v1 (ADR-0001-D2); the compliance suite checks it.
export const productionTools: readonly DefinedTool<ToolDeps>[] = Object.freeze([
  businessGet,
]);
