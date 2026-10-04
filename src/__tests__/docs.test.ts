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
  'Node 22',
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
