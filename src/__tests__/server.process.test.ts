import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { PACKAGE_VERSION } from '../util/package-metadata.js';

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

async function validEnv(): Promise<Record<string, string>> {
  return {
    ...envExampleValues(),
    PORT: String(await freePort()),
    ALTEGIO_API_TOKEN: CANARY,
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
      const body = (await list.json()) as { result?: { tools?: unknown[] } };
      expect(body.result?.tools).toEqual([]);

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
