import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { CONFIG_KEYS } from '../config/schema.js';

// Guards the README against drifting from the code (DOC-01): the environment
// table must list exactly the configuration keys, the required sections must
// exist, and wording that says the work is still to come must not return.
// The README is read through process.cwd() (D-07).

const README = readFileSync(join(process.cwd(), 'README.md'), 'utf8');

const REQUIRED_HEADINGS = [
  '## Architecture',
  '## Environment variables',
  '## Local run',
  '## Checks',
  '## Docker',
  '## CI and branch rules',
  '## Deploy',
  '## Cost estimate',
  '## Owner',
] as const;

const REQUIRED_MENTIONS = [
  'npm run dev',
  'GET /health',
  'POST /mcp',
  '2025-11-25',
  '2026-07-28',
  'npm run check',
  'docker build',
  'ALTEGIO_API_TOKEN',
  'Node 26',
  'default-branch-ci-gate',
  'npm run test:live',
  'src/booking',
  'scripts/browser-check',
] as const;

function section(heading: string): string {
  const start = README.indexOf(`${heading}\n`);
  if (start === -1) return '';
  const rest = README.slice(start + heading.length + 1);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

function firstColumnNames(table: string): string[] {
  const names: string[] = [];
  for (const line of table.split('\n')) {
    const match = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (match?.[1] !== undefined) names.push(match[1]);
  }
  return names;
}

describe('README.md', () => {
  it.each(REQUIRED_HEADINGS)('has the section %s', (heading) => {
    expect(README).toContain(`\n${heading}\n`);
  });

  it('lists exactly the configuration keys in the environment table', () => {
    const names = firstColumnNames(section('## Environment variables'));
    expect(names).toHaveLength(new Set(names).size);
    expect([...names].sort()).toEqual([...CONFIG_KEYS].sort());
  });

  it.each(REQUIRED_MENTIONS)('mentions %s', (text) => {
    expect(README).toContain(text);
  });

  it.each([/\bplanned\b/i, /\bplanning\b/i, /no code yet/i])(
    'does not use the stale wording %s',
    (pattern) => {
      expect(README).not.toMatch(pattern);
    }
  );
});

// Guards the record of the real-browser check of the widget link (BOOK-04):
// the results section, one table row per browser-check case, the B4 status
// line and a completed owner review must stay in the deep-link doc.

const DEEP_LINK_DOC = readFileSync(
  join(process.cwd(), 'docs', 'research', 'widget-deep-link.md'),
  'utf8'
);

const BROWSER_CHECK_CASE_IDS = [
  'single-named',
  'multi-services',
  'any-member',
  'plain-fallback',
  'taken-slot',
  'menu-and-steps',
  'personal-or-group',
  'half-hour-zone',
  'dst-boundary',
  'any-member-disabled',
  'slug-host',
  'group-event-order',
] as const;

function browserCheckResults(): string {
  const heading = '## Browser check results\n';
  const start = DEEP_LINK_DOC.indexOf(heading);
  if (start === -1) return '';
  const rest = DEEP_LINK_DOC.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('docs/research/widget-deep-link.md browser check results', () => {
  const results = browserCheckResults();

  it('has the section ## Browser check results', () => {
    expect(DEEP_LINK_DOC).toContain('\n## Browser check results\n');
  });

  it.each(BROWSER_CHECK_CASE_IDS)('has a table row for the case %s', (id) => {
    expect(results).toMatch(new RegExp(`^\\| ${id} \\|`, 'm'));
  });

  it('has a B4 status line', () => {
    expect(results).toMatch(/^B4 status: \S/m);
  });

  it('records a completed owner review', () => {
    const review = /^Owner review: (.+)$/m.exec(results);
    expect(review).not.toBeNull();
    expect(review?.[1]).not.toMatch(/^pending\b/i);
  });
});

// The recorded OPS-07 results (plan 03-12): tiers 1 and 2 must state maxima
// within the standard partner limits and no upstream 429, so a later edit
// cannot leave a figure above its limit unnoticed.
const LOADTEST_DOC = readFileSync(
  join(process.cwd(), 'docs', 'loadtest', 'results.md'),
  'utf8'
);

function loadtestSection(heading: string): string {
  const start = LOADTEST_DOC.indexOf(`${heading}\n`);
  if (start === -1) return '';
  const rest = LOADTEST_DOC.slice(start + heading.length + 1);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('docs/loadtest/results.md (OPS-07)', () => {
  it.each([
    '## Peak arithmetic',
    '## Tier 1: simulation',
    '## Tier 2: local container',
    '## Tier 3: live, bounded',
    '## Known deviation',
  ])('has the section %s', (heading) => {
    expect(LOADTEST_DOC).toContain(`\n${heading}\n`);
  });

  it.each(['## Tier 1: simulation', '## Tier 2: local container'])(
    'records the maxima within the limits and no upstream 429 in %s',
    (heading) => {
      const text = loadtestSection(heading);
      expect(text).not.toBe('');
      const perSecond =
        /^Max upstream starts in any 1 s: (\d+) \(limit 5\)$/m.exec(text);
      const perMinute =
        /^Max upstream starts in any 60 s: (\d+) \(limit 200\)$/m.exec(text);
      expect(perSecond).not.toBeNull();
      expect(perMinute).not.toBeNull();
      expect(Number(perSecond?.[1])).toBeGreaterThan(0);
      expect(Number(perSecond?.[1])).toBeLessThanOrEqual(5);
      expect(Number(perMinute?.[1])).toBeGreaterThan(0);
      expect(Number(perMinute?.[1])).toBeLessThanOrEqual(200);
      expect(text).toMatch(/^Upstream 429 responses: 0$/m);
    }
  );

  it('dates and pins each measured tier to a commit', () => {
    for (const heading of [
      '## Tier 1: simulation',
      '## Tier 2: local container',
    ]) {
      const text = loadtestSection(heading);
      expect(text).toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(text).toMatch(/Commit: [0-9a-f]{7}/);
    }
  });

  it('keeps the live run status honest: not run, run on a date, or deferred on a date', () => {
    const text = loadtestSection('## Tier 3: live, bounded');
    const status =
      /^Status: (not run yet \(plan 03-16\)|run \d{4}-\d{2}-\d{2}|deferred \d{4}-\d{2}-\d{2})/m.exec(
        text
      );
    expect(status).not.toBeNull();
    if (status?.[1]?.startsWith('deferred')) {
      // A deferral must carry its reason (the platform contract in
      // operations.md, the dedicated partner token B3) and its trigger.
      expect(text).toContain('B3');
      expect(text).toContain('operations.md');
    }
  });

  it('records the dedicated partner type as a known deviation (D-03, B3)', () => {
    const text = loadtestSection('## Known deviation');
    expect(text).toContain('D-03');
    expect(text).toContain('B3');
    expect(text).toContain('2630');
  });
});

// The recorded OPS-08 run (plan 03-17): claude.ai itself drove the
// known-business flow through the public route. The section must name the
// date, the revision and the commit, hold one row per step, and carry an owner
// review that is not pending, so the proof cannot be dropped or left blank.
const CONNECTOR_RUN_DOC = readFileSync(
  join(process.cwd(), 'docs', 'research', 'claude-connector-run.md'),
  'utf8'
);

const CONNECTOR_STEP_IDS = [
  'business_get',
  'business_list_services',
  'business_list_team_members',
  'business_list_dates',
  'business_list_time_slots',
  'book_check',
  'widget',
] as const;

function connectorRunResults(): string {
  const heading = '## Connector run results\n';
  const start = CONNECTOR_RUN_DOC.indexOf(heading);
  if (start === -1) return '';
  const rest = CONNECTOR_RUN_DOC.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('docs/research/claude-connector-run.md connector run results (OPS-08)', () => {
  const results = connectorRunResults();

  it('has the section ## Connector run results', () => {
    expect(CONNECTOR_RUN_DOC).toContain('\n## Connector run results\n');
  });

  it('names the run date and time range, the revision and the commit', () => {
    expect(results).toMatch(/^Run: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/m);
    expect(results).toMatch(/^Revision: \S/m);
    expect(results).toMatch(/^Commit: [0-9a-f]{7}/m);
  });

  it.each(CONNECTOR_STEP_IDS)('has a table row for the step %s', (id) => {
    expect(results).toMatch(new RegExp(`^\\| ${id} \\|`, 'm'));
  });

  it('records a completed owner review', () => {
    const review = /^Owner review: (.+)$/m.exec(results);
    expect(review).not.toBeNull();
    expect(review?.[1]).not.toMatch(/^pending\b/i);
  });
});

// The CASE-01 research record (plan 05-01): one go/no-go row per case with a
// verdict, and the owner's pair probe with its date, commit and status, so the
// verdicts and the live result cannot be dropped or left blank.
const CASES_DOC = readFileSync(
  join(process.cwd(), 'docs', 'research', 'cases.md'),
  'utf8'
);

function casesSection(heading: string): string {
  const start = CASES_DOC.indexOf(`\n${heading}\n`);
  if (start === -1) return '';
  const rest = CASES_DOC.slice(start + heading.length + 2);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

const CASE_ROWS = [
  'Two people side by side',
  'Freed-slot monitoring',
  'Slot hold',
] as const;

describe('docs/research/cases.md (CASE-01)', () => {
  it('has the sections ## Go/no-go and ## Pair probe', () => {
    expect(CASES_DOC).toContain('\n## Go/no-go\n');
    expect(CASES_DOC).toContain('\n## Pair probe\n');
  });

  it.each(CASE_ROWS)('has a go/no-go row for %s with a verdict', (name) => {
    const row = new RegExp(`^\\| ${name} \\|(.+)$`, 'm').exec(
      casesSection('## Go/no-go')
    );
    expect(row).not.toBeNull();
    expect(row?.[1]).toMatch(/\b(GO-WITH-SCOPE|GO|CONDITIONAL|NO-GO)\b/);
  });

  it('names the probe run date and time, the commit and the status', () => {
    const probe = casesSection('## Pair probe');
    expect(probe).toMatch(/^Run: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/m);
    expect(probe).toMatch(/^Commit: [0-9a-f]{7}/m);
    expect(probe).toMatch(/^Status: (passed|refused|not run)/m);
  });
});

describe('docs/research/cases.md host runs (CASE-03, D-03)', () => {
  const runs = casesSection('## Host runs');

  it('records the run time, or says the run did not happen', () => {
    expect(runs).toMatch(
      /^(Run: \d{4}-\d{2}-\d{2} \d{2}:\d{2}|Status: not run)/m
    );
  });

  it('names the host and the write tools the run called', () => {
    expect(runs).toMatch(/^Host: \S/m);
    expect(runs).toMatch(/^Write tools called: (none|\S)/m);
  });

  it('states the outcome of the scheduled task and, when it did not reach the server, the retest condition', () => {
    expect(runs).toMatch(/^Status: (passed|blocked|not run)/m);
    if (/^Status: (blocked|not run)/m.test(runs)) {
      expect(runs).toMatch(/^Retest when: \S/m);
    }
  });

  it('holds no token, phone number or e-mail address', () => {
    expect(runs).not.toMatch(/Bearer\s+\S/i);
    expect(runs).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
    expect(runs).not.toMatch(/\+\d{7,}/);
  });
});
