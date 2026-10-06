import { afterEach, describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import {
  PARTNER_TOKEN,
  PARTNER_TOKEN_UNCHECKABLE,
  closeAllApps,
  echoItemsTool,
  postMcp,
  startApp,
  stubPartnerValidator,
  toolCallBody,
  toolsListBody,
  waitForLogs,
} from '../../__tests__/helpers/http-harness.js';
import { signProxyRequest } from '../../__tests__/helpers/sign-request.js';
import { defineTool, type DefinedTool } from '../../tools/factory.js';
import { SCOPE_BOOK } from '../../tools/scopes.js';
import {
  DIRECT_PARTNER_TOKEN_HEADER,
  SIGNED_KIND_HEADER,
  SIGNED_PARTNER_TOKEN_HEADER,
  presentedPartnerToken,
} from '../caller-auth.js';
import { partnerIdOf } from '../partner-token.js';
import { PROXY_AUTH_HEADER } from '../proxy-auth.js';

// ADR 0004: no call without the caller's own Altegio partner token. These run
// the real middleware chain over HTTP with a stub validator that accepts only
// PARTNER_TOKEN.

const KEY = 'caller-test-key-0123456789abcdef0123456789abcdef';

interface RpcResponse {
  result?: {
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// Signs exactly the headers given, as the proxy does.
function signed(headers: Record<string, string> = {}): Record<string, string> {
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

function fromProxy(token: string): Record<string, string> {
  return signed({
    [SIGNED_KIND_HEADER]: 'partner',
    [SIGNED_PARTNER_TOKEN_HEADER]: token,
  });
}

// Reports what the tool context carries, the token included, so the test can
// prove the result scrubs it.
const tokenEchoTool: DefinedTool<unknown> = defineTool({
  name: 'demo_echo_token',
  title: 'Echo the partner token',
  description: 'Returns the partner token of the call.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  input: z.strictObject({}),
  output: z.strictObject({ token: z.string().nullable() }),
  render: (out) => `Token: ${String(out.token)}`,
  handler: ({ ctx }) => Promise.resolve({ token: ctx.partnerToken }),
});

let bookHandlerRuns = 0;
const clientTierTool: DefinedTool<unknown> = defineTool({
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

describe('presentedPartnerToken', () => {
  it('reads only the signed header behind the proxy', () => {
    expect(
      presentedPartnerToken({ authorization: `Bearer ${PARTNER_TOKEN}` }, true)
    ).toEqual({ kind: 'none' });
    expect(
      presentedPartnerToken(
        { [SIGNED_PARTNER_TOKEN_HEADER]: ` ${PARTNER_TOKEN} ` },
        true
      )
    ).toEqual({ kind: 'token', token: PARTNER_TOKEN });
  });

  it('refuses a signed identity of another kind', () => {
    expect(
      presentedPartnerToken(
        {
          [SIGNED_KIND_HEADER]: 'user',
          [SIGNED_PARTNER_TOKEN_HEADER]: PARTNER_TOKEN,
        },
        true
      )
    ).toEqual({ kind: 'unsupported' });
  });

  it('reads the direct header first, then a Bearer, without a proxy', () => {
    expect(
      presentedPartnerToken(
        {
          [DIRECT_PARTNER_TOKEN_HEADER]: 'direct-token-0001',
          authorization: 'Bearer bearer-token-0001',
        },
        false
      )
    ).toEqual({ kind: 'token', token: 'direct-token-0001' });
    expect(
      presentedPartnerToken({ authorization: 'bearer   abc-token-01 ' }, false)
    ).toEqual({ kind: 'token', token: 'abc-token-01' });
    expect(
      presentedPartnerToken({ authorization: 'Basic dXNlcjpwYXNz' }, false)
    ).toEqual({ kind: 'unsupported' });
    expect(presentedPartnerToken({}, false)).toEqual({ kind: 'none' });
  });

  it('ignores the signed header without a proxy in front', () => {
    expect(
      presentedPartnerToken(
        { [SIGNED_PARTNER_TOKEN_HEADER]: PARTNER_TOKEN },
        false
      )
    ).toEqual({ kind: 'none' });
  });
});

describe('CALLER_AUTH=required without a proxy', () => {
  async function required() {
    const validator = stubPartnerValidator();
    const harness = await startApp({
      callerAuth: { mode: 'required', validator },
    });
    return { harness, validator };
  }

  it('answers 401 without a token, before any check or parsing', async () => {
    const { harness, validator } = await required();
    const res = await postMcp(harness.baseUrl, '{ not json');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer realm="altegio-me"'
    );
    expect(await res.json()).toEqual({
      error: 'partner_token_required',
      error_description:
        'Send an Altegio partner token: Authorization: Bearer <partner token>',
    });
    expect(validator.checked).toEqual([]);
    const [line] = await waitForLogs(harness, 1);
    expect(line).toMatchObject({
      auth_reason: 'no_partner_token',
      error_type: 'partner_token_required',
      caller: null,
      partner_id: null,
    });
  });

  it('answers 401 invalid_token for a token Altegio refuses', async () => {
    const { harness } = await required();
    const res = await postMcp(
      harness.baseUrl,
      toolsListBody(),
      bearer('made-up-token-0001')
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      'error="invalid_token"'
    );
    expect(await res.json()).toMatchObject({ error: 'invalid_token' });
    const [line] = await waitForLogs(harness, 1);
    expect(line).toMatchObject({ auth_reason: 'invalid_partner_token' });
  });

  it('answers 401 invalid_token for a credential that is not a Bearer', async () => {
    const { harness, validator } = await required();
    const res = await postMcp(harness.baseUrl, toolsListBody(), {
      authorization: 'Basic dXNlcjpwYXNz',
    });
    expect(res.status).toBe(401);
    expect(validator.checked).toEqual([]);
  });

  it('answers 503 with Retry-After when Altegio cannot say', async () => {
    const { harness } = await required();
    const res = await postMcp(
      harness.baseUrl,
      toolsListBody(),
      bearer(PARTNER_TOKEN_UNCHECKABLE)
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toMatchObject({
      error: 'temporarily_unavailable',
    });
  });

  it('serves a valid token and logs its pseudonym, never the token', async () => {
    const { harness } = await required();
    const res = await postMcp(
      harness.baseUrl,
      toolsListBody(),
      bearer(PARTNER_TOKEN)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResponse;
    expect(body.result?.tools?.map((tool) => tool.name)).toEqual([
      'demo_echo_items',
    ]);
    const [line] = await waitForLogs(harness, 1);
    expect(line).toMatchObject({
      outcome: 'ok',
      caller: 'partner',
      partner_id: partnerIdOf(PARTNER_TOKEN),
      auth_reason: null,
    });
    expect(JSON.stringify(harness.logs)).not.toContain(PARTNER_TOKEN);
  });

  it('accepts the token in X-Altegio-Partner-Token', async () => {
    const { harness } = await required();
    const res = await postMcp(harness.baseUrl, toolsListBody(), {
      [DIRECT_PARTNER_TOKEN_HEADER]: PARTNER_TOKEN,
    });
    expect(res.status).toBe(200);
  });
});

describe('CALLER_AUTH=optional', () => {
  it('serves a call without a token as anonymous', async () => {
    const harness = await startApp({
      callerAuth: { mode: 'optional', validator: stubPartnerValidator() },
    });
    const res = await postMcp(harness.baseUrl, toolsListBody());
    expect(res.status).toBe(200);
    const [line] = await waitForLogs(harness, 1);
    expect(line).toMatchObject({ caller: 'anonymous', partner_id: null });
  });

  it('still refuses a token that is sent and invalid, with no fallback', async () => {
    const harness = await startApp({
      callerAuth: { mode: 'optional', validator: stubPartnerValidator() },
    });
    const res = await postMcp(
      harness.baseUrl,
      toolsListBody(),
      bearer('made-up-token-0001')
    );
    expect(res.status).toBe(401);
  });
});

describe('CALLER_AUTH=required behind the proxy', () => {
  async function behindProxy() {
    return startApp({
      tools: [echoItemsTool, tokenEchoTool],
      proxyAuth: { keys: () => [KEY] },
      callerAuth: { mode: 'required', validator: stubPartnerValidator() },
    });
  }

  it('ignores an Authorization header the proxy did not sign into its own header', async () => {
    const harness = await behindProxy();
    const res = await postMcp(
      harness.baseUrl,
      toolsListBody(),
      signed(bearer(PARTNER_TOKEN))
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'partner_token_required' });
  });

  it('refuses a signed identity it does not serve yet', async () => {
    const harness = await behindProxy();
    const res = await postMcp(
      harness.baseUrl,
      toolsListBody(),
      signed({
        [SIGNED_KIND_HEADER]: 'user',
        [SIGNED_PARTNER_TOKEN_HEADER]: PARTNER_TOKEN,
      })
    );
    expect(res.status).toBe(401);
  });

  it('refuses a partner token header the signature does not cover', async () => {
    const harness = await behindProxy();
    const headers = {
      ...signed({ [SIGNED_KIND_HEADER]: 'partner' }),
      [SIGNED_PARTNER_TOKEN_HEADER]: PARTNER_TOKEN,
    };
    const res = await postMcp(harness.baseUrl, toolsListBody(), headers);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'proxy_auth_required' });
  });

  it('hands the signed token to the tool and scrubs it from the result', async () => {
    const harness = await behindProxy();
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('demo_echo_token', {}),
      fromProxy(PARTNER_TOKEN)
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(PARTNER_TOKEN);
    const body = JSON.parse(text) as RpcResponse;
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent).toEqual({ token: '[redacted]' });
  });
});

describe('per-tool scopes in tools/call', () => {
  it('lists a client-tier tool but refuses to run it on a partner token', async () => {
    bookHandlerRuns = 0;
    const harness = await startApp({
      tools: [echoItemsTool, clientTierTool],
      callerAuth: { mode: 'required', validator: stubPartnerValidator() },
    });
    const list = (await (
      await postMcp(harness.baseUrl, toolsListBody(), bearer(PARTNER_TOKEN))
    ).json()) as RpcResponse;
    expect(list.result?.tools?.map((tool) => tool.name)).toEqual([
      'demo_book_thing',
      'demo_echo_items',
    ]);

    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('demo_book_thing', {}),
      bearer(PARTNER_TOKEN)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResponse;
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain(
      'acts for a signed-in client'
    );
    expect(bookHandlerRuns).toBe(0);
    const lines = await waitForLogs(harness, 2);
    expect(lines[1]).toMatchObject({
      tool: 'demo_book_thing',
      outcome: 'tool_error',
      error_type: 'InsufficientScope',
    });
  });

  it('runs a base-tier tool on a partner token', async () => {
    const harness = await startApp({
      callerAuth: { mode: 'required', validator: stubPartnerValidator() },
    });
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('demo_echo_items', { items: ['a'] }),
      bearer(PARTNER_TOKEN)
    );
    const body = (await res.json()) as RpcResponse;
    expect(body.result?.isError).not.toBe(true);
    expect(body.result?.structuredContent).toEqual({ items: ['a'], count: 1 });
  });
});
