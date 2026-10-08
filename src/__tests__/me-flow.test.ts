import { afterEach, describe, expect, it } from '@jest/globals';
import { BookingClient } from '../booking/client.js';
import { ALTEGIO_ACCEPT } from '../booking/http.js';
import {
  fakeFetch,
  loadFixture,
  type FakeFetch,
} from '../booking/__tests__/helpers/fake-fetch.js';
import {
  DIRECT_USER_TOKEN_HEADER,
  SIGNED_KIND_HEADER,
  SIGNED_SCOPE_HEADER,
  SIGNED_USER_TOKEN_HEADER,
} from '../security/caller-auth.js';
import { PROXY_AUTH_HEADER } from '../security/proxy-auth.js';
import { productionTools } from '../tools/registry.js';
import {
  CANARY_SECRET,
  CLIENT_USER_TOKEN,
  closeAllApps,
  postMcp,
  startApp,
  stubPartnerValidator,
  toolCallBody,
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
