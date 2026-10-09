import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { productionTools } from '../tools/registry.js';

// Guards evals/tasks/*.yaml (CASE-05, D-05): the eval tasks of the added-value
// cases are written in this phase and run in Phase 6 against /me with the
// Phase 6 test client. The format is the platform's evals/README.md: one YAML
// per task with prompt, server, max_turns, success_regexes, expected_tools and
// forbidden_tools. The repository has no YAML parser and gets none, so the
// top-level keys, the flow lists and the "- " entries are read with line
// patterns; that is enough for this fixed, flat format.

const TASKS_DIR = join(process.cwd(), 'evals', 'tasks');
const KEYS = [
  'prompt',
  'server',
  'max_turns',
  'success_regexes',
  'expected_tools',
  'forbidden_tools',
] as const;
const SIGN_IN_WORDS = /phone|sms|\bcode\b|otp|e-?mail|password/i;
const TOOL_NAMES: ReadonlySet<string> = new Set(
  productionTools.map((tool) => tool.name)
);

interface Task {
  file: string;
  /** Text of each top-level key, from the colon to the next top-level key, comments removed. */
  sections: Map<string, string>;
}

function parseTask(file: string): Task {
  const sections = new Map<string, string>();
  let key: string | null = null;
  let lines: string[] = [];
  const close = (): void => {
    if (key !== null) sections.set(key, lines.join('\n').trim());
  };
  for (const raw of readFileSync(join(TASKS_DIR, file), 'utf8').split('\n')) {
    if (/^\s*#/.test(raw)) continue;
    const top = /^([a-z_]+):(.*)$/.exec(raw);
    if (top !== null) {
      close();
      key = top[1] ?? null;
      lines = [(top[2] ?? '').replace(/\s+#.*$/, '')];
    } else if (key !== null) {
      lines.push(raw.replace(/\s+#.*$/, ''));
    }
  }
  close();
  return { file, sections };
}

function toolList(task: Task, key: string): string[] {
  return task.sections.get(key)?.match(/[a-z][a-z0-9_]*/g) ?? [];
}

function regexEntries(task: Task): string[] {
  const entries: string[] = [];
  for (const line of (task.sections.get('success_regexes') ?? '').split('\n')) {
    const entry = /^\s*-\s+(.*?)\s*$/.exec(line);
    if (entry === null) continue;
    const value = entry[1] ?? '';
    entries.push(value.replace(/^(['"])(.*)\1$/, '$2'));
  }
  return entries;
}

const FILES = readdirSync(TASKS_DIR).filter((name) => name.endsWith('.yaml'));
const TASKS = FILES.map(parseTask);

describe('evals/tasks', () => {
  it('holds at least one task', () => {
    expect(TASKS.length).toBeGreaterThan(0);
  });

  describe.each(TASKS.map((task) => [task.file, task] as const))(
    '%s',
    (_file, task) => {
      it('has the six keys of the platform format', () => {
        for (const key of KEYS) expect(task.sections.has(key)).toBe(true);
      });

      it('runs against /me', () => {
        expect(task.sections.get('server')).toBe('/me');
      });

      it('caps the turns at an integer from 1 to 20', () => {
        const turns = Number(task.sections.get('max_turns'));
        expect(Number.isInteger(turns)).toBe(true);
        expect(turns).toBeGreaterThanOrEqual(1);
        expect(turns).toBeLessThanOrEqual(20);
      });

      it('names only tools of the production registry', () => {
        for (const key of ['expected_tools', 'forbidden_tools']) {
          for (const name of toolList(task, key)) {
            expect(TOOL_NAMES.has(name)).toBe(true);
          }
        }
      });

      it('has success regexes that compile with the i flag', () => {
        const entries = regexEntries(task);
        expect(entries.length).toBeGreaterThan(0);
        for (const entry of entries) {
          expect(() => new RegExp(entry, 'i')).not.toThrow();
        }
      });

      it('asks nothing about the sign-in in its prompt', () => {
        const prompt = task.sections.get('prompt') ?? '';
        expect(prompt.length).toBeGreaterThan(0);
        expect(prompt).not.toMatch(SIGN_IN_WORDS);
      });
    }
  );

  it('keeps me_book among the expected tools of the two-people task', () => {
    const task = TASKS.find(
      (entry) => entry.file === 'me-two-people-side-by-side.yaml'
    );
    expect(task).toBeDefined();
    if (task !== undefined) {
      expect(toolList(task, 'expected_tools')).toContain('me_book');
    }
  });

  it('forbids all three write tools in the free-slot watch task, whose runs only read', () => {
    const task = TASKS.find(
      (entry) => entry.file === 'me-watch-for-a-free-slot.yaml'
    );
    expect(task).toBeDefined();
    if (task !== undefined) {
      const forbidden = toolList(task, 'forbidden_tools');
      for (const name of [
        'me_book',
        'me_reschedule_booking',
        'me_cancel_booking',
      ]) {
        expect(forbidden).toContain(name);
      }
      expect(toolList(task, 'expected_tools')).toContain('business_list_dates');
    }
  });
});
