import { PRODUCTION_GATE_OPTIONS } from '../booking/gate.js';
import {
  LIMIT_PER_MINUTE,
  LIMIT_PER_SECOND,
  slidingMaxHalfOpen,
  smallestGap,
  type UpstreamStats,
} from './mock-upstream.js';
import {
  ALLOCATION_PER_SECOND,
  MIN_ANSWERED_PER_MILLE_AT_PEAK,
  answeredPercentText,
  meetsAnsweredShare,
} from './profile.js';

// The typed checks and the verdict of the load script (OPS-07, WR-57). A check
// is either a safety check (the allocation and the partner limits held, nothing
// failed unexpectedly) or a capacity check (enough tool calls were answered).
// The verdict keeps the two apart: a gate that stays inside its allocation but
// sheds half the calls is BELOW the launch criterion, not a PASS and not a FAIL.

export type CheckKind = 'safety' | 'capacity';

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
  kind: CheckKind;
}

export type Verdict = 'PASS' | 'BELOW' | 'FAIL';

/** 2 stays the usage-error code of the script. */
export const VERDICT_EXIT_CODE: Readonly<Record<Verdict, number>> = {
  PASS: 0,
  FAIL: 1,
  BELOW: 3,
};

/**
 * Tier 2 request arrivals at the mock carry network and event-loop jitter of a
 * few milliseconds. Tier 2 counts the allocation over windows shortened by this
 * fixed amount and accepts a smallest gap of 500 ms minus it. Tier 1 runs on an
 * exact clock and uses 0. The value is fixed before any run and is not to be
 * widened to make a run pass.
 */
export const TIER2_ARRIVAL_TOLERANCE_MS = 50;

export function check(
  name: string,
  pass: boolean,
  detail: string,
  kind: CheckKind = 'safety'
): Check {
  return { name, pass, detail, kind };
}

/** FAIL when any safety check failed, else BELOW when any capacity check failed, else PASS. */
export function verdictOf(checks: readonly Check[]): Verdict {
  if (checks.some((entry) => entry.kind === 'safety' && !entry.pass)) {
    return 'FAIL';
  }
  if (checks.some((entry) => !entry.pass)) return 'BELOW';
  return 'PASS';
}

/**
 * The partner limits as the mock counts them: closed sliding intervals, the
 * conservative reading of the real upstream.
 */
export function partnerLimitChecks(
  label: string,
  stats: UpstreamStats
): Check[] {
  return [
    check(
      `${label}: upstream starts in any 1 s <= ${LIMIT_PER_SECOND}`,
      stats.max1s <= LIMIT_PER_SECOND,
      `Max upstream starts in any 1 s: ${stats.max1s} (limit ${LIMIT_PER_SECOND})`
    ),
    check(
      `${label}: upstream starts in any 60 s <= ${LIMIT_PER_MINUTE}`,
      stats.max60s <= LIMIT_PER_MINUTE,
      `Max upstream starts in any 60 s: ${stats.max60s} (limit ${LIMIT_PER_MINUTE})`
    ),
    check(
      `${label}: no upstream 429`,
      stats.served429 === 0,
      `Upstream 429 responses: ${stats.served429}`
    ),
  ];
}

/**
 * The production allocation (operations.md: 500 ms spacing, 2 a second, 90 a
 * minute), measured from the start times the mock recorded, not from the gate's
 * own accounting. Windows are half-open; the smallest gap is exact. The
 * tolerance shortens each window and the gap by the same fixed amount.
 */
export function allocationChecks(
  label: string,
  startTimes: readonly number[],
  toleranceMs: number
): Check[] {
  const { minSpacingMs, perMinute } = PRODUCTION_GATE_OPTIONS;
  const gap = smallestGap(startTimes);
  const gapFloor = minSpacingMs - toleranceMs;
  const secondWindow = 1000 - toleranceMs;
  const minuteWindow = 60_000 - toleranceMs;
  const inSecond = slidingMaxHalfOpen(startTimes, secondWindow);
  const inMinute = slidingMaxHalfOpen(startTimes, minuteWindow);
  return [
    check(
      `${label}: smallest gap between upstream starts >= ${minSpacingMs} ms`,
      gap === null || gap >= gapFloor,
      gap === null
        ? `Smallest gap: fewer than two starts (allocation ${minSpacingMs} ms, tolerance ${toleranceMs} ms)`
        : `Smallest gap: ${gap} ms (allocation ${minSpacingMs} ms, tolerance ${toleranceMs} ms: at least ${gapFloor} ms)`
    ),
    check(
      `${label}: upstream starts in any half-open 1 s <= ${ALLOCATION_PER_SECOND}`,
      inSecond <= ALLOCATION_PER_SECOND,
      `Max upstream starts in any half-open ${secondWindow} ms: ${inSecond} (allocation ${ALLOCATION_PER_SECOND} a second, tolerance ${toleranceMs} ms)`
    ),
    check(
      `${label}: upstream starts in any half-open 60 s <= ${perMinute}`,
      inMinute <= perMinute,
      `Max upstream starts in any half-open ${minuteWindow} ms: ${inMinute} (allocation ${perMinute} a minute, tolerance ${toleranceMs} ms)`
    ),
  ];
}

/** The launch criterion: more than 80% of tool calls answered, a capacity check. */
export function answeredShareCheck(
  label: string,
  ok: number,
  total: number
): Check {
  const threshold = `more than ${MIN_ANSWERED_PER_MILLE_AT_PEAK / 10}%`;
  return check(
    `${label}: ${threshold} of tool calls answered`,
    meetsAnsweredShare(ok, total),
    `Answered: ${ok} of ${total} (${answeredPercentText(ok, total)}); threshold: ${threshold}`,
    'capacity'
  );
}
