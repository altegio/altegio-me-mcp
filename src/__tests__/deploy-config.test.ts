import { accessSync, constants, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { TOOL_DEADLINE_MS } from '../tools/context.js';

// Static checks of the deploy pipeline (OPS-02, OPS-01, OPS-04). Nothing here
// talks to GCP: it reads cloudbuild.yaml and scripts/smoke-url.sh through
// process.cwd() and fails when a safety property of the pipeline is edited
// away. The YAML is read by lines and regexes, as the repo-config tests do.

const ROOT = process.cwd();

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

const cloudbuild = read('cloudbuild.yaml');
const cloudbuildLines = cloudbuild.split('\n');
// Comments are documentation: a check for a forbidden flag must not trip on a
// sentence that explains why the flag is absent.
const codeLines = cloudbuildLines.filter(
  (line) => !line.trim().startsWith('#')
);
const code = codeLines.join('\n');

/** The user-defined substitutions with their default values. */
function substitutions(): Map<string, string> {
  const start = cloudbuildLines.indexOf('substitutions:');
  expect(start).toBeGreaterThan(-1);
  const found = new Map<string, string>();
  for (const line of cloudbuildLines.slice(start + 1)) {
    const match = /^ {2}(_[A-Z_]+): (.+)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      break;
    }
    found.set(match[1], match[2].trim());
  }
  return found;
}

/** Replace ${_NAME} with its default, as Cloud Build does when the trigger sets none. */
function resolve(text: string): string {
  const values = substitutions();
  return text.replace(/\$\{(_[A-Z_]+)\}/g, (whole, name: string) => {
    return values.get(name) ?? whole;
  });
}

interface Step {
  id: string;
  text: string;
}

function steps(): Step[] {
  const result: Step[] = [];
  const stepsAt = cloudbuildLines.indexOf('steps:');
  expect(stepsAt).toBeGreaterThan(-1);
  for (const line of cloudbuildLines.slice(stepsAt + 1)) {
    if (/^\S/.test(line)) {
      break;
    }
    const start = /^ {2}- id: (\S+)$/.exec(line);
    if (start?.[1] !== undefined) {
      result.push({ id: start[1], text: line });
    } else if (result.length > 0 && !line.trim().startsWith('#')) {
      const last = result[result.length - 1];
      if (last !== undefined) {
        last.text += `\n${line}`;
      }
    }
  }
  return result;
}

function step(id: string): string {
  const found = steps().find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found?.text ?? '';
}

/** The `- --flag` argument lines of the deploy step, resolved. */
function deployArgs(): string[] {
  return step('deploy-tagged')
    .split('\n')
    .map((line) => /^ {6}- (.+)$/.exec(line)?.[1])
    .filter((arg): arg is string => arg !== undefined)
    .map(resolve);
}

function flagValue(flag: string): string | undefined {
  const arg = deployArgs().find((candidate) =>
    candidate.startsWith(`${flag}=`)
  );
  return arg?.slice(flag.length + 1);
}

function envVars(): Map<string, string> {
  const value = flagValue('--set-env-vars') ?? '';
  const result = new Map<string, string>();
  for (const pair of value.split(',')) {
    const at = pair.indexOf('=');
    result.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return result;
}

describe('cloudbuild.yaml steps', () => {
  it('runs build, push, clear-stale-tags, deploy-tagged, smoke-tagged, shift, untag in that order', () => {
    expect(steps().map((candidate) => candidate.id)).toEqual([
      'build',
      'push',
      'clear-stale-tags',
      'deploy-tagged',
      'smoke-tagged',
      'shift',
      'untag',
    ]);
  });

  it('deploys without traffic under a tag derived from the commit', () => {
    const args = deployArgs();
    expect(args).toContain('--no-traffic');
    expect(args).toContain('--tag=b$SHORT_SHA');
  });

  it('clears stale tags before the deploy and removes its own tag after the shift', () => {
    expect(step('clear-stale-tags')).toContain('--clear-tags');
    expect(step('untag')).toContain('--remove-tags=b$SHORT_SHA');
  });

  it('smoke-tests the tagged URL with scripts/smoke-url.sh and the build commit', () => {
    const smoke = step('smoke-tagged');
    expect(smoke).toContain('bash scripts/smoke-url.sh');
    expect(smoke).toContain('"$COMMIT_SHA"');
    expect(smoke).toContain('TAG=b$SHORT_SHA');
  });

  it('moves traffic only in the shift step, and only to the build tag', () => {
    const shift = step('shift');
    expect(shift).toContain('--to-tags=$$TAG=100');
    for (const candidate of steps()) {
      if (candidate.id !== 'shift') {
        expect(candidate.text).not.toContain('--to-tags');
        expect(candidate.text).not.toContain('--to-latest');
        expect(candidate.text).not.toContain('--to-revisions');
      }
    }
  });

  it('guards the shift: only the latest created revision may take traffic', () => {
    const shift = step('shift');
    expect(shift).toContain('latestCreatedRevisionName');
    const guardAt = shift.indexOf('latestCreatedRevisionName');
    const shiftAt = shift.indexOf('update-traffic');
    expect(guardAt).toBeGreaterThan(-1);
    expect(shiftAt).toBeGreaterThan(guardAt);
    expect(shift).toContain('sys.exit(');
  });

  it('fails the build on a shell error in the script steps', () => {
    for (const id of ['smoke-tagged', 'shift']) {
      expect(step(id)).toMatch(/- -euo\n\s+- pipefail\n\s+- -c/);
    }
  });

  it('writes logs to Cloud Logging only and bounds the build time', () => {
    expect(code).toMatch(/^options:\n {2}logging: CLOUD_LOGGING_ONLY$/m);
    expect(code).toMatch(/^timeout: \d+s$/m);
  });
});

describe('cloudbuild.yaml deploy flags', () => {
  it('runs as the narrow runtime service account on every deploy', () => {
    expect(flagValue('--service-account')).toBe(
      'altegio-me-mcp-runtime@$PROJECT_ID.iam.gserviceaccount.com'
    );
    const deploys = (code.match(/^\s+- deploy$/gm) ?? []).length;
    const accounts = (code.match(/--service-account=/g) ?? []).length;
    expect(deploys).toBe(1);
    expect(accounts).toBe(deploys);
  });

  it('pins region, ingress, instances, size, concurrency, boost, CPU mode and label (OPS-01)', () => {
    const args = deployArgs();
    expect(flagValue('--region')).toBe('europe-west1');
    expect(flagValue('--ingress')).toBe('all');
    expect(flagValue('--min-instances')).toBe('1');
    expect(flagValue('--max-instances')).toBe('1');
    expect(flagValue('--cpu')).toBe('1');
    expect(flagValue('--memory')).toBe('512Mi');
    expect(flagValue('--concurrency')).toBe('80');
    expect(flagValue('--timeout')).toBe('60');
    expect(flagValue('--labels')).toBe('app=altegio-me-mcp');
    expect(args).toContain('--cpu-boost');
    expect(args).toContain('--cpu-throttling');
  });

  it('declares the production environment (D-04)', () => {
    const env = envVars();
    expect(env.get('NODE_ENV')).toBe('production');
    expect(env.get('PUBLIC_BASE_URL')).toBe('https://mcp.alteg.io/me');
    expect(env.get('LOG_LEVEL')).toBe('info');
    expect(env.get('COMMIT_SHA')).toBe('$COMMIT_SHA');
    expect(env.get('ALTEGIO_API_TOKEN_FILE')).toBe(
      '/secrets/altegio-api/token'
    );
    expect(env.get('MCP_PROXY_BACKEND_KEY_FILE')).toBe(
      '/secrets/proxy-key/key'
    );
  });

  it('keeps Cloud Run request timeout above the tool deadline', () => {
    const timeoutSeconds = Number(flagValue('--timeout'));
    expect(Number.isFinite(timeoutSeconds)).toBe(true);
    expect(TOOL_DEADLINE_MS / 1000).toBeLessThan(timeoutSeconds);
  });
});

describe('cloudbuild.yaml secrets (OPS-04)', () => {
  it('has no --set-env-vars name that suggests a secret, except the two *_FILE paths', () => {
    const allowed = new Set([
      'ALTEGIO_API_TOKEN_FILE',
      'MCP_PROXY_BACKEND_KEY_FILE',
    ]);
    for (const name of envVars().keys()) {
      if (/TOKEN|SECRET|KEY|PASSWORD/i.test(name)) {
        expect(allowed.has(name)).toBe(true);
      }
    }
  });

  it('mounts the secrets at exactly the paths the *_FILE variables name', () => {
    const mounts = (flagValue('--set-secrets') ?? '')
      .split(',')
      .map((entry) => entry.split('='));
    const env = envVars();
    expect(mounts.map(([path]) => path).sort()).toEqual(
      [
        env.get('ALTEGIO_API_TOKEN_FILE'),
        env.get('MCP_PROXY_BACKEND_KEY_FILE'),
      ].sort()
    );
  });

  it('mounts the latest version of the two secrets, named by substitutions with the platform defaults', () => {
    const raw = step('deploy-tagged')
      .split('\n')
      .find((line) => line.includes('--set-secrets='));
    expect(raw).toContain('/secrets/altegio-api/token=${_TOKEN_SECRET}:latest');
    expect(raw).toContain('/secrets/proxy-key/key=${_PROXY_KEY_SECRET}:latest');
    const values = substitutions();
    expect(values.get('_TOKEN_SECRET')).toBe('ALTEGIO_API_TOKEN');
    expect(values.get('_PROXY_KEY_SECRET')).toBe('MCP_PROXY_BACKEND_KEY');
  });

  it('never pulls a secret into an environment variable', () => {
    expect(code).not.toContain('--update-secrets');
    expect(code).not.toContain('secretKeyRef');
    expect(code).not.toMatch(/--set-secrets=[A-Z_]+=/);
    expect(code).not.toContain('availableSecrets');
    expect(code).not.toContain('secretEnv');
    expect(code).not.toContain('--substitutions');
  });
});

describe('cloudbuild.yaml identity and registry (T-03-31, T-03-32)', () => {
  it('never makes the service public and leaves the invoker check to the bootstrap', () => {
    expect(code).not.toContain('allUsers');
    expect(code).not.toContain('--allow-unauthenticated');
    expect(code).not.toMatch(/invoker-iam/);
    expect(code).not.toContain('add-iam-policy-binding');
  });

  it('never builds, pushes or deploys a :latest image', () => {
    expect(substitutions().get('_IMAGE')).not.toMatch(/:/);
    for (const line of codeLines) {
      if (line.includes(':latest')) {
        // Only a secret version may be "latest".
        expect(line).toContain('--set-secrets=');
      }
    }
    for (const id of ['build', 'push']) {
      expect(step(id)).toContain('${_IMAGE}:$SHORT_SHA');
    }
    expect(flagValue('--image')).toMatch(/:\$SHORT_SHA$/);
  });

  it('pushes into the shared cloud-run repository of the build project', () => {
    expect(substitutions().get('_IMAGE')).toBe(
      'europe-west1-docker.pkg.dev/$PROJECT_ID/cloud-run/altegio-me-mcp'
    );
    expect((code.match(/^\s+args: \[push, /gm) ?? []).length).toBe(1);
  });

  it('runs gcloud from a version-pinned cloud-sdk image', () => {
    const images = codeLines
      .map((line) =>
        /name: (gcr\.io\/google\.com\/cloudsdktool\/\S+)$/.exec(line)
      )
      .map((match) => match?.[1])
      .filter((image): image is string => image !== undefined);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image).toMatch(/:\d+\.\d+\.\d+$/);
    }
  });
});

describe('scripts/smoke-url.sh', () => {
  const script = read('scripts/smoke-url.sh');
  const scriptCode = script
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

  it('starts with the env-based bash shebang and is strict', () => {
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(script).toContain('set -euo pipefail');
  });

  it('has its executable bit set', () => {
    expect(() =>
      accessSync(join(ROOT, 'scripts/smoke-url.sh'), constants.X_OK)
    ).not.toThrow();
  });

  it('uses curl only and never calls jq', () => {
    expect(scriptCode).toContain('curl ');
    expect(scriptCode).not.toMatch(/(^|[\s|;(&])jq(\s|$)/m);
  });

  it.each([
    '--public',
    '/health',
    'proxy_auth_required',
    'business_get',
    'mcp-session-id',
    '/.well-known/oauth-protected-resource/me',
    'PASS smoke-url:',
    'FAIL:',
  ])('contains %s', (fragment) => {
    expect(script).toContain(fragment);
  });
});
