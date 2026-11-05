import { afterEach, expect, it } from '@jest/globals';
import { request } from 'node:http';
import { z } from 'zod';
import { defineTool } from '../tools/factory.js';
import {
  closeAllApps,
  initializeBody,
  startApp,
  stubPartnerValidator,
  toolCallBody,
} from './helpers/http-harness.js';

afterEach(closeAllApps);

it.each([
  ['an untrusted Host', 'attacker.example'],
  ['a long hyphenated Host', `${'-'.repeat(8000)}.invalid`],
])('rejects %s before probing a caller token', async (_label, host) => {
  const validator = stubPartnerValidator();
  const app = await startApp({ callerAuth: { mode: 'required', validator } });
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      `${app.baseUrl}/mcp`,
      {
        method: 'POST',
        headers: {
          host,
          authorization: 'Bearer valid-looking-token',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify(initializeBody()));
  });
  expect(status).toBe(403);
  expect(validator.checked).toEqual([]);
});

it('aborts a running tool when its HTTP caller disconnects', async () => {
  let started!: () => void;
  let aborted!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const tool = defineTool({
    name: 'wait_for_abort',
    title: 'Wait for abort',
    description: 'Synthetic cancellation probe.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    input: z.strictObject({}),
    output: z.strictObject({}),
    render: () => 'Done',
    handler: ({ ctx }) =>
      new Promise<Record<string, never>>((resolve) => {
        ctx.signal.addEventListener(
          'abort',
          () => {
            aborted();
            resolve({});
          },
          { once: true }
        );
        started();
      }),
  });
  const app = await startApp({ tools: [tool] });
  const req = request(`${app.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
  });
  req.on('error', () => undefined);
  req.end(JSON.stringify(toolCallBody('wait_for_abort', {})));
  try {
    await running;
    req.destroy();
    await stopped;
  } finally {
    req.destroy();
  }
}, 2000);

it.each([
  ['service-abc-ew.a.run.app', 200],
  ['candidate---service-abc-ew.a.run.app', 200],
  ['candidate---with-hyphens---service-abc-ew.a.run.app', 200],
  ['---service-abc-ew.a.run.app', 403],
  ['candidate.invalid---service-abc-ew.a.run.app', 403],
  ['candidate---another-abc-ew.a.run.app', 403],
  ['candidate---service-abc-ew.a.run.app.attacker.example', 403],
  ['candidate---public.example', 403],
])('validates deployment ingress Host %s', async (host, expected) => {
  const app = await startApp({
    allowedHosts: ['service-abc-ew.a.run.app', 'public.example'],
  });
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      `${app.baseUrl}/mcp`,
      {
        method: 'POST',
        headers: {
          host,
          'x-forwarded-host': 'service-abc-ew.a.run.app',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify(initializeBody()));
  });
  expect(status).toBe(expected);
});
