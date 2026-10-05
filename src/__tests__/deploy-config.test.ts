import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from '@jest/globals';
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
  it('checks the built image before pushing and releasing', () => {
    expect(steps().map((candidate) => candidate.id)).toEqual([
      'build',
      'signed-https-gate',
      'push',
      'deploy-tagged',
    ]);
    expect(step('signed-https-gate')).toContain('scripts/image-gate.sh');
  });

  it('delegates the entire no-traffic rollout to the serialized release controller', () => {
    expect(deployArgs()).toContain('--no-traffic');
    expect(step('deploy-tagged')).toContain('scripts/release.py');
    expect(step('deploy-tagged')).toContain('$BUILD_ID');
    expect(step('deploy-tagged')).toContain('$COMMIT_SHA');
    expect(code).not.toContain('--clear-tags');
    expect(code).not.toContain('--to-latest');
    expect(read('scripts/release.py')).toContain("'etag': service['etag']");
    expect(read('scripts/release.py')).toContain(
      "entry.get('tag') != self.tag"
    );
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
    expect(flagValue('--min-instances')).toBe('0');
    expect(flagValue('--min')).toBe('1');
    expect(flagValue('--max')).toBe('1');
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
    expect(values.get('_TOKEN_SECRET')).toBe('MARKETPLACE_PARTNER_TOKEN');
    expect(values.get('_PROXY_KEY_SECRET')).toBe('MCP_PROXY_BACKEND_KEY_ME');
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
      'europe-west1-docker.pkg.dev/altegio-mcp/cloud-run/altegio-me-mcp'
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

// The one-time setup script (OPS-01, OPS-02, OPS-04, OPS-05). Nothing here
// reaches GCP: every run puts a stub `gcloud` first on PATH, so even a script
// bug cannot call the real one. --print must not call it at all.

const BOOTSTRAP = 'scripts/gcp/bootstrap.sh';
const OWNER = 'owner@example.invalid';
const BUILD_EMAIL = 'altegio-me-mcp-build@altegio-mcp.iam.gserviceaccount.com';
const RUNTIME_EMAIL =
  'altegio-me-mcp-runtime@altegio-mcp.iam.gserviceaccount.com';

const STUB_GCLOUD = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
args=" $* "
has() { case "$args" in *"$1"*) return 0 ;; esac; return 1; }
if has ' projects describe '; then echo altegio-mcp; exit 0; fi
if has ' services list '; then
  printf '%s\\n' run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com monitoring.googleapis.com logging.googleapis.com iam.googleapis.com
  exit 0
fi
if has ' artifacts repositories describe '; then echo cloud-run; exit 0; fi
if has ' builds connections describe '; then echo Altegio; exit 0; fi
if has ' secrets describe '; then echo secret; exit 0; fi
if has ' builds triggers describe '; then
  if [ -z "\${STUB_TRIGGER_SA:-}" ]; then exit 1; fi
  if has 'value(serviceAccount)'; then echo "$STUB_TRIGGER_SA"; else echo altegio-me-mcp-deploy; fi
  exit 0
fi
if has ' run services describe '; then
  if [ "\${STUB_SERVICE:-0}" != 1 ]; then exit 1; fi
  if has 'value(status.url)'; then echo https://altegio-me-mcp-abc-ew.a.run.app
  elif has '--format=json'; then echo '{"spec":{"template":{"spec":{"serviceAccountName":"${RUNTIME_EMAIL}"}}},"metadata":{"annotations":{"run.googleapis.com/invoker-iam-disabled": "true"}}}'
  else echo altegio-me-mcp; fi
  exit 0
fi
if has ' components list '; then
  if [ "\${STUB_BETA:-1}" = 0 ]; then echo 'Not Installed'; else echo Installed; fi
  exit 0
fi
if has ' monitoring channels list '; then
  if [ "\${STUB_CHANNEL:-0}" = 1 ]; then echo projects/altegio-mcp/notificationChannels/111; fi
  exit 0
fi
if has ' monitoring uptime create '; then touch "$STUB_STATE/check"; exit 0; fi
if has ' monitoring uptime list-configs '; then
  if has 'alert-drill' && [ -f "$STUB_STATE/check" ]; then echo projects/altegio-mcp/uptimeCheckConfigs/drill-1; fi
  exit 0
fi
if has ' monitoring policies create '; then
  if [ "\${STUB_POLICY_FAIL_ONCE:-0}" = 1 ] && [ ! -f "$STUB_STATE/policy-failed" ]; then
    touch "$STUB_STATE/policy-failed"
    echo 'ERROR: (gcloud.monitoring.policies.create) Projects instance [altegio-mcp] not found: Cannot find metric(s) that match type = "logging.googleapis.com/user/x".' >&2
    exit 1
  fi
  touch "$STUB_STATE/policy"; exit 0
fi
if has ' monitoring policies list '; then
  if has 'alert-drill' && [ -f "$STUB_STATE/policy" ]; then echo projects/altegio-mcp/alertPolicies/9; fi
  exit 0
fi
if has ' monitoring uptime delete '; then rm -f "$STUB_STATE/check"; exit 0; fi
if has ' monitoring policies delete '; then rm -f "$STUB_STATE/policy"; exit 0; fi
if has ' auth print-access-token '; then exit 1; fi
exit 0
`;

interface BootstrapRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The gcloud calls the stub saw, one per line; empty when none. */
  calls: string[];
}

interface BootstrapOptions {
  shell?: string;
  env?: Record<string, string>;
}

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runBootstrap(
  args: string[],
  options: BootstrapOptions = {}
): BootstrapRun {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-test-'));
  scratchDirs.push(dir);
  const bin = join(dir, 'bin');
  const state = join(dir, 'state');
  mkdirSync(bin);
  mkdirSync(state);
  const log = join(dir, 'gcloud.log');
  writeFileSync(join(bin, 'gcloud'), STUB_GCLOUD);
  chmodSync(join(bin, 'gcloud'), 0o755);
  const result = spawnSync(
    options.shell ?? 'bash',
    [join(ROOT, BOOTSTRAP), ...args],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: dir,
        STUB_LOG: log,
        STUB_STATE: state,
        BOOTSTRAP_DRILL_POLL_SECONDS: '0',
        BOOTSTRAP_DRILL_MAX_POLLS: '2',
        ...options.env,
      },
    }
  );
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
    : [];
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls,
  };
}

// A write verb is a whole word of the gcloud command, not a part of a name
// such as altegio-me-mcp-deploy.
const WRITE_VERB =
  /(^| )(create|update|delete|deploy|add-iam-policy-binding)( |$)/;

function printed(extra: string[] = []): string {
  const run = runBootstrap(['--print', '--owner-email', OWNER, ...extra]);
  expect(run.status).toBe(0);
  expect(run.calls).toEqual([]);
  return run.stdout;
}

/** The JSON policy files in a --print output. */
function printedPolicies(output: string): Record<string, unknown>[] {
  const blocks = output.match(/^\{\n[\s\S]*?^\}$/gm) ?? [];
  return blocks.map((block) => {
    const parsed: unknown = JSON.parse(block);
    expect(typeof parsed).toBe('object');
    return parsed as Record<string, unknown>;
  });
}

describe('scripts/gcp/bootstrap.sh file', () => {
  const script = read(BOOTSTRAP);

  it('starts with the env-based bash shebang and is strict', () => {
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(script).toContain('set -euo pipefail');
  });

  it('has its executable bit set', () => {
    expect(() =>
      accessSync(join(ROOT, BOOTSTRAP), constants.X_OK)
    ).not.toThrow();
  });

  it('contains no literal e-mail address and no secret value (T-03-37)', () => {
    expect(script).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    expect(script).not.toMatch(/\bBearer [A-Za-z0-9._-]{20,}/);
  });

  it('parses under the macOS bash 3.2 when /bin/bash exists', () => {
    if (!existsSync('/bin/bash')) {
      return;
    }
    const result = spawnSync('/bin/bash', ['-n', join(ROOT, BOOTSTRAP)], {
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('uses no bash 4 construct', () => {
    const code = script
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(
      /declare -A|mapfile|readarray|\$\{[a-z_]+(,,|\^\^)\}/
    );
  });
});

describe('scripts/gcp/bootstrap.sh --print', () => {
  it('prints the trigger on the build account with the ignored paths and the secret substitutions', () => {
    const output = printed();
    const trigger = output
      .split('\n')
      .find((line) => line.startsWith('gcloud builds triggers create github'));
    expect(trigger).toBeDefined();
    expect(trigger).toContain(
      `--service-account=projects/altegio-mcp/serviceAccounts/${BUILD_EMAIL}`
    );
    expect(trigger).toContain(
      '--repository=projects/altegio-mcp/locations/europe-west1/connections/Altegio/repositories/altegio-altegio-me-mcp'
    );
    expect(trigger).toContain("--branch-pattern='^main$'");
    expect(trigger).toContain('--build-config=cloudbuild.yaml');
    expect(trigger).toContain(
      "--ignored-files='docs/**,**/*.md,.github/**,scripts/**'"
    );
    expect(trigger).toContain(
      '--substitutions=_TOKEN_SECRET=MARKETPLACE_PARTNER_TOKEN,_PROXY_KEY_SECRET=MCP_PROXY_BACKEND_KEY_ME'
    );
  });

  it('links the repository under the id the platform asked for (owner-repo form)', () => {
    const link = printed()
      .split('\n')
      .find((line) => line.startsWith('gcloud builds repositories create'));
    expect(link).toBe(
      'gcloud builds repositories create altegio-altegio-me-mcp --remote-uri=https://github.com/altegio/altegio-me-mcp.git --connection=Altegio --region=europe-west1 --project=altegio-mcp'
    );
  });

  it('is identical under /bin/bash (3.2 on macOS) and the bash on PATH', () => {
    if (!existsSync('/bin/bash')) {
      return;
    }
    const args = ['--print', '--owner-email', OWNER, '--public-check'];
    const viaPath = runBootstrap(args);
    const viaBin = runBootstrap(args, { shell: '/bin/bash' });
    expect(viaBin.status).toBe(0);
    expect(viaBin.stdout).toBe(viaPath.stdout);
  });

  it('prints no command that reaches beyond the named resources (T-03-35)', () => {
    const output = printed(['--public-check']);
    expect(output).not.toMatch(/compute@developer/);
    expect(output).not.toContain('services enable');
    expect(output).not.toContain('logging buckets update');
    expect(output).not.toContain('allUsers');
    expect(output).not.toContain('allAuthenticatedUsers');
    expect(output).not.toContain('secrets versions access');
    expect(output).not.toContain('--allow-unauthenticated');
    expect(output).not.toContain('mcp-autoheal');
  });

  it('binds secretAccessor only for the runtime account and only on the two secrets (T-03-34)', () => {
    const lines = printed()
      .split('\n')
      .filter((line) => line.includes('secretAccessor'));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain(`--member=serviceAccount:${RUNTIME_EMAIL}`);
      expect(line).toMatch(
        /secrets add-iam-policy-binding (MARKETPLACE_PARTNER_TOKEN|MCP_PROXY_BACKEND_KEY_ME) /
      );
    }
    expect(printed()).not.toContain(
      `serviceAccount:${BUILD_EMAIL} --role=roles/secretmanager`
    );
  });

  it('gives the build account exactly the narrow roles of the IAM table', () => {
    const lines = printed()
      .split('\n')
      .filter((line) => line.includes(`serviceAccount:${BUILD_EMAIL}`));
    const roles = lines.map((line) => /--role=(\S+)/.exec(line)?.[1]).sort();
    expect(roles).toEqual([
      'roles/artifactregistry.writer',
      'roles/iam.serviceAccountUser',
      'roles/logging.logWriter',
      'roles/run.developer',
    ]);
    const logWriter = lines.find((line) => line.includes('logging.logWriter'));
    expect(logWriter).toContain('--condition=None');
    expect(logWriter).toContain('projects add-iam-policy-binding altegio-mcp');
    const runDeveloper = lines.find((line) => line.includes('run.developer'));
    expect(runDeveloper).toContain(
      'run services add-iam-policy-binding altegio-me-mcp'
    );
  });

  it('has exactly one gcloud run deploy, from the placeholder image, never our image', () => {
    const output = printed();
    const deploys = output
      .split('\n')
      .filter((line) => line.includes('gcloud run deploy'));
    expect(deploys).toHaveLength(1);
    expect(deploys[0]).toContain(
      '--image=us-docker.pkg.dev/cloudrun/container/hello'
    );
    expect(deploys[0]).toContain(`--service-account=${RUNTIME_EMAIL}`);
    expect(deploys[0]).toContain('--ingress=all');
    expect(deploys[0]).toContain('--no-invoker-iam-check');
    expect(output).not.toContain(
      'europe-west1-docker.pkg.dev/altegio-mcp/cloud-run/altegio-me-mcp'
    );
  });

  it('prints the invoker check, the label and the project on every write', () => {
    const writes = printed()
      .split('\n')
      .filter((line) => line.startsWith('gcloud '));
    expect(writes.length).toBeGreaterThan(10);
    for (const line of writes) {
      expect(line).toContain('--project=altegio-mcp');
    }
    expect(printed()).toContain('altegio_me_mcp_upstream_unauthorized');
    expect(printed()).toContain('altegio-me-mcp-health');
  });

  it('--token-secret changes both the runtime binding and the trigger substitution', () => {
    const output = printed(['--token-secret', 'ALTEGIO_API_TOKEN']);
    expect(output).toContain(
      'secrets add-iam-policy-binding ALTEGIO_API_TOKEN '
    );
    expect(output).toContain('_TOKEN_SECRET=ALTEGIO_API_TOKEN,');
    expect(output).not.toContain('MARKETPLACE_PARTNER_TOKEN');
  });

  it('--skip-secret-bindings prints no secret binding', () => {
    const output = printed(['--skip-secret-bindings']);
    expect(output).not.toContain('secretAccessor');
    expect(output).not.toContain('secrets add-iam-policy-binding');
  });

  it('prints every check at 5 minutes from three regions; the public check only with --public-check', () => {
    const without = printed();
    expect(without).not.toContain('altegio-me-mcp-public');
    const checks = without
      .split('\n')
      .filter((line) => line.includes('monitoring uptime create'));
    expect(checks).toHaveLength(1);

    const withPublic = printed(['--public-check']);
    const all = withPublic
      .split('\n')
      .filter((line) => line.includes('monitoring uptime create'));
    expect(all).toHaveLength(2);
    for (const line of all) {
      expect(line).toContain('--period=5');
      expect(line).toContain('--regions=europe,usa-iowa,asia-pacific');
    }
    const publicCheck = all.find((line) =>
      line.includes('altegio-me-mcp-public')
    );
    expect(publicCheck).toContain('--request-method=post');
    expect(publicCheck).toContain('mcp.alteg.io');
    expect(publicCheck).toContain('--path=/me');
    expect(publicCheck).toContain('tools/list');
    expect(publicCheck).toContain('Accept=application/json, text/event-stream');
    expect(publicCheck).toContain('--matcher-content=business_get');
    const health = all.find((line) => line.includes('altegio-me-mcp-health'));
    expect(health).toContain('--path=/health');
    expect(health).toContain('"status":"ok"');
  });

  it('gives every alert policy exactly one notification channel, the owner e-mail channel (T-03-36)', () => {
    const output = printed(['--public-check']);
    const policies = printedPolicies(output);
    expect(policies.map((policy) => policy.displayName)).toEqual([
      'altegio-me-mcp-down',
      'altegio-me-mcp-upstream-unauthorized',
      'altegio-me-mcp-upstream-rate-limited',
      'altegio-me-mcp-upstream-unavailable',
    ]);
    for (const policy of policies) {
      const channels = policy.notificationChannels;
      expect(Array.isArray(channels)).toBe(true);
      expect(channels).toHaveLength(1);
      expect(String((channels as unknown[])[0])).toMatch(
        /^projects\/altegio-mcp\/notificationChannels\/[A-Za-z0-9_]+$/
      );
    }
    const channelCreates = output
      .split('\n')
      .filter((line) => line.includes('monitoring channels create'));
    expect(channelCreates).toHaveLength(1);
    expect(channelCreates[0]).toMatch(
      /^gcloud beta monitoring channels create /
    );
    expect(channelCreates[0]).toContain('--type=email');
    expect(channelCreates[0]).toContain(`email_address=${OWNER}`);
  });

  it('compares every counter with GT, never GE, which the alerting API rejects', () => {
    const output = printed();
    expect(output).not.toContain('COMPARISON_GE');
    expect(output.match(/"comparison": "COMPARISON_GT"/g)).toHaveLength(4);
  });

  it('counts failing locations per host and fires on more than one (OPS-05 concurrency)', () => {
    const down = printedPolicies(printed(['--public-check']))[0];
    const text = JSON.stringify(down);
    expect(text).toContain('REDUCE_COUNT_FALSE');
    expect(text).toContain('COMPARISON_GT');
    expect(text).toContain('"thresholdValue":1');
    expect(text).toContain('resource.label.\\"host\\"');
    const conditions = (down as { conditions: unknown[] }).conditions;
    expect(conditions).toHaveLength(2);
  });

  it('feeds the three log-based metrics from mcp_call lines by upstream_kind', () => {
    const output = printed();
    for (const kind of ['unauthorized', 'rate_limited', 'unavailable']) {
      const line = output
        .split('\n')
        .find((candidate) =>
          candidate.includes(
            `logging metrics create altegio_me_mcp_upstream_${kind} `
          )
        );
      expect(line).toBeDefined();
      expect(line).toContain('resource.type="cloud_run_revision"');
      expect(line).toContain('resource.labels.service_name="altegio-me-mcp"');
      expect(line).toContain('jsonPayload.event="mcp_call"');
      expect(line).toContain(`jsonPayload.upstream_kind="${kind}"`);
    }
    const thresholds = printedPolicies(output)
      .slice(1)
      .map((policy) => JSON.stringify(policy));
    expect(thresholds[0]).toContain('"thresholdValue":2');
    expect(thresholds[0]).toContain('"alignmentPeriod":"300s"');
    expect(thresholds[1]).toContain('"thresholdValue":9');
    expect(thresholds[1]).toContain('"alignmentPeriod":"600s"');
    expect(thresholds[2]).toContain('"thresholdValue":9');
  });

  it('exits 2 with a usage line when --owner-email is missing, without calling gcloud', () => {
    for (const mode of ['--print', '--apply']) {
      const run = runBootstrap([mode]);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('usage: scripts/gcp/bootstrap.sh');
      expect(run.calls).toEqual([]);
    }
  });

  it('exits 2 on an unknown flag, a conflicting mode or a bad secret name', () => {
    expect(runBootstrap(['--bogus']).status).toBe(2);
    expect(
      runBootstrap(['--print', '--apply', '--owner-email', OWNER]).status
    ).toBe(2);
    expect(
      runBootstrap(['--print', '--owner-email', OWNER, '--token-secret', 'a b'])
        .status
    ).toBe(2);
    expect(
      runBootstrap(['--print', '--owner-email', 'not-an-address']).status
    ).toBe(2);
  });

  it('prints the drill commands with a 1 minute check and an impossible matcher', () => {
    const run = runBootstrap(['--drill', '--print']);
    expect(run.status).toBe(0);
    expect(run.calls).toEqual([]);
    const create = run.stdout
      .split('\n')
      .find((line) =>
        line.includes('monitoring uptime create altegio-me-mcp-alert-drill')
      );
    expect(create).toContain('--period=1');
    expect(create).toContain(
      '--matcher-content=drill-content-that-never-appears'
    );
    expect(run.stdout).toContain('monitoring policies delete');
    expect(run.stdout).toContain('monitoring uptime delete');
    const [policy] = printedPolicies(run.stdout);
    expect(
      (policy as { notificationChannels: unknown[] }).notificationChannels
    ).toHaveLength(1);
  });
});

describe('scripts/gcp/bootstrap.sh with a stubbed gcloud', () => {
  it('--plan blocks when the gcloud beta component is missing (monitoring channels is not GA)', () => {
    const run = runBootstrap(['--plan'], { env: { STUB_BETA: '0' } });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(
      'BLOCKER: gcloud beta component is Not Installed (needed by monitoring channels); run: gcloud components install beta'
    );
  });

  it('--plan reads only: no write command is ever issued', () => {
    const run = runBootstrap(['--plan'], {
      env: { STUB_CHANNEL: '1' },
    });
    expect(run.status).toBe(0);
    expect(run.calls.length).toBeGreaterThan(5);
    for (const call of run.calls) {
      expect(call).not.toMatch(WRITE_VERB);
    }
    expect(run.stdout).toContain('would run: gcloud run deploy altegio-me-mcp');
    expect(run.stdout).toContain('plan:');
  });

  it('--plan is the default mode', () => {
    const run = runBootstrap([]);
    expect(run.status).toBe(0);
    for (const call of run.calls) {
      expect(call).not.toMatch(WRITE_VERB);
    }
  });

  it('refuses a trigger that runs as the default compute account and writes nothing (T-03-33)', () => {
    const wrong =
      'projects/altegio-mcp/serviceAccounts/767969350727-compute@developer.gserviceaccount.com';
    for (const mode of ['--plan', '--apply']) {
      const run = runBootstrap([mode, '--owner-email', OWNER], {
        env: { STUB_TRIGGER_SA: wrong, STUB_CHANNEL: '1' },
      });
      expect(run.status).toBe(1);
      expect(run.stdout).toContain(
        'BLOCKER: trigger altegio-me-mcp-deploy runs as'
      );
      for (const call of run.calls) {
        expect(call).not.toMatch(WRITE_VERB);
      }
    }
  });

  it('refuses a trigger with no service account (the default Cloud Build account)', () => {
    const run = runBootstrap(['--apply', '--owner-email', OWNER], {
      env: { STUB_TRIGGER_SA: ' ', STUB_CHANNEL: '1' },
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('not as the build account');
  });

  it('--apply issues the printed writes and leaves a service that exists alone', () => {
    const run = runBootstrap(['--apply', '--owner-email', OWNER], {
      env: { STUB_CHANNEL: '1', STUB_SERVICE: '1' },
    });
    expect(run.status).toBe(0);
    const writes = run.calls.filter((call) => WRITE_VERB.test(call));
    expect(
      writes.some((call) =>
        call.startsWith('iam service-accounts create altegio-me-mcp-build')
      )
    ).toBe(true);
    expect(
      writes.some((call) => call.startsWith('builds triggers create github'))
    ).toBe(true);
    expect(writes.some((call) => call.startsWith('run deploy'))).toBe(false);
    for (const call of writes) {
      expect(call).toContain('--project=altegio-mcp');
      expect(call).not.toMatch(
        /compute@developer|allUsers|versions access|mcp-autoheal/
      );
    }
  });

  it('--apply waits for a new log-based metric to appear in Monitoring and retries the policy', () => {
    const run = runBootstrap(['--apply', '--owner-email', OWNER], {
      env: {
        STUB_CHANNEL: '1',
        STUB_SERVICE: '1',
        STUB_POLICY_FAIL_ONCE: '1',
        BOOTSTRAP_POLICY_RETRY_SECONDS: '0',
      },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      'waiting 0s for the log-based metric to appear in Monitoring (attempt 1 of 12)'
    );
    const creates = run.calls.filter((call) =>
      call.startsWith('monitoring policies create')
    );
    expect(creates).toHaveLength(5);
  });

  it('--apply creates the service from the placeholder only when it is missing', () => {
    const run = runBootstrap(['--apply', '--owner-email', OWNER], {
      env: { STUB_CHANNEL: '1', STUB_SERVICE: '0' },
    });
    expect(run.status).toBe(0);
    const deploys = run.calls.filter((call) => call.startsWith('run deploy'));
    expect(deploys).toHaveLength(1);
    expect(deploys[0]).toContain(
      '--image=us-docker.pkg.dev/cloudrun/container/hello'
    );
  });

  it('--drill creates its own check and policy, then deletes both; the real policy is untouched', () => {
    const run = runBootstrap(['--drill'], {
      env: { STUB_CHANNEL: '1', STUB_SERVICE: '1' },
    });
    expect(run.status).toBe(0);
    const writes = run.calls.filter((call) => WRITE_VERB.test(call));
    const kinds = writes.map((call) => call.split(' ').slice(0, 3).join(' '));
    expect(kinds).toEqual([
      'monitoring uptime create',
      'monitoring policies create',
      'monitoring policies delete',
      'monitoring uptime delete',
    ]);
    expect(writes[0]).toContain('altegio-me-mcp-alert-drill');
    expect(run.calls.join('\n')).not.toContain('altegio-me-mcp-down');
  });

  it('--drill-cleanup deletes leftovers and does nothing when there are none', () => {
    const none = runBootstrap(['--drill-cleanup'], {
      env: { STUB_CHANNEL: '1' },
    });
    expect(none.status).toBe(0);
    expect(none.calls.filter((call) => WRITE_VERB.test(call))).toEqual([]);
  });

  it('--drill stops when the owner channel does not exist', () => {
    const run = runBootstrap(['--drill'], { env: { STUB_CHANNEL: '0' } });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('does not exist');
    expect(run.calls.filter((call) => WRITE_VERB.test(call))).toEqual([]);
  });
});

// README "Deployed settings" versus the pipeline (DOC-02). The README table
// must carry the values of cloudbuild.yaml as exact strings, in backticks:
// "512Mi" is not "0.5Gi" and "60" is not "60s". The trigger is created by the
// bootstrap script and is named there, not in cloudbuild.yaml.

const README_TEXT = read('README.md');
const BOOTSTRAP_TEXT = read(BOOTSTRAP);

const SETTING_LABELS = [
  'Region',
  'Service',
  'Minimum instances',
  'Maximum instances',
  'CPU',
  'Memory',
  'Concurrency',
  'Request timeout',
  'Ingress',
  'Runtime account',
  'Trigger',
] as const;

/** The deployed settings as the pipeline and the bootstrap script define them. */
function pipelineSettings(
  cloudbuildText: string,
  bootstrapText: string
): Map<string, string> {
  const lines = cloudbuildText.split('\n');
  const values = new Map<string, string>();
  const subsAt = lines.indexOf('substitutions:');
  for (const line of subsAt === -1 ? [] : lines.slice(subsAt + 1)) {
    const match = /^ {2}(_[A-Z_]+): (.+)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      break;
    }
    values.set(match[1], match[2].trim());
  }
  const resolved = (text: string): string =>
    text.replace(
      /\$\{(_[A-Z_]+)\}/g,
      (whole, name: string) => values.get(name) ?? whole
    );

  const flags = new Map<string, string>();
  const deployAt = lines.indexOf('  - id: deploy-tagged');
  for (const line of deployAt === -1 ? [] : lines.slice(deployAt + 1)) {
    if (/^ {2}- id: /.test(line)) {
      break;
    }
    const match = /^ {6}- (--[a-z-]+)=(.+)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      flags.set(match[1], resolved(match[2].trim()));
    }
  }

  const project = /^PROJECT=(\S+)$/m.exec(bootstrapText)?.[1];
  const account = flags.get('--service-account');
  const settings = new Map<string, string>();
  const put = (label: string, value: string | undefined): void => {
    if (value !== undefined) {
      settings.set(label, value);
    }
  };
  put('Region', flags.get('--region'));
  put('Service', values.get('_SERVICE'));
  put('Minimum instances', flags.get('--min-instances'));
  put('Maximum instances', flags.get('--max-instances'));
  put('CPU', flags.get('--cpu'));
  put('Memory', flags.get('--memory'));
  put('Concurrency', flags.get('--concurrency'));
  put('Request timeout', flags.get('--timeout'));
  put('Ingress', flags.get('--ingress'));
  put(
    'Runtime account',
    account !== undefined && project !== undefined
      ? account.replace('$PROJECT_ID', project)
      : undefined
  );
  put('Trigger', /^TRIGGER=(\S+)$/m.exec(bootstrapText)?.[1]);
  return settings;
}

function readmeSection(readme: string, heading: string): string {
  const start = readme.indexOf(`\n${heading}\n`);
  if (start === -1) {
    return '';
  }
  const rest = readme.slice(start + heading.length + 2);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Label to backticked value for the rows of the Deployed settings table. */
function readmeSettings(readme: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of readmeSection(readme, '## Deploy').split('\n')) {
    const match = /^\|\s*([^|`]+?)\s*\|\s*`([^`]+)`\s*\|/.exec(line);
    if (
      match?.[1] !== undefined &&
      match[2] !== undefined &&
      !rows.has(match[1])
    ) {
      rows.set(match[1], match[2]);
    }
  }
  return rows;
}

/** One line per setting whose README value is missing or not the pipeline's exact string. */
function settingsMismatches(
  readme: string,
  cloudbuildText: string,
  bootstrapText: string
): string[] {
  const expected = pipelineSettings(cloudbuildText, bootstrapText);
  const actual = readmeSettings(readme);
  const problems: string[] = [];
  for (const label of SETTING_LABELS) {
    const want = expected.get(label);
    const got = actual.get(label);
    if (want === undefined) {
      problems.push(`${label}: not found in the pipeline`);
    } else if (got === undefined) {
      problems.push(`${label}: missing from the README table`);
    } else if (got !== want) {
      problems.push(`${label}: README has ${got}, pipeline has ${want}`);
    }
  }
  return problems;
}

/** A README Deploy section built from the pipeline itself, for the comparison unit tests. */
function readmeFrom(settings: Map<string, string>): string {
  const rows = [...settings.entries()].map(
    ([label, value]) => `| ${label} | \`${value}\` | note |`
  );
  return ['', '## Deploy', '', '| Setting | Value | Note |', '|---|---|---|']
    .concat(rows, ['', '## Cost estimate', ''])
    .join('\n');
}

describe('README Deployed settings (DOC-02)', () => {
  it('has a row in the table for every setting the pipeline fixes', () => {
    const settings = pipelineSettings(cloudbuild, BOOTSTRAP_TEXT);
    expect([...settings.keys()].sort()).toEqual([...SETTING_LABELS].sort());
  });

  it('carries exactly the values of cloudbuild.yaml and the bootstrap script', () => {
    expect(settingsMismatches(README_TEXT, cloudbuild, BOOTSTRAP_TEXT)).toEqual(
      []
    );
  });

  it('passes on a README built from the pipeline itself', () => {
    const fake = readmeFrom(pipelineSettings(cloudbuild, BOOTSTRAP_TEXT));
    expect(settingsMismatches(fake, cloudbuild, BOOTSTRAP_TEXT)).toEqual([]);
  });

  it('fails when the pipeline memory changes and the README does not', () => {
    const fake = readmeFrom(pipelineSettings(cloudbuild, BOOTSTRAP_TEXT));
    const changed = cloudbuild.replace('--memory=512Mi', '--memory=1Gi');
    expect(changed).not.toBe(cloudbuild);
    expect(settingsMismatches(fake, changed, BOOTSTRAP_TEXT)).toEqual([
      'Memory: README has 512Mi, pipeline has 1Gi',
    ]);
  });

  it('compares exact strings, with no unit conversion or rounding (OPS-01 precision)', () => {
    const settings = pipelineSettings(cloudbuild, BOOTSTRAP_TEXT);
    const converted = new Map(settings);
    converted.set('Memory', '0.5Gi');
    converted.set('Request timeout', '60s');
    converted.set('CPU', '1.0');
    expect(
      settingsMismatches(readmeFrom(converted), cloudbuild, BOOTSTRAP_TEXT)
    ).toEqual([
      'CPU: README has 1.0, pipeline has 1',
      'Memory: README has 0.5Gi, pipeline has 512Mi',
      'Request timeout: README has 60s, pipeline has 60',
    ]);
  });

  it('reports a row that is missing from the README', () => {
    const settings = pipelineSettings(cloudbuild, BOOTSTRAP_TEXT);
    settings.delete('Ingress');
    expect(
      settingsMismatches(readmeFrom(settings), cloudbuild, BOOTSTRAP_TEXT)
    ).toEqual(['Ingress: missing from the README table']);
  });

  it('reports a trigger name that differs from the bootstrap script', () => {
    const fake = readmeFrom(pipelineSettings(cloudbuild, BOOTSTRAP_TEXT));
    const renamed = BOOTSTRAP_TEXT.replace(
      'TRIGGER=altegio-me-mcp-deploy',
      'TRIGGER=other-trigger'
    );
    expect(renamed).not.toBe(BOOTSTRAP_TEXT);
    expect(settingsMismatches(fake, cloudbuild, renamed)).toEqual([
      'Trigger: README has altegio-me-mcp-deploy, pipeline has other-trigger',
    ]);
  });
});

describe('README Deploy and Cost estimate text (DOC-02)', () => {
  const deploy = readmeSection(README_TEXT, '## Deploy');
  const cost = readmeSection(README_TEXT, '## Cost estimate');

  it.each([
    'altegio-me-mcp-deploy',
    'altegio-mcp',
    'europe-west1',
    'https://mcp.alteg.io/me',
    'Deployed settings',
  ])('names %s in the Deploy section', (fragment) => {
    expect(deploy).toContain(fragment);
  });

  it('states that the bootstrap placeholder service is the only deploy outside the trigger', () => {
    expect(deploy).toContain('scripts/gcp/bootstrap.sh');
    expect(deploy).toMatch(/only deploy outside the (Cloud Build )?trigger/i);
  });

  it('states whether the first deploy has happened', () => {
    expect(deploy).toMatch(/^Status: /m);
  });

  it('gives an expected and a peak column, an uptime-check row and the price date and sources', () => {
    expect(cost).toMatch(/^\|[^\n]*Expected[^\n]*\|[^\n]*Peak[^\n]*\|$/m);
    expect(cost).toMatch(/^\|\s*Uptime checks[^\n]*\|$/m);
    expect(cost).toMatch(/^Prices read on \d{4}-\d{2}-\d{2} from /m);
    expect(cost).toContain('https://cloud.google.com/run/pricing');
  });
});
