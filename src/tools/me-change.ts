import { z } from 'zod';
import {
  BOOKING_ROUTES,
  CLIENT_WRITE_ROUTES,
  USER_ROUTES,
} from '../booking/client.js';
import { defineTool } from './factory.js';
import { confirmationTokenInput } from './confirmation.js';
import { ToolError } from './errors.js';
import { slotDatetimeInput } from './book.js';
import type { ToolDeps } from './registry.js';
import { SCOPE_BOOK, SCOPE_READ } from './scopes.js';

// me_reschedule_booking (ME-07, ADR 0006): skeleton, behaviour follows.

const rescheduleInput = z.strictObject({
  booking_id: z.number().int().positive(),
  datetime: slotDatetimeInput,
  confirmation_token: confirmationTokenInput,
});

const rescheduleOutput = z.strictObject({ status: z.string() });

export const meRescheduleBooking = defineTool<
  typeof rescheduleInput,
  typeof rescheduleOutput,
  ToolDeps
>({
  name: 'me_reschedule_booking',
  title: 'Move one of my bookings',
  description: 'Moves one of the signed-in client bookings.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
    idempotentHint: false,
  },
  scopes: [SCOPE_READ, SCOPE_BOOK],
  upstream: [
    USER_ROUTES.records,
    BOOKING_ROUTES.company,
    BOOKING_ROUTES.check,
    CLIENT_WRITE_ROUTES.move,
  ],
  input: rescheduleInput,
  output: rescheduleOutput,
  render: () => 'not implemented',
  handler: () => {
    throw new ToolError('not implemented', 'none');
  },
});
