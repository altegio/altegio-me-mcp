import { afterEach, describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { BookingClient } from '../booking/client.js';
import { ALTEGIO_ACCEPT } from '../booking/http.js';
import {
  fakeFetch,
  loadFixture,
  type FakeFetch,
} from '../booking/__tests__/helpers/fake-fetch.js';
import {
  DIRECT_USER_TOKEN_HEADER,
  SIGNED_PARTNER_TOKEN_HEADER,
  SIGNED_KIND_HEADER,
  SIGNED_SCOPE_HEADER,
  SIGNED_USER_TOKEN_HEADER,
} from '../security/caller-auth.js';
import { partnerIdOf } from '../security/partner-token.js';
import { PROXY_AUTH_HEADER } from '../security/proxy-auth.js';
import { defineTool, type DefinedTool } from '../tools/factory.js';
import { productionTools } from '../tools/registry.js';
import { SCOPE_BOOK } from '../tools/scopes.js';
import {
  CANARY_SECRET,
  CLIENT_USER_TOKEN,
  PARTNER_TOKEN,
  PARTNER_TOKEN_UNCHECKABLE,
  closeAllApps,
  postMcp,
  startApp,
  stubPartnerValidator,
  toolCallBody,
  toolsListBody,
  waitForLogs,
  type Harness,
} from './helpers/http-harness.js';
import { signProxyRequest } from './helpers/sign-request.js';

// The client tier end to end over HTTP (ADR 0005, D-01, D-02): POST /mcp ->
// caller check -> scope check -> me_list_places -> BookingClient ->
// BookingHttp -> (fake) Altegio API. Only fetch is replaced.

const API_BASE = 'https://api.alteg.io/api/v1';
const KEY = 'me-flow-test-key-0123456789abcdef0123456789abcdef';
const PLACES_PATH = '/user/companies/yplaces';

interface RpcResult {
  result?: {
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
    structuredContent?: {
      items: {
        location_id: number;
        name: string | null;
        online_booking: boolean;
      }[];
      pagination: Record<string, unknown>;
    };
    isError?: boolean;
  };
}

let bookHandlerRuns = 0;
// A tool of the future client tier: it needs mcp:me:book, which nobody holds.
const bookTool: DefinedTool<unknown> = defineTool({
  name: 'demo_book_thing',
  title: 'Book a demo thing',
  description: 'Books one demo thing for the signed-in client.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: false,
  },
  scopes: [SCOPE_BOOK],
  input: z.strictObject({}),
  output: z.strictObject({ ok: z.boolean() }),
  render: () => 'booked',
  handler: () => {
    bookHandlerRuns += 1;
    return Promise.resolve({ ok: true });
  },
});

afterEach(async () => {
  await closeAllApps();
});

function signed(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    [PROXY_AUTH_HEADER]: signProxyRequest({
      key: KEY,
      method: 'POST',
      path: '/mcp',
      headers,
    }),
  };
}

function signedClient(scope?: string): Record<string, string> {
  return signed({
    [SIGNED_KIND_HEADER]: 'client',
    [SIGNED_USER_TOKEN_HEADER]: CLIENT_USER_TOKEN,
    ...(scope === undefined ? {} : { [SIGNED_SCOPE_HEADER]: scope }),
  });
}

async function start(
  scenario: 'default' | 'empty' | 'server_error',
  overrides: Parameters<typeof startApp>[0] = {}
): Promise<{ harness: Harness; upstream: FakeFetch }> {
  const upstream = fakeFetch([
    {
      method: 'GET',
      path: PLACES_PATH,
      reply:
        scenario === 'server_error'
          ? {
              status: 500,
              body: {
                success: false,
                meta: { message: `internal failure for ${CLIENT_USER_TOKEN}` },
              },
            }
          : loadFixture('user_yplaces', scenario),
    },
    {
      method: 'GET',
      path: '/company/722227',
      reply: loadFixture('company', 'default'),
    },
  ]);
  const harness = await startApp({
    tools: productionTools,
    toolDeps: {
      booking: new BookingClient({
        base: API_BASE,
        token: CANARY_SECRET,
        fetch: upstream.fetch,
      }),
    },
    ...overrides,
  });
  return { harness, upstream };
}

const BEHIND_PROXY = {
  proxyAuth: { keys: () => [KEY] },
  callerAuth: {
    mode: 'required' as const,
    validator: stubPartnerValidator(),
  },
};

describe('me_list_places with the direct user-token header (CALLER_AUTH=optional)', () => {
  it('lists the two own places with the partner and the user token upstream', async () => {
    const { harness, upstream } = await start('default');
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('me_list_places', {}),
      { [DIRECT_USER_TOKEN_HEADER]: CLIENT_USER_TOKEN }
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as RpcResult;
    expect(body.result?.isError).not.toBe(true);
    const items = body.result?.structuredContent?.items ?? [];
    expect(
      items.map((item) => [item.location_id, item.online_booking])
    ).toEqual([
      [722227, true],
      [726120, false],
    ]);
    expect(body.result?.structuredContent?.pagination).toMatchObject({
      page: 1,
      returned: 2,
      total: 2,
      has_more: false,
    });

    expect(upstream.calls).toHaveLength(1);
    const [call] = upstream.calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.pathname).toBe(`/api/v1${PLACES_PATH}`);
    expect(call?.url.search).toBe('');
    expect(call?.headers.get('authorization')).toBe(
      `Bearer ${CANARY_SECRET}, User ${CLIENT_USER_TOKEN}`
    );
    expect(call?.headers.get('accept')).toBe(ALTEGIO_ACCEPT);

    const [line] = await waitForLogs(harness, 1);
    expect(line).toMatchObject({
      caller: 'client',
      tool: 'me_list_places',
      outcome: 'ok',
    });
    expect(text).not.toContain(CLIENT_USER_TOKEN);
    expect(JSON.stringify(harness.logs)).not.toContain(CLIENT_USER_TOKEN);
  });

  it('says that no own places were found for an empty list', async () => {
    const { harness } = await start('empty');
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('me_list_places', {}),
      { [DIRECT_USER_TOKEN_HEADER]: CLIENT_USER_TOKEN }
    );
    const body = (await res.json()) as RpcResult;
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent?.items).toEqual([]);
    expect(body.result?.content?.[0]?.text).toMatch(/no own places/i);
  });

  it('scrubs the user token from an upstream error message', async () => {
    const { harness } = await start('server_error');
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('me_list_places', {}),
      { [DIRECT_USER_TOKEN_HEADER]: CLIENT_USER_TOKEN }
    );
    const text = await res.text();
    const body = JSON.parse(text) as RpcResult;
    expect(body.result?.isError).toBe(true);
    expect(text).toContain('[redacted]');
    expect(text).not.toContain(CLIENT_USER_TOKEN);
    expect(JSON.stringify(harness.logs)).not.toContain(CLIENT_USER_TOKEN);
  });

  it('keeps the user token off the business routes', async () => {
    const { harness, upstream } = await start('default');
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('business_get', { location_id: 722227 }),
      { [DIRECT_USER_TOKEN_HEADER]: CLIENT_USER_TOKEN }
    );
    const body = (await res.json()) as RpcResult;
    expect(body.result?.isError).not.toBe(true);
    expect(
      upstream.calls.map((call) => call.headers.get('authorization'))
    ).toEqual([`Bearer ${CANARY_SECRET}`]);
  });
});

describe('me_list_places with a signed client identity behind the proxy', () => {
  it('serves the same result and sends the same Authorization header', async () => {
    const { harness, upstream } = await start('default', BEHIND_PROXY);
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('me_list_places', {}),
      signedClient('mcp:me:read')
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as RpcResult;
    expect(body.result?.isError).not.toBe(true);
    expect(
      body.result?.structuredContent?.items.map((item) => item.location_id)
    ).toEqual([722227, 726120]);
    expect(
      upstream.calls.map((call) => call.headers.get('authorization'))
    ).toEqual([`Bearer ${CANARY_SECRET}, User ${CLIENT_USER_TOKEN}`]);
    const [line] = await waitForLogs(harness, 1);
    expect(line).toMatchObject({ caller: 'client', outcome: 'ok' });
    expect(text).not.toContain(CLIENT_USER_TOKEN);
    expect(JSON.stringify(harness.logs)).not.toContain(CLIENT_USER_TOKEN);
  });
});

describe('tier separation: discover for everyone, read for a signed-in client', () => {
  const REQUIRED = {
    callerAuth: {
      mode: 'required' as const,
      validator: stubPartnerValidator(),
    },
  };

  it('refuses an anonymous caller in band, names the sign-in and sends nothing upstream', async () => {
    const { harness, upstream } = await start('default');
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('me_list_places', {})
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResult;
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain('sign-in');
    expect(upstream.calls).toEqual([]);
    const [line] = await waitForLogs(harness, 1);
    expect(line).toMatchObject({
      caller: 'anonymous',
      tool: 'me_list_places',
      outcome: 'tool_error',
      error_type: 'InsufficientScope',
    });
  });

  it('refuses a partner caller in band, names the sign-in and sends nothing upstream', async () => {
    const { harness, upstream } = await start('default', REQUIRED);
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('me_list_places', {}),
      { authorization: `Bearer ${PARTNER_TOKEN}` }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResult;
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain('sign-in');
    expect(upstream.calls).toEqual([]);
    const [line] = await waitForLogs(harness, 1);
    expect(line).toMatchObject({
      caller: 'partner',
      error_type: 'InsufficientScope',
    });
  });

  it('still serves a partner caller the known-business tools', async () => {
    const { harness, upstream } = await start('default', REQUIRED);
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('business_get', { location_id: 722227 }),
      { authorization: `Bearer ${PARTNER_TOKEN}` }
    );
    const body = (await res.json()) as RpcResult;
    expect(body.result?.isError).not.toBe(true);
    expect(
      upstream.calls.map((call) => call.headers.get('authorization'))
    ).toEqual([`Bearer ${PARTNER_TOKEN}`]);
  });

  it('lists the same tools for an anonymous, a partner and a client caller', async () => {
    const names: string[][] = [];
    const callers: [Parameters<typeof startApp>[0], Record<string, string>][] =
      [
        [{}, {}],
        [REQUIRED, { authorization: `Bearer ${PARTNER_TOKEN}` }],
        [{}, { [DIRECT_USER_TOKEN_HEADER]: CLIENT_USER_TOKEN }],
      ];
    for (const [overrides, headers] of callers) {
      const { harness } = await start('default', overrides);
      const res = await postMcp(harness.baseUrl, toolsListBody(), headers);
      const body = (await res.json()) as RpcResult;
      names.push((body.result?.tools ?? []).map((tool) => tool.name));
    }
    expect(names[0]).toContain('me_list_places');
    expect(names[1]).toEqual(names[0]);
    expect(names[2]).toEqual(names[0]);
  });

  it.each([
    ['no scope header', undefined],
    ['only mcp:me:book', 'mcp:me:book'],
    ['an unknown scope', 'mcp:pro:write'],
  ])(
    'refuses me_list_places to a signed client whose scope list has %s',
    async (_label, scope) => {
      const { harness, upstream } = await start('default', BEHIND_PROXY);
      const res = await postMcp(
        harness.baseUrl,
        toolCallBody('me_list_places', {}),
        signedClient(scope)
      );
      const body = (await res.json()) as RpcResult;
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toContain('sign-in');
      expect(upstream.calls).toEqual([]);
    }
  );

  it('grants mcp:me:read from the signed list but never mcp:me:book', async () => {
    bookHandlerRuns = 0;
    const { harness } = await start('default', {
      ...BEHIND_PROXY,
      tools: [...productionTools, bookTool],
    });
    const list = await postMcp(
      harness.baseUrl,
      toolCallBody('me_list_places', {}),
      signedClient('mcp:me:read mcp:me:book')
    );
    const listBody = (await list.json()) as RpcResult;
    expect(listBody.result?.isError).not.toBe(true);

    const book = await postMcp(
      harness.baseUrl,
      toolCallBody('demo_book_thing', {}),
      signedClient('mcp:me:read mcp:me:book')
    );
    const bookBody = (await book.json()) as RpcResult;
    expect(bookBody.result?.isError).toBe(true);
    expect(bookBody.result?.content?.[0]?.text).toContain(
      'acts for a signed-in client'
    );
    expect(bookHandlerRuns).toBe(0);
  });

  it('gives a direct-header client the discover and read scopes and not book', async () => {
    bookHandlerRuns = 0;
    const { harness } = await start('default', {
      tools: [...productionTools, bookTool],
    });
    const headers = { [DIRECT_USER_TOKEN_HEADER]: CLIENT_USER_TOKEN };
    for (const [tool, args, refused] of [
      ['business_get', { location_id: 722227 }, false],
      ['me_list_places', {}, false],
      ['demo_book_thing', {}, true],
    ] as const) {
      const res = await postMcp(
        harness.baseUrl,
        toolCallBody(tool, args),
        headers
      );
      const body = (await res.json()) as RpcResult;
      expect(body.result?.isError === true).toBe(refused);
    }
    expect(bookHandlerRuns).toBe(0);
  });
});

describe('a partner token that comes with the client sign-in', () => {
  const placesAuthorization = (upstream: FakeFetch): (string | null)[] =>
    upstream.calls.map((call) => call.headers.get('authorization'));

  function signedWithPartner(token: string): Record<string, string> {
    return signed({
      [SIGNED_KIND_HEADER]: 'client',
      [SIGNED_USER_TOKEN_HEADER]: CLIENT_USER_TOKEN,
      [SIGNED_SCOPE_HEADER]: 'mcp:me:read',
      [SIGNED_PARTNER_TOKEN_HEADER]: token,
    });
  }

  it('is validated once and backs the call next to the user token', async () => {
    const validator = stubPartnerValidator();
    const { harness, upstream } = await start('default', {
      proxyAuth: { keys: () => [KEY] },
      callerAuth: { mode: 'required', validator },
    });
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('me_list_places', {}),
      signedWithPartner(PARTNER_TOKEN)
    );
    const text = await res.text();
    const body = JSON.parse(text) as RpcResult;
    expect(body.result?.isError).not.toBe(true);
    expect(validator.checked).toEqual([PARTNER_TOKEN]);
    expect(placesAuthorization(upstream)).toEqual([
      `Bearer ${PARTNER_TOKEN}, User ${CLIENT_USER_TOKEN}`,
    ]);
    const [line] = await waitForLogs(harness, 1);
    expect(line).toMatchObject({
      caller: 'client',
      partner_id: partnerIdOf(PARTNER_TOKEN),
    });
    expect(text).not.toContain(PARTNER_TOKEN);
    expect(JSON.stringify(harness.logs)).not.toContain(PARTNER_TOKEN);
    expect(JSON.stringify(harness.logs)).not.toContain(CLIENT_USER_TOKEN);
  });

  it('refuses an invalid partner token next to the client with 401', async () => {
    const { harness, upstream } = await start('default', BEHIND_PROXY);
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('me_list_places', {}),
      signedWithPartner('made-up-token-0001')
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_token' });
    expect(upstream.calls).toEqual([]);
  });

  it('answers 503 with Retry-After when the partner token cannot be checked', async () => {
    const { harness } = await start('default', BEHIND_PROXY);
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('me_list_places', {}),
      signedWithPartner(PARTNER_TOKEN_UNCHECKABLE)
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
  });

  it('is read from Authorization next to a direct user token in optional mode', async () => {
    const { harness, upstream } = await start('default');
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('me_list_places', {}),
      {
        [DIRECT_USER_TOKEN_HEADER]: CLIENT_USER_TOKEN,
        authorization: `Bearer ${PARTNER_TOKEN}`,
      }
    );
    const body = (await res.json()) as RpcResult;
    expect(body.result?.isError).not.toBe(true);
    expect(placesAuthorization(upstream)).toEqual([
      `Bearer ${PARTNER_TOKEN}, User ${CLIENT_USER_TOKEN}`,
    ]);
    const [line] = await waitForLogs(harness, 1);
    expect(line).toMatchObject({
      caller: 'client',
      partner_id: partnerIdOf(PARTNER_TOKEN),
    });
  });
});

describe('a refused sign-in upstream', () => {
  it('becomes an in-band error naming the client sign-in, never retried', async () => {
    const upstream = fakeFetch([
      {
        method: 'GET',
        path: PLACES_PATH,
        reply: {
          status: 401,
          body: {
            success: false,
            meta: { message: `User ${CLIENT_USER_TOKEN} expired` },
          },
        },
      },
    ]);
    const harness = await startApp({
      tools: productionTools,
      toolDeps: {
        booking: new BookingClient({
          base: API_BASE,
          token: CANARY_SECRET,
          fetch: upstream.fetch,
        }),
      },
    });
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('me_list_places', {}),
      { [DIRECT_USER_TOKEN_HEADER]: CLIENT_USER_TOKEN }
    );
    const text = await res.text();
    const body = JSON.parse(text) as RpcResult;
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("client's sign-in");
    expect(text).not.toContain(CLIENT_USER_TOKEN);
    expect(upstream.calls).toHaveLength(1);
  });
});
