import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { PROXY_AUTH_HEADER } from '../security/proxy-auth.js';
import { PACKAGE_VERSION } from '../util/package-metadata.js';
import { signProxyRequest } from './helpers/sign-request.js';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const CANARY = 'canary-partner-token-5c1e9d27a4b8';
const SHUTDOWN_WINDOW_MS = 10_000;
const TEST_TIMEOUT_MS = 20_000;

interface ExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface RunningServer {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  firstStdoutLine: () => Promise<string>;
  exited: Promise<ExitStatus>;
}

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function envExampleValues(): Record<string, string> {
  return parseDotenv(readFileSync(join(ROOT, '.env.example'), 'utf8'));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (address !== null && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('no port assigned'));
        }
      });
    });
  });
}

// Only PATH and the variables a test names reach the child, so neither the
// developer's shell nor the Jest setup file can leak into the process.
function startServer(env: Record<string, string>): RunningServer {
  const child = spawn(process.execPath, [join(DIST, 'server.js')], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);

  let out = '';
  let err = '';
  const lineWaiters: ((line: string) => void)[] = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
    const newline = out.indexOf('\n');
    if (newline !== -1) {
      for (const waiter of lineWaiters.splice(0)) {
        waiter(out.slice(0, newline));
      }
    }
  });
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
  });

  const exited = new Promise<ExitStatus>((resolve) => {
    child.once('close', (code, signal) => {
      resolve({ code, signal });
    });
  });

  return {
    child,
    stdout: () => out,
    stderr: () => err,
    firstStdoutLine: () =>
      new Promise<string>((resolve, reject) => {
        const newline = out.indexOf('\n');
        if (newline !== -1) {
          resolve(out.slice(0, newline));
          return;
        }
        lineWaiters.push(resolve);
        void exited.then((status) => {
          reject(
            new Error(
              `server exited with code ${String(status.code)} before logging: ${err.slice(0, 300)}`
            )
          );
        });
      }),
    exited,
  };
}

async function waitForStdout(
  server: RunningServer,
  needle: string,
  ms: number
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!server.stdout().includes(needle)) {
    if (Date.now() > deadline || server.child.exitCode !== null) {
      throw new Error(`stdout never contained ${needle}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function stdoutRecords(server: RunningServer): Record<string, unknown>[] {
  return server
    .stdout()
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function validEnv(): Promise<Record<string, string>> {
  return {
    ...envExampleValues(),
    PORT: String(await freePort()),
    ALTEGIO_API_TOKEN: CANARY,
    // Explicit, so no case relies on the check being off by default (it is
    // required by default). The fail-closed startup cases build their own
    // environment with productionEnv().
    PROXY_AUTH: 'off',
  };
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listFiles(join(directory, entry.name))
      : [join(directory, entry.name)]
  );
}

beforeAll(() => {
  rmSync(DIST, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [
      join(ROOT, 'node_modules/typescript/bin/tsc'),
      '-p',
      'tsconfig.build.json',
    ],
    { cwd: ROOT, stdio: 'pipe' }
  );
}, 60_000);

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('build output', () => {
  it(
    'emits dist/server.js and no test or compliance files',
    () => {
      expect(existsSync(join(DIST, 'server.js'))).toBe(true);
      const files = listFiles(DIST);
      expect(files.filter((file) => file.includes('__tests__'))).toEqual([]);
      expect(files.filter((file) => file.includes('/compliance/'))).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );
});

describe('node dist/server.js', () => {
  it(
    'starts from .env.example values and serves /health and tools/list',
    async () => {
      const env = await validEnv();
      const server = startServer(env);

      const line = await within(server.firstStdoutLine(), 10_000);
      const record = JSON.parse(line) as Record<string, unknown>;
      expect(record.severity).toBe('INFO');
      expect(record.message).toBe('listening');
      expect(typeof record.time).toBe('string');
      expect(record).not.toHaveProperty('pid');
      expect(record).not.toHaveProperty('hostname');

      const base = `http://127.0.0.1:${env.PORT ?? ''}`;
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({
        status: 'ok',
        version: PACKAGE_VERSION,
        commit: null,
      });

      const list = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(list.status).toBe(200);
      const body = (await list.json()) as {
        result?: { tools?: { name: string }[] };
      };
      expect((body.result?.tools ?? []).map((tool) => tool.name)).toContain(
        'business_get'
      );

      server.child.kill('SIGTERM');
      await within(server.exited, SHUTDOWN_WINDOW_MS);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'exits 0 within 10 seconds on SIGTERM and never prints the token',
    async () => {
      const env = await validEnv();
      const server = startServer(env);
      await within(server.firstStdoutLine(), 10_000);

      // Leaves a keep-alive connection behind, which close() alone would wait
      // for; closeIdleConnections() must release it.
      const base = `http://127.0.0.1:${env.PORT ?? ''}`;
      expect((await fetch(`${base}/health`)).status).toBe(200);
      await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${CANARY}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });

      const startedAt = Date.now();
      server.child.kill('SIGTERM');
      const status = await within(server.exited, SHUTDOWN_WINDOW_MS);
      expect(status.code).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(SHUTDOWN_WINDOW_MS);

      expect(server.stdout()).toContain('"event":"shutdown"');
      expect(server.stdout()).not.toContain(CANARY);
      expect(server.stderr()).not.toContain(CANARY);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'exits 1 and names PUBLIC_BASE_URL when it is missing',
    async () => {
      const env = await validEnv();
      delete env.PUBLIC_BASE_URL;
      const server = startServer(env);
      const status = await within(server.exited, SHUTDOWN_WINDOW_MS);
      expect(status.code).toBe(1);
      expect(server.stderr()).toContain('Invalid configuration:');
      expect(server.stderr()).toContain('  - PUBLIC_BASE_URL:');
      expect(server.stderr()).toContain('See .env.example');
      expect(server.stdout()).not.toContain(CANARY);
      expect(server.stderr()).not.toContain(CANARY);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'exits 1 and names ALTEGIO_API_TOKEN when it is missing',
    async () => {
      const env = await validEnv();
      delete env.ALTEGIO_API_TOKEN;
      const server = startServer(env);
      const status = await within(server.exited, SHUTDOWN_WINDOW_MS);
      expect(status.code).toBe(1);
      expect(server.stderr()).toContain(
        '  - ALTEGIO_API_TOKEN: Partner API token is required'
      );
    },
    TEST_TIMEOUT_MS
  );

  it(
    'warns once at startup when the token is shorter than the scrubber minimum, without printing it',
    async () => {
      const shortToken = 'q7x';
      const env = { ...(await validEnv()), ALTEGIO_API_TOKEN: shortToken };
      const server = startServer(env);
      await waitForStdout(server, '"event":"server_started"', 10_000);
      server.child.kill('SIGTERM');
      await within(server.exited, SHUTDOWN_WINDOW_MS);

      const warnings = stdoutRecords(server).filter(
        (record) =>
          record.event === 'config_warning' &&
          record.setting === 'ALTEGIO_API_TOKEN'
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.setting).toBe('ALTEGIO_API_TOKEN');
      expect(server.stdout()).not.toContain(shortToken);
      expect(server.stderr()).not.toContain(shortToken);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'writes no config_warning for a token at or above the scrubber minimum',
    async () => {
      const server = startServer(await validEnv());
      await waitForStdout(server, '"event":"server_started"', 10_000);
      server.child.kill('SIGTERM');
      await within(server.exited, SHUTDOWN_WINDOW_MS);
      // PROXY_AUTH=off logs its own config_warning; only the token one is checked here.
      expect(
        stdoutRecords(server).filter(
          (record) =>
            record.event === 'config_warning' &&
            record.setting === 'ALTEGIO_API_TOKEN'
        )
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'exits 1 with a readable message for an http ALTEGIO_API_BASE in production',
    async () => {
      const env = {
        ...(await validEnv()),
        NODE_ENV: 'production',
        ALTEGIO_API_BASE: 'http://api.example.com/api/v1',
      };
      const server = startServer(env);
      const status = await within(server.exited, SHUTDOWN_WINDOW_MS);
      expect(status.code).toBe(1);
      expect(server.stderr()).toContain(
        '  - ALTEGIO_API_BASE: must be an https URL (http is accepted only when NODE_ENV is development or test)'
      );
      expect(server.stderr()).not.toContain('api.example.com');
      expect(server.stderr()).not.toContain(CANARY);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'exits 1 and names PORT when it is not a number',
    async () => {
      const env = await validEnv();
      env.PORT = 'abc';
      const server = startServer(env);
      const status = await within(server.exited, SHUTDOWN_WINDOW_MS);
      expect(status.code).toBe(1);
      expect(server.stderr()).toContain('  - PORT:');
      expect(server.stderr()).not.toContain('abc');
    },
    TEST_TIMEOUT_MS
  );
});

// A production-like environment: the check is on by its default, no key
// setting is present, so every case names the key source it gives the server.
async function productionEnv(): Promise<Record<string, string>> {
  const env = await validEnv();
  env.NODE_ENV = 'production';
  delete env.PROXY_AUTH;
  delete env.MCP_PROXY_BACKEND_KEY;
  delete env.MCP_PROXY_BACKEND_KEY_FILE;
  return env;
}

function newKey(): string {
  return randomBytes(32).toString('hex');
}

function keyFile(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'proxy-key-'));
  tempDirs.push(directory);
  const path = join(directory, 'key');
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

function postMcp(base: string, key: string | null): Promise<Response> {
  const headers: Record<string, string> = { ...MCP_HEADERS };
  if (key !== null) {
    headers[PROXY_AUTH_HEADER] = signProxyRequest({
      key,
      method: 'POST',
      path: '/mcp',
    });
  }
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

describe('node dist/server.js: the proxy check fails closed (OPS-03, OPS-04)', () => {
  it.each([
    ['PROXY_AUTH unset', undefined],
    ['PROXY_AUTH=required', 'required'],
  ])(
    'exits 1 in production with no key setting (%s), names MCP_PROXY_BACKEND_KEY and starts nothing',
    async (_label, mode) => {
      const env = await productionEnv();
      if (mode !== undefined) env.PROXY_AUTH = mode;
      const server = startServer(env);
      const status = await within(server.exited, SHUTDOWN_WINDOW_MS);
      expect(status.code).toBe(1);
      expect(server.stderr()).toContain('Invalid configuration:');
      expect(server.stderr()).toContain('MCP_PROXY_BACKEND_KEY');
      expect(server.stdout()).toBe('');
      expect(server.stderr()).not.toContain(CANARY);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'exits 1 for a key file that holds a 20-character key, names the setting and prints no value',
    async () => {
      const shortKey = 'k7q2m9x4b1n8v5c3z6w0';
      expect(shortKey).toHaveLength(20);
      const env: Record<string, string> = {
        ...(await productionEnv()),
        MCP_PROXY_BACKEND_KEY_FILE: keyFile(`${shortKey}\n`),
      };
      const server = startServer(env);
      const status = await within(server.exited, SHUTDOWN_WINDOW_MS);
      expect(status.code).toBe(1);
      expect(server.stderr()).toContain('MCP_PROXY_BACKEND_KEY_FILE');
      expect(server.stdout()).toBe('');
      expect(server.stdout()).not.toContain(shortKey);
      expect(server.stderr()).not.toContain(shortKey);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'exits 1 for a key file that does not exist, naming the setting',
    async () => {
      const env: Record<string, string> = {
        ...(await productionEnv()),
        MCP_PROXY_BACKEND_KEY_FILE: join(tmpdir(), 'no-such-dir', 'key'),
      };
      const server = startServer(env);
      const status = await within(server.exited, SHUTDOWN_WINDOW_MS);
      expect(status.code).toBe(1);
      expect(server.stderr()).toContain('MCP_PROXY_BACKEND_KEY_FILE');
      expect(server.stdout()).toBe('');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'exits 1 for an empty key file',
    async () => {
      const env: Record<string, string> = {
        ...(await productionEnv()),
        MCP_PROXY_BACKEND_KEY_FILE: keyFile('\n'),
      };
      const server = startServer(env);
      const status = await within(server.exited, SHUTDOWN_WINDOW_MS);
      expect(status.code).toBe(1);
      expect(server.stderr()).toContain('MCP_PROXY_BACKEND_KEY_FILE');
      expect(server.stdout()).toBe('');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'exits 1 for a plain MCP_PROXY_BACKEND_KEY of 20 characters, without printing it',
    async () => {
      const shortKey = 'p3d8r1y6t4u9e2w7s5a0';
      const env: Record<string, string> = {
        ...(await productionEnv()),
        MCP_PROXY_BACKEND_KEY: shortKey,
      };
      const server = startServer(env);
      const status = await within(server.exited, SHUTDOWN_WINDOW_MS);
      expect(status.code).toBe(1);
      expect(server.stderr()).toContain('  - MCP_PROXY_BACKEND_KEY:');
      expect(server.stderr()).not.toContain(shortKey);
      expect(server.stdout()).toBe('');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'starts with a readable 64-character key file, answers /health unsigned and /mcp only when signed',
    async () => {
      const key = newKey();
      expect(key).toHaveLength(64);
      const env: Record<string, string> = {
        ...(await productionEnv()),
        MCP_PROXY_BACKEND_KEY_FILE: keyFile(`${key}\n`),
      };
      const server = startServer(env);
      await within(server.firstStdoutLine(), 10_000);
      const base = `http://127.0.0.1:${env.PORT ?? ''}`;

      expect((await fetch(`${base}/health`)).status).toBe(200);

      const unsigned = await postMcp(base, null);
      expect(unsigned.status).toBe(401);
      expect(await unsigned.json()).toEqual({
        error: 'proxy_auth_required',
        error_description: 'requests must come through mcp-proxy',
      });
      const wrongKey = await postMcp(base, newKey());
      expect(wrongKey.status).toBe(401);
      const signed = await postMcp(base, key);
      expect(signed.status).toBe(200);

      server.child.kill('SIGTERM');
      await within(server.exited, SHUTDOWN_WINDOW_MS);
      expect(server.stdout()).not.toContain(key);
      expect(server.stderr()).not.toContain(key);
      expect(
        stdoutRecords(server).filter(
          (record) =>
            record.event === 'config_warning' && record.setting === 'PROXY_AUTH'
        )
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'verifies requests signed with either key of an old,new rotation payload',
    async () => {
      const oldKey = newKey();
      const newerKey = newKey();
      const env: Record<string, string> = {
        ...(await productionEnv()),
        MCP_PROXY_BACKEND_KEY_FILE: keyFile(`${oldKey},${newerKey}\n`),
      };
      const server = startServer(env);
      await within(server.firstStdoutLine(), 10_000);
      const base = `http://127.0.0.1:${env.PORT ?? ''}`;

      expect((await postMcp(base, oldKey)).status).toBe(200);
      expect((await postMcp(base, newerKey)).status).toBe(200);
      expect((await postMcp(base, newKey())).status).toBe(401);

      server.child.kill('SIGTERM');
      await within(server.exited, SHUTDOWN_WINDOW_MS);
      expect(server.stdout()).not.toContain(oldKey);
      expect(server.stdout()).not.toContain(newerKey);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'starts with PROXY_AUTH=off, logs one config_warning naming PROXY_AUTH and serves /mcp unsigned',
    async () => {
      const env = await validEnv();
      const server = startServer(env);
      await waitForStdout(server, '"event":"config_warning"', 10_000);
      const base = `http://127.0.0.1:${env.PORT ?? ''}`;
      expect((await postMcp(base, null)).status).toBe(200);

      server.child.kill('SIGTERM');
      await within(server.exited, SHUTDOWN_WINDOW_MS);
      const warnings = stdoutRecords(server).filter(
        (record) =>
          record.event === 'config_warning' && record.setting === 'PROXY_AUTH'
      );
      expect(warnings).toHaveLength(1);
      expect(JSON.stringify(warnings[0])).not.toContain(CANARY);
    },
    TEST_TIMEOUT_MS
  );
});

describe('node dist/server.js: GET /health commit (OPS-02)', () => {
  it(
    'reports the COMMIT_SHA the process was given',
    async () => {
      const env: Record<string, string> = {
        ...(await validEnv()),
        COMMIT_SHA: '0123abc4567def',
      };
      const server = startServer(env);
      await within(server.firstStdoutLine(), 10_000);
      const health = await fetch(`http://127.0.0.1:${env.PORT ?? ''}/health`);
      expect(await health.json()).toEqual({
        status: 'ok',
        version: PACKAGE_VERSION,
        commit: '0123abc4567def',
      });
      server.child.kill('SIGTERM');
      await within(server.exited, SHUTDOWN_WINDOW_MS);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'reports null when no COMMIT_SHA is given',
    async () => {
      const env = await validEnv();
      env.COMMIT_SHA = '';
      const server = startServer(env);
      await within(server.firstStdoutLine(), 10_000);
      const health = await fetch(`http://127.0.0.1:${env.PORT ?? ''}/health`);
      expect(((await health.json()) as { commit: unknown }).commit).toBeNull();
      server.child.kill('SIGTERM');
      await within(server.exited, SHUTDOWN_WINDOW_MS);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'exits 1 for a COMMIT_SHA that is not 7 to 40 lowercase hex characters, without printing it',
    async () => {
      const env: Record<string, string> = {
        ...(await validEnv()),
        COMMIT_SHA: 'Not-A-Commit',
      };
      const server = startServer(env);
      const status = await within(server.exited, SHUTDOWN_WINDOW_MS);
      expect(status.code).toBe(1);
      expect(server.stderr()).toContain('  - COMMIT_SHA:');
      expect(server.stderr()).not.toContain('Not-A-Commit');
    },
    TEST_TIMEOUT_MS
  );
});
