import { BlockList } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';

export interface ClientAddress {
  address: string | null;
  forwardedForCount: number | null;
}

export interface ClientClassification {
  kind: 'pool' | 'ip' | 'unknown';
  key: string;
}

// Stub: replaced by the implementation in the next commit.
export function resolveClientAddress(_opts: {
  headers: IncomingHttpHeaders;
  verified: boolean;
  proxyAuthOn: boolean;
  trustedHops: number;
}): ClientAddress {
  return { address: null, forwardedForCount: null };
}

export function createSharedEgressList(_cidrs: readonly string[]): BlockList {
  return new BlockList();
}

export function classifyClient(
  _address: string | null,
  _shared: BlockList
): ClientClassification {
  return { kind: 'unknown', key: 'unknown' };
}

export function gateKeyOf(classification: ClientClassification): string | null {
  return classification.key;
}
