import { DEFAULT_GATE_OPTIONS } from '../booking/gate.js';

// The expected peak, derived from the README estimate (D-03, 03-RESEARCH
// Pattern 9): about 1,000,000 tool calls a month. Every constant names its
// source or its assumption, so a changed estimate is a one-line edit here and
// the tier 1 simulation and the tier 2 run follow it.

/** 30 days of 86,400 seconds. */
export const SECONDS_PER_MONTH = 2_592_000;

/** README "Cost estimate": the order of magnitude the service is sized for. */
export const PEAK_MONTHLY_TOOL_CALLS = 1_000_000;

/**
 * Assumption A2: the busiest hour carries 5 times the average rate. Nothing
 * measured backs it yet; revisit it with real call logs after launch.
 */
export const PEAK_HOUR_FACTOR = 5;

/** About 0.386 tool calls per second on average. */
export const AVERAGE_TOOL_CALLS_PER_SEC =
  PEAK_MONTHLY_TOOL_CALLS / SECONDS_PER_MONTH;

/** About 1.93 tool calls per second in a peak hour. */
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

/** About 2.9 upstream calls per second at the peak. */
export const UPSTREAM_PEAK_CALLS_PER_SEC =
  PEAK_TOOL_CALLS_PER_SEC * UPSTREAM_CALLS_PER_TOOL_CALL;

/** The gate's sustained ceiling (180 a minute): 3 upstream calls per second. */
export const GATE_CEILING_CALLS_PER_SEC = DEFAULT_GATE_OPTIONS.perMinute / 60;
