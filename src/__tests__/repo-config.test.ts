import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';

// Structural tests for the delivery files. They read the repository files
// through process.cwd() (D-07) and check what a reviewer would otherwise have
// to check by eye: the image is non-root and secret-free, the smoke script is
// strict, and the files that CI and the ruleset depend on keep their shape.

const ROOT = process.cwd();

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

function lines(text: string): string[] {
  return text.split('\n').map((line) => line.trim());
}

describe('Dockerfile', () => {
  const dockerfile = read('Dockerfile');
  const dockerLines = lines(dockerfile);
  const instructions = dockerLines.filter(
    (line) => line !== '' && !line.startsWith('#')
  );

  it('has exactly two stages, both node:22-alpine pinned to one digest (D-08, IN-03)', () => {
    const from = instructions.filter((line) => line.startsWith('FROM '));
    expect(from).toHaveLength(2);
    const digests: string[] = [];
    const stages: string[] = [];
    for (const line of from) {
      const match =
        /^FROM node:22-alpine@(sha256:[0-9a-f]{64}) AS (build|runtime)$/.exec(
          line
        );
      expect(match).not.toBeNull();
      digests.push(match?.[1] ?? '');
      stages.push(match?.[2] ?? '');
    }
    expect(stages).toEqual(['build', 'runtime']);
    expect(new Set(digests).size).toBe(1);
  });

  it('configures the runtime stage as a non-root production server', () => {
    const lastFrom = instructions.findLastIndex((line) =>
      line.startsWith('FROM ')
    );
    const runtime = instructions.slice(lastFrom);
    expect(runtime).toContain('ENV NODE_ENV=production');
    expect(runtime).toContain('USER node');
    expect(runtime).toContain('EXPOSE 8080');
    expect(runtime).toContain('CMD ["node", "dist/server.js"]');
  });

  it('runs every npm ci without lifecycle scripts, and the runtime one without dev dependencies', () => {
    const installs = instructions.filter((line) => line.includes('npm ci'));
    expect(installs).toHaveLength(2);
    for (const install of installs) {
      expect(install).toContain('--ignore-scripts');
    }
    const runtimeInstall = installs.find((line) => line.includes('--omit=dev'));
    expect(runtimeInstall).toBeDefined();
  });

  it('builds with the repository build script', () => {
    expect(instructions).toContain('RUN npm run build');
  });

  it('declares no ARG and no ENV whose name suggests a secret (SEC-03)', () => {
    const declarations = instructions.filter(
      (line) => line.startsWith('ARG ') || line.startsWith('ENV ')
    );
    expect(declarations.length).toBeGreaterThan(0);
    for (const declaration of declarations) {
      expect(declaration).not.toMatch(/TOKEN|SECRET|KEY|PASSWORD/i);
    }
  });

  it('never copies a .env file into the image', () => {
    const copies = instructions.filter(
      (line) => line.startsWith('COPY ') || line.startsWith('ADD ')
    );
    for (const copy of copies) {
      expect(copy).not.toMatch(/\.env/);
    }
  });
});

describe('.dockerignore', () => {
  const entries = lines(read('.dockerignore'));

  it.each([
    '.env',
    '.env.*',
    '.git',
    '.planning',
    '.claude',
    'node_modules',
    '**/__tests__',
  ])('lists %s', (entry) => {
    expect(entries).toContain(entry);
  });
});

describe('scripts/smoke.sh', () => {
  const smoke = read('scripts/smoke.sh');

  it('starts with the env-based bash shebang', () => {
    expect(smoke.startsWith('#!/usr/bin/env bash\n')).toBe(true);
  });

  it.each([
    'set -euo pipefail',
    'mcp-session-id',
    'docker stop -t 10',
    'CANARY_TOKEN',
    'ALTEGIO_API_TOKEN=',
  ])('contains %s', (fragment) => {
    expect(smoke).toContain(fragment);
  });

  it('passes the canary token as ALTEGIO_API_TOKEN (D-01)', () => {
    expect(smoke).toContain('-e ALTEGIO_API_TOKEN="$CANARY_TOKEN"');
  });

  it.each([
    'x-mcp-proxy-auth',
    'MCP_PROXY_BACKEND_KEY_FILE',
    'proxy_auth_required',
    'docker inspect',
  ])('exercises the proxy check: contains %s (OPS-03)', (fragment) => {
    expect(smoke).toContain(fragment);
  });

  it('checks that /health reports the COMMIT_SHA the container was given', () => {
    expect(smoke).toContain('-e COMMIT_SHA="$COMMIT_VALUE"');
    expect(smoke).toContain('.commit == $c');
  });

  it('checks that the image config declares no secret-named variable', () => {
    expect(smoke).toContain(
      'docker inspect --format \'{{json .Config.Env}}\' "$IMAGE"'
    );
    expect(smoke).toContain('TOKEN|SECRET|KEY|PASSWORD');
  });

  it('checks that neither the canary token nor the canary key reaches the logs', () => {
    expect(smoke).toContain('grep -qF "$CANARY_TOKEN"');
    expect(smoke).toContain('grep -qF "$PROXY_KEY"');
  });

  it('checks that the unsigned refusal is logged with its auth_reason', () => {
    expect(smoke).toContain('"auth_reason":"missing"');
  });

  it('has its executable bit set', () => {
    expect(() =>
      accessSync(join(ROOT, 'scripts/smoke.sh'), constants.X_OK)
    ).not.toThrow();
  });

  it('has the URL smoke script next to it, executable as well', () => {
    expect(() =>
      accessSync(join(ROOT, 'scripts/smoke-url.sh'), constants.X_OK)
    ).not.toThrow();
  });
});

describe('.github/workflows/ci.yml', () => {
  const workflow = read('.github/workflows/ci.yml');
  const workflowLines = workflow.split('\n');

  it('runs on pull requests to main and on pushes to main', () => {
    expect(workflow).toMatch(/^ {2}pull_request:\n {4}branches: \[main\]$/m);
    expect(workflow).toMatch(/^ {2}push:\n {4}branches: \[main\]$/m);
  });

  it('has the single job test, without a matrix (D-08)', () => {
    const jobsAt = workflowLines.indexOf('jobs:');
    expect(jobsAt).toBeGreaterThan(-1);
    const jobKeys = workflowLines
      .slice(jobsAt + 1)
      .filter((line) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line))
      .map((line) => line.trim());
    expect(jobKeys).toEqual(['test:']);
    expect(workflow).not.toContain('matrix:');
    expect(workflow).not.toContain('strategy:');
    expect(workflowLines).not.toContain('    name: test');
  });

  it('lists the steps in the documented order', () => {
    const names = workflowLines
      .filter((line) => /^ {6}- name: /.test(line))
      .map((line) => line.replace(/^ {6}- name: /, '').trim());
    expect(names).toEqual([
      'Checkout',
      'Set up Node',
      'Install',
      'Conventional commits',
      'Release order',
      'Release race and rollback tests',
      'Lint',
      'Format',
      'Typecheck',
      'Unit tests',
      'Build',
      'Docker build',
      'Container smoke test',
      'Dependency audit',
    ]);
  });

  it('ends with the dependency audit', () => {
    const steps = workflow.split(/^ {6}- name: /m);
    const last = steps[steps.length - 1] ?? '';
    expect(last).toContain('npm audit --audit-level=high');
  });

  it('runs the smoke script against the image it just built', () => {
    expect(workflow).toContain('docker build -t altegio-me-mcp:ci .');
    expect(workflow).toContain('bash scripts/smoke.sh altegio-me-mcp:ci');
  });

  it('lints the pull request commits and title with commitlint', () => {
    expect(workflow).toContain('npx commitlint --from "$BASE" --to "$HEAD"');
    expect(workflow).toContain("if: github.event_name == 'pull_request'");
  });

  it('puts pull request fields only into env assignments (T-1-27)', () => {
    const uses = workflowLines.filter((line) =>
      line.includes('${{ github.event.pull_request')
    );
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const line of uses) {
      expect(line).toMatch(
        /^\s+[A-Z_]+: \$\{\{ github\.event\.pull_request\.[a-z_.]+ \}\}$/
      );
    }
  });

  it('uses read-only permissions, full history and the .nvmrc Node version', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(workflow).toContain('node-version-file: .nvmrc');
    expect(workflow).toContain('fetch-depth: 0');
    expect(read('.nvmrc').trim()).toBe('22');
  });

  it('uses only first-party actions (T-1-28)', () => {
    const uses = workflowLines
      .filter((line) => line.includes('uses:'))
      .map((line) => line.replace(/^.*uses:\s*/, '').trim());
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action).toMatch(/^actions\/[a-z-]+@v\d+$/);
    }
  });

  it('never turns on the live suite (ALTEGIO_E2E stays out of CI)', () => {
    expect(workflow).not.toContain('ALTEGIO_E2E');
  });
});

describe('live suite script', () => {
  const scripts = (
    JSON.parse(read('package.json')) as { scripts: Record<string, string> }
  ).scripts;

  it('test:live sets ALTEGIO_E2E=1 and loads the local .env', () => {
    const testLive = scripts['test:live'] ?? '';
    expect(testLive).toContain('ALTEGIO_E2E=1');
    expect(testLive).toContain('--env-file=.env');
  });

  it('the required test and check scripts do not turn on the live suite', () => {
    expect(scripts.test).not.toContain('ALTEGIO_E2E');
    expect(scripts.check).not.toContain('ALTEGIO_E2E');
  });
});

describe('commitlint', () => {
  const COMMITLINT = join(ROOT, 'node_modules/.bin/commitlint');
  const TIMEOUT_MS = 30_000;

  function lint(message: string): number | null {
    const result = spawnSync(COMMITLINT, [], {
      cwd: ROOT,
      input: message,
      encoding: 'utf8',
    });
    return result.status;
  }

  const longBody = 'x'.repeat(130);
  const trailer = 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>';

  it.each([
    ['a plain feature', 'feat: add thing\n'],
    ['a plan-scoped docs commit', 'docs(01-01): complete plan summary\n'],
    [
      'a 130-character body line and a trailer',
      `feat: add thing\n\n${longBody}\n\n${trailer}\n`,
    ],
    [
      'an executor worktree merge',
      'chore: merge executor worktree (worktree-agent-abc123)\n',
    ],
  ])(
    'accepts %s',
    (_label, message) => {
      expect(lint(message)).toBe(0);
    },
    TIMEOUT_MS
  );

  it.each([
    ['a message without a type', 'Update stuff\n'],
    ['a capitalised subject', 'feat(server): Add Thing\n'],
    ['a header over 100 characters', `feat: ${'a'.repeat(100)}\n`],
  ])(
    'rejects %s',
    (_label, message) => {
      expect(lint(message)).not.toBe(0);
    },
    TIMEOUT_MS
  );

  it('switches off the body and footer line limits only', () => {
    const config = read('commitlint.config.js');
    expect(config).toContain('@commitlint/config-conventional');
    expect(config).toContain("'body-max-line-length': [0]");
    expect(config).toContain("'footer-max-line-length': [0]");
  });
});

describe('husky hooks', () => {
  it('checks commit messages with commitlint', () => {
    expect(read('.husky/commit-msg')).toContain('commitlint --edit');
  });

  it('runs lint-staged before a commit', () => {
    expect(read('.husky/pre-commit')).toContain('lint-staged');
  });
});

describe('.github/rulesets/main-ci-gate.json', () => {
  const ruleset: unknown = JSON.parse(
    read('.github/rulesets/main-ci-gate.json')
  );

  it('matches the Altegio default-branch CI gate definition', () => {
    expect(ruleset).toEqual({
      name: 'default-branch-ci-gate',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [
        { type: 'deletion' },
        { type: 'non_fast_forward' },
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 0,
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_review_thread_resolution: false,
          },
        },
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: [
              { context: 'test', integration_id: 15368 },
            ],
          },
        },
      ],
      bypass_actors: [
        { actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' },
      ],
    });
  });
});
