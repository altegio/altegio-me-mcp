import { PRODUCTION_GATE_OPTIONS } from '../booking/gate.js';

// The expected peak, derived from the owner's MVP assumption of 2026-10-07: at
// most 10,000 bookings a month for the first weeks to months after launch, and
// capacity revisited only if growth exceeds it. Every constant names its source
// or its assumption, so a changed estimate is a one-line edit here and the
// tier 1 simulation and the tier 2 run follow it. The earlier profile (the
// README's 1,000,000 tool calls a month, D-03) is about ten times this one and
// is kept in docs/loadtest/results.md as the measured headroom.

/** 30 days of 86,400 seconds. */
export const SECONDS_PER_MONTH = 2_592_000;

/** Owner assumption (2026-10-07): the most bookings a month the MVP sees. */
export const MVP_MONTHLY_BOOKINGS = 10_000;

/**
 * Tool calls behind one booking. The 2026-10-06 connector run reached the
 * widget link in 6 tool calls (docs/research/claude-connector-run.md); 10
 * leaves room for browsing that ends without a booking. An assumption, not a
 * measurement; revisit with real call logs.
 */
export const TOOL_CALLS_PER_BOOKING = 10;

/** About 100,000 tool calls a month: the README "Expected" cost column. */
export const PEAK_MONTHLY_TOOL_CALLS =
  MVP_MONTHLY_BOOKINGS * TOOL_CALLS_PER_BOOKING;

/**
 * Assumption A2: the busiest hour carries 5 times the average rate. Nothing
 * measured backs it yet; revisit it with real call logs after launch.
 */
export const PEAK_HOUR_FACTOR = 5;

/** About 0.039 tool calls per second on average. */
export const AVERAGE_TOOL_CALLS_PER_SEC =
  PEAK_MONTHLY_TOOL_CALLS / SECONDS_PER_MONTH;

/** About 0.19 tool calls per second in a peak hour. */
export const PEAK_TOOL_CALLS_PER_SEC =
  AVERAGE_TOOL_CALLS_PER_SEC * PEAK_HOUR_FACTOR;

export type LoadToolName =
  | 'business_get'
  | 'business_list_services'
  | 'business_list_team_members'
  | 'business_list_dates'
  | 'business_list_time_slots'
  | 'book_check';

/**
 * Share of tool calls per tool. An assumption, not a measurement: a client
 * browses (business_get, services, team members, dates, slots) and a smaller
 * share goes on to book_check, the hand-off. Revisit with real logs.
 */
export const TOOL_MIX: Readonly<Record<LoadToolName, number>> = Object.freeze({
  business_get: 0.15,
  business_list_services: 0.2,
  business_list_team_members: 0.15,
  business_list_dates: 0.17,
  business_list_time_slots: 0.16,
  book_check: 0.17,
});

/**
 * Upstream calls one tool call costs, at most. book_check checks the slot,
 * then reads the card, the services and the named team member (4); every other
 * tool reads one route. The mix always names a team member for book_check, the
 * worst case.
 */
export const UPSTREAM_CALLS_PER_TOOL: Readonly<Record<LoadToolName, number>> =
  Object.freeze({
    business_get: 1,
    business_list_services: 1,
    business_list_team_members: 1,
    business_list_dates: 1,
    business_list_time_slots: 1,
    book_check: 4,
  });

/** Mix-weighted upstream calls per tool call: about 1.5. */
export const UPSTREAM_CALLS_PER_TOOL_CALL = (
  Object.keys(TOOL_MIX) as LoadToolName[]
).reduce(
  (sum, tool) => sum + TOOL_MIX[tool] * UPSTREAM_CALLS_PER_TOOL[tool],
  0
);

/** About 0.29 upstream calls per second at the peak. */
export const UPSTREAM_PEAK_CALLS_PER_SEC =
  PEAK_TOOL_CALLS_PER_SEC * UPSTREAM_CALLS_PER_TOOL_CALL;

/**
 * The gate's sustained ceiling: PRODUCTION_GATE_OPTIONS.perMinute a minute, the
 * allocation of one process (operations.md, "Admission and shared partner
 * allocation"), which is 90 a minute and 1.5 upstream calls per second. The
 * development defaults (250 ms, 180 a minute) are not what production runs.
 */
export const GATE_CEILING_CALLS_PER_SEC =
  PRODUCTION_GATE_OPTIONS.perMinute / 60;

/** Starts a second the production spacing allows: 500 ms spacing is 2. */
export const ALLOCATION_PER_SECOND =
  1000 / PRODUCTION_GATE_OPTIONS.minSpacingMs;

/** The expected peak as a multiple of the ceiling: about 0.19. */
export const PEAK_AGAINST_CEILING =
  UPSTREAM_PEAK_CALLS_PER_SEC / GATE_CEILING_CALLS_PER_SEC;

/**
 * The launch criterion, per mille: more than 80% of tool calls are answered at
 * the expected peak. It is the bar the 03-12 peak test already asserted
 * (ok / toolCalls greater than 0.8), kept and compared in integers. Changing it
 * needs an owner decision.
 */
export const MIN_ANSWERED_PER_MILLE_AT_PEAK = 800;

/**
 * True when MORE than 80% of `total` calls were answered, compared in integers
 * (ok x 1000 > total x 800): 80 of 100 does not meet it, 81 of 100 does, and no
 * calls at all do not.
 */
export function meetsAnsweredShare(ok: number, total: number): boolean {
  return total > 0 && ok * 1000 > total * MIN_ANSWERED_PER_MILLE_AT_PEAK;
}

/**
 * The answered share as text, floored (never rounded up) to one decimal from
 * the exact integer per-mille: 1102 of 1151 is "95.7%", 799 of 1000 is
 * "79.9%", and no calls is "n/a".
 */
export function answeredPercentText(ok: number, total: number): string {
  if (total <= 0) return 'n/a';
  const perMille = (ok * 1000 - ((ok * 1000) % total)) / total;
  const whole = Math.floor(perMille / 10);
  return `${whole}.${perMille % 10}%`;
}
