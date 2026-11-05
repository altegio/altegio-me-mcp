// Exercise the packed HTTP executable outside the checkout, without real credentials.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), 'me-package-'));
let child;
try {
  const npm = (args, cwd = root) =>
    execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: scratch, HUSKY: '0' },
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
  const packed = JSON.parse(
    npm(['pack', '--json', '--pack-destination', scratch])
  )['altegio-me-mcp'];
  for (const { path } of packed.files) {
    assert.match(
      path,
      /^(dist\/|scripts\/prepare\.mjs$|package\.json$|README\.md$|LICENSE$)/,
      `Unexpected packed file: ${path}`
    );
    assert.doesNotMatch(path, /__tests__|\.env|fixtures|loadtest|compliance/);
  }
  const consumer = join(scratch, 'consumer');
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, 'package.json'),
    '{"private":true,"type":"module"}\n'
  );
  npm(
    ['install', '--no-audit', '--no-fund', join(scratch, packed.filename)],
    consumer
  );
  const installed = join(consumer, 'node_modules/altegio-me-mcp');
  const manifest = JSON.parse(
    readFileSync(join(installed, 'package.json'), 'utf8')
  );
  assert.equal(manifest.bin['altegio-me-mcp'], 'dist/server.js');
  assert.ok(
    readFileSync(join(installed, 'dist/server.js'), 'utf8').startsWith(
      '#!/usr/bin/env node'
    )
  );
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(
    process.execPath,
    [join(installed, manifest.bin['altegio-me-mcp'])],
    {
      cwd: consumer,
      env: {
        PATH: process.env.PATH,
        HOME: scratch,
        PORT: String(port),
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        PUBLIC_BASE_URL: base,
        PROXY_AUTH: 'off',
        CALLER_AUTH: 'optional',
        ALTEGIO_API_TOKEN: 'synthetic-package-token',
        ALTEGIO_API_BASE: 'https://invalid.example/api/v1',
        ALTEGIO_APP_BASE: 'https://invalid.example',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  );
  let errors = '';
  child.stderr.on('data', (chunk) => {
    errors = (errors + chunk).slice(-4096);
  });
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${errors}`);
    try {
      const res = await globalThis.fetch(`${base}/health`, {
        signal: globalThis.AbortSignal.timeout(1000),
      });
      const health = await res.json();
      assert.equal(health.version, manifest.version);
      healthy = res.ok && health.status === 'ok';
      if (healthy) break;
    } catch {
      /* Startup may still be in progress. */
    }
    await delay(100);
  }
  assert.ok(healthy, `Installed server failed to start: ${errors}`);
  const example = execFileSync(
    process.execPath,
    [join(root, 'examples/list-tools.mjs'), `${base}/mcp`],
    {
      cwd: consumer,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: scratch },
      timeout: 15000,
    }
  );
  assert.equal(example.trim().split('\n').length, 12);
  const rpc = async (method, params) => {
    const res = await globalThis.fetch(`${base}/mcp`, {
      method: 'POST',
      signal: globalThis.AbortSignal.timeout(3000),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('mcp-session-id'), null);
    return res.json();
  };
  const init = await rpc('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'package-check', version: '1' },
  });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  const list = await rpc('tools/list');
  assert.equal(list.result.tools.length, 12);
  assert.equal((await rpc('prompts/list')).result.prompts.length, 4);
  assert.equal(
    (await rpc('tools/call', { name: 'me_book', arguments: {} })).result
      .isError,
    true
  );
  const refused = await new Promise((resolve, reject) => {
    const req = request(
      `${base}/mcp`,
      { method: 'POST', headers: { host: 'attacker.example' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(refused, 403);
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  assert.equal((await exited)[0], 0);
  process.stdout.write(
    `PASS: installed tarball, Node ${process.versions.node}, HTTP protocol, scope refusal, Host guard, graceful shutdown\n`
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  rmSync(scratch, { recursive: true, force: true });
}
