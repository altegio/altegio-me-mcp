import type { IncomingHttpHeaders } from 'node:http';
import { BlockList, isIP, isIPv4 } from 'node:net';

// Which client a request belongs to (OPS-06, research Pattern 2). Behind the
// platform proxy the TCP peer is always Google's front end and the leftmost
// X-Forwarded-For entry is chosen by the caller, so only two sources say who
// the caller is: the address the proxy signs into x-mcp-auth-client-ip, and the
// X-Forwarded-For entry a known number of hops from the right. Forwarded data
// is read only on a request whose proxy signature passed. An address is an
// input to classifyClient and is never stored or logged.

export const CLIENT_IP_HEADER = 'x-mcp-auth-client-ip';

export interface ClientAddress {
  /** A syntactically valid address, or null when none is usable. */
  address: string | null;
  /** How many X-Forwarded-For entries the request carried; null when none. */
  forwardedForCount: number | null;
}

export interface ClientClassification {
  kind: 'pool' | 'ip' | 'unknown';
  /** 'pool', 'ip:<address or IPv6 /64 prefix>' or 'unknown'. */
  key: string;
}

function isUsableAddress(value: string): boolean {
  // A zone id ("fe80::1%eth0") means nothing outside the host that wrote it.
  return isIP(value) !== 0 && !value.includes('%');
}

function forwardedForEntries(headers: IncomingHttpHeaders): string[] | null {
  const raw = headers['x-forwarded-for'];
  const text = Array.isArray(raw) ? raw.join(', ') : raw;
  if (text === undefined || text.trim() === '') return null;
  return text.split(',').map((entry) => entry.trim());
}

export function resolveClientAddress(opts: {
  headers: IncomingHttpHeaders;
  verified: boolean;
  proxyAuthOn: boolean;
  trustedHops: number;
}): ClientAddress {
  const { headers, verified, proxyAuthOn, trustedHops } = opts;
  // An unsigned request cannot vouch for any forwarded data (T-03-23).
  if (proxyAuthOn && !verified) {
    return { address: null, forwardedForCount: null };
  }

  const entries = forwardedForEntries(headers);
  const forwardedForCount = entries === null ? null : entries.length;

  // Preferred: the proxy signs this header, so the signature that just passed
  // covers its value. With PROXY_AUTH off nothing signed it, so it is ignored.
  if (proxyAuthOn) {
    const signed = headers[CLIENT_IP_HEADER];
    if (typeof signed === 'string' && isUsableAddress(signed)) {
      return { address: signed, forwardedForCount };
    }
  }

  // Fallback: count from the right, where our own front end appended what it
  // saw. The leftmost entries are whatever the caller sent.
  if (entries === null) return { address: null, forwardedForCount };
  const candidate = entries[entries.length - 1 - trustedHops];
  return {
    address:
      candidate !== undefined && isUsableAddress(candidate) ? candidate : null,
    forwardedForCount,
  };
}

// An IPv6 address as eight 16-bit groups. The input has passed net.isIP, so a
// failure here returns null rather than throwing.
function hextetsOf(address: string): number[] | null {
  let text = address.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!isIPv4(tail)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = (halves[0] ?? '') === '' ? [] : (halves[0] ?? '').split(':');
  const rest = (halves[1] ?? '') === '' ? [] : (halves[1] ?? '').split(':');
  let groups: string[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...rest];
  }
  if (groups.length !== 8) return null;
  const numbers = groups.map((group) => Number.parseInt(group, 16));
  return numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)
    ? null
    : numbers;
}

interface Normalized {
  family: 'ipv4' | 'ipv6';
  /** Canonical text: dotted for IPv4, the input for IPv6. */
  text: string;
  hextets: number[] | null;
}

// An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is the IPv4 address.
function normalize(address: string): Normalized {
  if (isIPv4(address)) return { family: 'ipv4', text: address, hextets: null };
  const hextets = hextetsOf(address);
  if (
    hextets !== null &&
    hextets.slice(0, 5).every((group) => group === 0) &&
    hextets[5] === 0xffff
  ) {
    const high = hextets[6] ?? 0;
    const low = hextets[7] ?? 0;
    return {
      family: 'ipv4',
      text: `${String(high >> 8)}.${String(high & 0xff)}.${String(low >> 8)}.${String(low & 0xff)}`,
      hextets: null,
    };
  }
  return { family: 'ipv6', text: address, hextets };
}

interface ParsedCidr {
  address: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
}

function parseCidr(cidr: string): ParsedCidr | null {
  const parts = cidr.split('/');
  const [address, prefixText] = parts;
  if (parts.length !== 2 || address === undefined || prefixText === undefined) {
    return null;
  }
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const family = isIP(address);
  if (family === 0 || address.includes('%')) return null;
  const prefix = Number(prefixText);
  if (prefix > (family === 4 ? 32 : 128)) return null;
  return { address, prefix, family: family === 4 ? 'ipv4' : 'ipv6' };
}

export function isValidCidr(cidr: string): boolean {
  return parseCidr(cidr) !== null;
}

/** IPv4 and IPv6 CIDR entries; throws on a malformed one. */
export function createSharedEgressList(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const parsed = parseCidr(cidr);
    if (parsed === null) throw new Error('Invalid CIDR in the shared list');
    list.addSubnet(parsed.address, parsed.prefix, parsed.family);
  }
  return list;
}

export function classifyClient(
  address: string | null,
  shared: BlockList
): ClientClassification {
  if (address === null || !isUsableAddress(address)) {
    return { kind: 'unknown', key: 'unknown' };
  }
  const normalized = normalize(address);
  if (shared.check(normalized.text, normalized.family)) {
    return { kind: 'pool', key: 'pool' };
  }
  if (normalized.family === 'ipv4' || normalized.hextets === null) {
    return { kind: 'ip', key: `ip:${normalized.text}` };
  }
  // One /64 is one subscriber, however many addresses it rotates through.
  const prefix = normalized.hextets
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':');
  return { kind: 'ip', key: `ip:${prefix}::/64` };
}

/** The key for the gate's per-key queue cap; the pool is never capped. */
export function gateKeyOf(classification: ClientClassification): string | null {
  return classification.kind === 'pool' ? null : classification.key;
}
