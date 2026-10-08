import { describe, expect, it } from '@jest/globals';
import { PRODUCTION_GATE_OPTIONS } from '../../booking/gate.js';
import type { UpstreamStats } from '../mock-upstream.js';
import {
  TIER2_ARRIVAL_TOLERANCE_MS,
  VERDICT_EXIT_CODE,
  allocationChecks,
  answeredShareCheck,
  check,
  partnerLimitChecks,
  verdictOf,
} from '../verdict.js';

// The verdict of the load script (WR-57): a gate that sheds half the calls can
// no longer print PASS. Safety checks decide FAIL; the capacity check decides
// BELOW; exit code 2 stays the usage error.

function startsEvery(spacingMs: number, count: number, from = 0): number[] {
  return Array.from({ length: count }, (_, index) => from + index * spacingMs);
}

describe('verdictOf and the exit codes', () => {
  it('is PASS for no checks and for checks that all passed', () => {
    expect(verdictOf([])).toBe('PASS');
    expect(
      verdictOf([check('a', true, ''), check('b', true, '', 'capacity')])
    ).toBe('PASS');
  });

  it('is FAIL when one safety check fails, whatever else fails', () => {
    expect(verdictOf([check('a', false, '')])).toBe('FAIL');
    expect(
      verdictOf([
        check('a', true, ''),
        check('b', false, '', 'capacity'),
        check('c', false, ''),
      ])
    ).toBe('FAIL');
  });

  it('is BELOW when only capacity checks fail', () => {
    expect(
      verdictOf([check('a', true, ''), check('b', false, '', 'capacity')])
    ).toBe('BELOW');
  });

  it('defaults a check to the safety kind', () => {
    expect(check('a', true, 'x').kind).toBe('safety');
  });

  it('maps PASS to 0, FAIL to 1 and BELOW to 3, leaving 2 for a usage error', () => {
    expect(VERDICT_EXIT_CODE).toEqual({ PASS: 0, FAIL: 1, BELOW: 3 });
    expect(Object.values(VERDICT_EXIT_CODE)).not.toContain(2);
  });

  it('fixes the tier 2 arrival tolerance at 50 ms', () => {
    expect(TIER2_ARRIVAL_TOLERANCE_MS).toBe(50);
  });
});

describe('allocationChecks (the production allocation, from start times)', () => {
  it('passes starts exactly 500 ms apart: 2 in a half-open second, 3 in a closed one', () => {
    const checks = allocationChecks('1x', [0, 500, 1000], 0);
    expect(checks).toHaveLength(3);
    expect(checks.every((entry) => entry.pass)).toBe(true);
    expect(checks.every((entry) => entry.kind === 'safety')).toBe(true);
  });

  it('fails a smallest gap of 499 ms at tolerance 0', () => {
    const failed = allocationChecks('1x', [0, 499], 0).filter(
      (entry) => !entry.pass
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]!.name).toContain('smallest gap');
    expect(failed[0]!.detail).toContain('499');
  });

  it('with tolerance 50 passes a 450 ms gap and fails 449', () => {
    expect(
      allocationChecks('run', [0, 450], 50).every((entry) => entry.pass)
    ).toBe(true);
    const failed = allocationChecks('run', [0, 449], 50).filter(
      (entry) => !entry.pass
    );
    expect(failed.map((entry) => entry.name).join('|')).toContain(
      'smallest gap'
    );
  });

  it('names the tolerance in every detail', () => {
    for (const entry of allocationChecks('run', [0, 500, 1000], 50)) {
      expect(entry.detail).toContain('tolerance 50');
    }
  });

  it('passes 90 starts in a half-open minute and fails 91', () => {
    const ninety = startsEvery(
      PRODUCTION_GATE_OPTIONS.minSpacingMs,
      PRODUCTION_GATE_OPTIONS.perMinute
    );
    expect(allocationChecks('1x', ninety, 0).every((entry) => entry.pass)).toBe(
      true
    );
    const failed = allocationChecks(
      '1x',
      startsEvery(
        PRODUCTION_GATE_OPTIONS.minSpacingMs,
        PRODUCTION_GATE_OPTIONS.perMinute + 1
      ),
      0
    ).filter((entry) => !entry.pass);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.name).toContain('60 s');
    expect(failed[0]!.detail).toContain('91');
  });

  it('counts a 91st start exactly 60,000 ms after the first as 90 half-open', () => {
    const times = [
      ...startsEvery(PRODUCTION_GATE_OPTIONS.minSpacingMs, 90),
      60_000,
    ];
    expect(allocationChecks('1x', times, 0).every((entry) => entry.pass)).toBe(
      true
    );
  });

  it('fails three starts inside a half-open second', () => {
    const failed = allocationChecks('1x', [0, 400, 800], 0).filter(
      (entry) => !entry.pass
    );
    expect(failed.map((entry) => entry.name).join('|')).toContain('1 s');
  });

  it('passes with the detail "fewer than two starts" when the gap is undefined', () => {
    const gap = allocationChecks('1x', [42], 0)[0]!;
    expect(gap.pass).toBe(true);
    expect(gap.detail).toContain('fewer than two starts');
  });
});

describe('partnerLimitChecks (closed intervals, the conservative partner model)', () => {
  const clean: UpstreamStats = {
    max1s: 5,
    max60s: 200,
    served429: 0,
    starts: 300,
    aborted: 0,
  };

  it('keeps the three closed-interval checks as safety checks', () => {
    const checks = partnerLimitChecks('1x', clean);
    expect(checks).toHaveLength(3);
    expect(checks.every((entry) => entry.pass)).toBe(true);
    expect(checks.every((entry) => entry.kind === 'safety')).toBe(true);
  });

  it('fails above 5 in a second, above 200 in a minute and on any upstream 429', () => {
    expect(
      partnerLimitChecks('1x', { ...clean, max1s: 6 }).filter((e) => !e.pass)
    ).toHaveLength(1);
    expect(
      partnerLimitChecks('1x', { ...clean, max60s: 201 }).filter((e) => !e.pass)
    ).toHaveLength(1);
    expect(
      partnerLimitChecks('1x', { ...clean, served429: 1 }).filter(
        (e) => !e.pass
      )
    ).toHaveLength(1);
  });
});

describe('answeredShareCheck (more than 80%, in integers)', () => {
  it('passes 81 of 100', () => {
    const entry = answeredShareCheck('1x', 81, 100);
    expect(entry.pass).toBe(true);
    expect(entry.kind).toBe('capacity');
  });

  it('fails 80 of 100 and writes the detail with the floored percentage', () => {
    const entry = answeredShareCheck('1x', 80, 100);
    expect(entry.pass).toBe(false);
    expect(entry.kind).toBe('capacity');
    expect(entry.detail).toBe(
      'Answered: 80 of 100 (80.0%); threshold: more than 80%'
    );
  });

  it('does not pass 0 of 0', () => {
    expect(answeredShareCheck('1x', 0, 0).pass).toBe(false);
  });
});
