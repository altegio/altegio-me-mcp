import type { UpstreamStats } from './mock-upstream.js';

// RED stubs: signatures only. The behaviour lands with the GREEN commit.

export type CheckKind = 'safety' | 'capacity';

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
  kind: CheckKind;
}

export type Verdict = 'PASS' | 'BELOW' | 'FAIL';

export const VERDICT_EXIT_CODE: Readonly<Record<Verdict, number>> = {
  PASS: 0,
  FAIL: 0,
  BELOW: 0,
};

export const TIER2_ARRIVAL_TOLERANCE_MS = 0;

export function check(
  name: string,
  pass: boolean,
  detail: string,
  kind: CheckKind = 'safety'
): Check {
  return { name, pass, detail, kind };
}

export function verdictOf(_checks: readonly Check[]): Verdict {
  throw new Error('not implemented');
}

export function partnerLimitChecks(
  _label: string,
  _stats: UpstreamStats
): Check[] {
  throw new Error('not implemented');
}

export function allocationChecks(
  _label: string,
  _startTimes: readonly number[],
  _toleranceMs: number
): Check[] {
  throw new Error('not implemented');
}

export function answeredShareCheck(
  _label: string,
  _ok: number,
  _total: number
): Check {
  throw new Error('not implemented');
}
