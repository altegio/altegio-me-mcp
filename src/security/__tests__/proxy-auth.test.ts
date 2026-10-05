import { describe, expect, it } from '@jest/globals';
import { signProxyRequest } from '../../__tests__/helpers/sign-request.js';
import {
  MIN_PROXY_KEY_LENGTH,
  PROXY_AUTH_HEADER,
  PROXY_AUTH_SKEW_SEC,
  parseProxyKeys,
  verifyProxyRequest,
} from '../proxy-auth.js';

// Golden vectors computed with the platform's reference signer (research
// Pattern 1). The key is a test value, not a secret.
const KEY = 'test-key-0123456789abcdef0123456789abcdef';
const NOW_MS = 1_700_000_000_000;

const VECTOR_PLAIN =
  'v1:1700000000:ba8b194a034949a4780c01aa8748f4ffb56cbb842b5e82691062952b1f535c48';
const VECTOR_IDENTITY =
  'v1:1700000000:9f1feecf7ef96e864e8b87e23aea94f17da45d5dab8f02acf62cc861d7e9e6a7';
const VECTOR_PREFIX_NAMES =
  'v1:1700000000:19d408a3f3d41fd909fd2bd8ce0e1156d38baa9e3cfda7a78ed1aefa4589985e';

// Mixed case on the way in, as a client can send it; Node lower-cases names
// before a handler sees them.
const IDENTITY_HEADERS = {
  'X-MCP-Auth-Client-Ip': '203.0.113.7',
  'x-mcp-auth-kind': 'anonymous',
  'content-type': 'application/json',
};
const PREFIX_HEADERS = {
  'x-mcp-auth-kind': 'anonymous',
  'x-mcp-auth-kind-extra': 'z',
};

function lowerCased(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
}

function verify(
  signature: string | undefined,
  overrides: {
    path?: string;
    headers?: Record<string, string>;
    keys?: readonly string[];
    nowMs?: number;
    method?: string;
  } = {}
): ReturnType<typeof verifyProxyRequest> {
  const headers: Record<string, string> = lowerCased(overrides.headers ?? {});
  if (signature !== undefined) headers[PROXY_AUTH_HEADER] = signature;
  return verifyProxyRequest({
    keys: overrides.keys ?? [KEY],
    method: overrides.method ?? 'POST',
    path: overrides.path ?? '/mcp',
    headers,
    nowMs: overrides.nowMs ?? NOW_MS,
  });
}

describe('constants', () => {
  it('match the platform signer', () => {
    expect(PROXY_AUTH_HEADER).toBe('x-mcp-proxy-auth');
    expect(PROXY_AUTH_SKEW_SEC).toBe(300);
    expect(MIN_PROXY_KEY_LENGTH).toBe(32);
  });
});

describe('golden vectors from the platform signer', () => {
  it('signs a request without identity headers as the platform does', () => {
    expect(
      signProxyRequest({
        key: KEY,
        method: 'POST',
        path: '/mcp',
        nowMs: NOW_MS,
      })
    ).toBe(VECTOR_PLAIN);
    expect(verify(VECTOR_PLAIN)).toEqual({ ok: true });
  });

  it('covers x-mcp-auth-* headers and the query, and ignores other headers', () => {
    expect(
      signProxyRequest({
        key: KEY,
        method: 'POST',
        path: '/mcp?x=1',
        headers: IDENTITY_HEADERS,
        nowMs: NOW_MS,
      })
    ).toBe(VECTOR_IDENTITY);
    expect(
      verify(VECTOR_IDENTITY, { path: '/mcp?x=1', headers: IDENTITY_HEADERS })
    ).toEqual({ ok: true });
  });

  it('sorts identity headers by name, so a prefix name sorts before its extension', () => {
    expect(
      signProxyRequest({
        key: KEY,
        method: 'POST',
        path: '/mcp',
        headers: PREFIX_HEADERS,
        nowMs: NOW_MS,
      })
    ).toBe(VECTOR_PREFIX_NAMES);
    expect(verify(VECTOR_PREFIX_NAMES, { headers: PREFIX_HEADERS })).toEqual({
      ok: true,
    });
  });

  it('rejects a changed x-mcp-auth-client-ip as bad_signature', () => {
    expect(
      verify(VECTOR_IDENTITY, {
        path: '/mcp?x=1',
        headers: { ...IDENTITY_HEADERS, 'x-mcp-auth-client-ip': '203.0.113.8' },
      })
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects the first vector 301 s later as stale', () => {
    expect(verify(VECTOR_PLAIN, { nowMs: NOW_MS + 301_000 })).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('accepts the edge of the skew window in both directions', () => {
    expect(verify(VECTOR_PLAIN, { nowMs: NOW_MS + 300_000 })).toEqual({
      ok: true,
    });
    expect(verify(VECTOR_PLAIN, { nowMs: NOW_MS - 300_000 })).toEqual({
      ok: true,
    });
    expect(verify(VECTOR_PLAIN, { nowMs: NOW_MS - 301_000 })).toEqual({
      ok: false,
      reason: 'stale',
    });
  });
});

describe('what the signature binds', () => {
  it('rejects another path or query than the one signed', () => {
    expect(verify(VECTOR_PLAIN, { path: '/mcp?x=1' })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verify(VECTOR_PLAIN, { path: '/other' })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects another method', () => {
    expect(verify(VECTOR_PLAIN, { method: 'GET' })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects an identity header the proxy did not sign', () => {
    expect(
      verify(VECTOR_PLAIN, { headers: { 'x-mcp-auth-kind': 'admin' } })
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('joins a repeated header with a comma and a space', () => {
    const signature = signProxyRequest({
      key: KEY,
      method: 'POST',
      path: '/mcp',
      headers: { 'x-mcp-auth-kind': 'a, b' },
      nowMs: NOW_MS,
    });
    const result = verifyProxyRequest({
      keys: [KEY],
      method: 'POST',
      path: '/mcp',
      headers: {
        'x-mcp-auth-kind': ['a', 'b'],
        [PROXY_AUTH_HEADER]: signature,
      },
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('refusals', () => {
  it.each([undefined, ''])(
    'reports a missing header (%j) as missing',
    (raw) => {
      expect(verify(raw)).toEqual({ ok: false, reason: 'missing' });
    }
  );

  it.each([
    'garbage',
    'v2:1700000000:ba8b194a034949a4780c01aa8748f4ffb56cbb842b5e82691062952b1f535c48',
    'v1:1700000000:BA8B194A034949A4780C01AA8748F4FFB56CBB842B5E82691062952B1F535C48',
    'v1:1700000000:ba8b',
    'v1:-1:ba8b194a034949a4780c01aa8748f4ffb56cbb842b5e82691062952b1f535c48',
    'v1:1700000000:ba8b194a034949a4780c01aa8748f4ffb56cbb842b5e82691062952b1f535c48 ',
  ])('reports %j as malformed', (raw) => {
    expect(verify(raw)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a request signed with another key', () => {
    expect(
      verify(VECTOR_PLAIN, {
        keys: ['another-key-0123456789abcdef0123456789abcdef'],
      })
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses everything when no key is configured (never fails open)', () => {
    expect(verify(VECTOR_PLAIN, { keys: [] })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verify(undefined, { keys: [] })).toEqual({
      ok: false,
      reason: 'missing',
    });
  });
});

describe('a key list for rotation', () => {
  const OLD_KEY = 'old-key-0123456789abcdef0123456789abcdef0';

  it('accepts a signature made with any listed key', () => {
    const withOld = signProxyRequest({
      key: OLD_KEY,
      method: 'POST',
      path: '/mcp',
      nowMs: NOW_MS,
    });
    expect(verify(withOld, { keys: [KEY, OLD_KEY] })).toEqual({ ok: true });
    expect(verify(VECTOR_PLAIN, { keys: [OLD_KEY, KEY] })).toEqual({
      ok: true,
    });
    expect(verify(withOld, { keys: [KEY] })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});

describe('parseProxyKeys', () => {
  it('splits a comma list, trims, and drops keys shorter than 32 characters', () => {
    expect(parseProxyKeys(` ${KEY} , short ,${KEY}x`)).toEqual([
      KEY,
      `${KEY}x`,
    ]);
  });

  it.each([undefined, '', ' , ', 'only-short'])(
    'yields no key for %j',
    (raw) => {
      expect(parseProxyKeys(raw)).toEqual([]);
    }
  );

  it('keeps a key of exactly the minimum length', () => {
    const key = 'k'.repeat(MIN_PROXY_KEY_LENGTH);
    expect(parseProxyKeys(key)).toEqual([key]);
    expect(parseProxyKeys(key.slice(1))).toEqual([]);
  });
});
