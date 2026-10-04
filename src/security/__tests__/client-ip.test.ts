import { describe, expect, it } from '@jest/globals';
import {
  classifyClient,
  createSharedEgressList,
  gateKeyOf,
  resolveClientAddress,
} from '../client-ip.js';

const SIGNED = 'x-mcp-auth-client-ip';

function resolve(
  headers: Record<string, string | string[]>,
  overrides: Partial<{
    verified: boolean;
    proxyAuthOn: boolean;
    trustedHops: number;
  }> = {}
): ReturnType<typeof resolveClientAddress> {
  return resolveClientAddress({
    headers,
    verified: true,
    proxyAuthOn: true,
    trustedHops: 1,
    ...overrides,
  });
}

describe('resolveClientAddress (OPS-06, research Pattern 2)', () => {
  it('prefers the address the proxy signs over every forwarded entry', () => {
    expect(
      resolve({
        [SIGNED]: '203.0.113.7',
        'x-forwarded-for': '1.2.3.4, 198.51.100.9, 34.1.1.1',
      })
    ).toEqual({ address: '203.0.113.7', forwardedForCount: 3 });
  });

  it('falls back to the entry TRUSTED_PROXY_HOPS places from the right, never the leftmost', () => {
    const result = resolve({
      'x-forwarded-for': '1.2.3.4, 198.51.100.9, 34.1.1.1',
    });
    expect(result.address).toBe('198.51.100.9');
    expect(result.address).not.toBe('1.2.3.4');
    expect(result.forwardedForCount).toBe(3);
  });

  it('counts hops from the right: 0 is the rightmost entry, 2 the third from the right', () => {
    const headers = { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4' };
    expect(
      resolve(headers, { proxyAuthOn: false, trustedHops: 0 }).address
    ).toBe('4.4.4.4');
    expect(resolve(headers, { trustedHops: 2 }).address).toBe('2.2.2.2');
  });

  it('has no address when the list is shorter than the trusted position', () => {
    expect(resolve({ 'x-forwarded-for': '34.1.1.1' }).address).toBeNull();
    expect(
      resolve({ 'x-forwarded-for': '34.1.1.1' }, { trustedHops: 5 }).address
    ).toBeNull();
  });

  it('resolves null for an entry net.isIP rejects', () => {
    for (const bad of [
      'not-an-ip',
      '198.51.100.9:443',
      '[2001:db8::1]',
      '999.1.1.1',
      'fe80::1%eth0',
    ]) {
      expect(
        resolve({ 'x-forwarded-for': `1.2.3.4, ${bad}, 34.1.1.1` }).address
      ).toBeNull();
    }
    expect(resolve({ [SIGNED]: 'garbage' }).address).toBeNull();
  });

  it('never reads forwarded headers on an unverified request while proxy auth is on', () => {
    expect(
      resolve(
        { [SIGNED]: '203.0.113.7', 'x-forwarded-for': '1.2.3.4, 198.51.100.9' },
        { verified: false }
      )
    ).toEqual({ address: null, forwardedForCount: null });
  });

  it('with PROXY_AUTH off ignores the unsigned header and uses X-Forwarded-For with the hop count', () => {
    const result = resolve(
      { [SIGNED]: '203.0.113.7', 'x-forwarded-for': '1.2.3.4, 198.51.100.9' },
      { verified: false, proxyAuthOn: false, trustedHops: 0 }
    );
    expect(result).toEqual({ address: '198.51.100.9', forwardedForCount: 2 });
  });

  it('has no address and no count when nothing is forwarded', () => {
    expect(resolve({})).toEqual({ address: null, forwardedForCount: null });
  });

  it('accepts an IPv6 address from the signed header', () => {
    expect(resolve({ [SIGNED]: '2001:db8::1' }).address).toBe('2001:db8::1');
  });

  it('joins a repeated X-Forwarded-For header before counting', () => {
    const result = resolve({
      'x-forwarded-for': ['1.2.3.4', '198.51.100.9, 34.1.1.1'],
    });
    expect(result).toEqual({ address: '198.51.100.9', forwardedForCount: 3 });
  });
});

describe('classifyClient (OPS-06 shared egress)', () => {
  const shared = createSharedEgressList(['160.79.104.0/21']);

  it('puts the edges of 160.79.104.0/21 in the pool and the neighbours outside it', () => {
    for (const inside of ['160.79.104.0', '160.79.111.255', '160.79.105.1']) {
      expect(classifyClient(inside, shared)).toEqual({
        kind: 'pool',
        key: 'pool',
      });
    }
    expect(classifyClient('160.79.103.255', shared)).toEqual({
      kind: 'ip',
      key: 'ip:160.79.103.255',
    });
    expect(classifyClient('160.79.112.0', shared)).toEqual({
      kind: 'ip',
      key: 'ip:160.79.112.0',
    });
  });

  it('matches an IPv4-mapped IPv6 address against the IPv4 range', () => {
    expect(classifyClient('::ffff:160.79.105.1', shared).kind).toBe('pool');
    expect(classifyClient('::ffff:a00:1', shared)).toEqual({
      kind: 'ip',
      key: 'ip:10.0.0.1',
    });
  });

  it('keys two IPv6 addresses in one /64 together and different /64s apart', () => {
    const a = classifyClient('2001:db8:1:2::1', shared);
    const b = classifyClient('2001:db8:1:2:ffff:ffff:ffff:ffff', shared);
    const c = classifyClient('2001:db8:1:3::1', shared);
    expect(a.kind).toBe('ip');
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
    expect(a.key.startsWith('ip:')).toBe(true);
  });

  it('classifies a missing address as unknown with the single key unknown', () => {
    expect(classifyClient(null, shared)).toEqual({
      kind: 'unknown',
      key: 'unknown',
    });
  });

  it('supports IPv6 entries in the shared list', () => {
    const list = createSharedEgressList(['2001:db8::/32']);
    expect(classifyClient('2001:db8:ffff::1', list).kind).toBe('pool');
    expect(classifyClient('2001:db9::1', list).kind).toBe('ip');
  });

  it('refuses a malformed CIDR', () => {
    expect(() => createSharedEgressList(['not-a-cidr'])).toThrow();
    expect(() => createSharedEgressList(['160.79.104.0/33'])).toThrow();
  });
});

describe('gateKeyOf', () => {
  it('is null for the pool, so the gate never caps it, and the key otherwise', () => {
    expect(gateKeyOf({ kind: 'pool', key: 'pool' })).toBeNull();
    expect(gateKeyOf({ kind: 'ip', key: 'ip:203.0.113.7' })).toBe(
      'ip:203.0.113.7'
    );
    expect(gateKeyOf({ kind: 'unknown', key: 'unknown' })).toBe('unknown');
  });
});
