import { createHmac } from 'node:crypto';

// Test and load-test signer. It mirrors the platform's signBackendRequest, and
// is written independently of the verifier in src/security/proxy-auth.ts so
// the golden vectors pin the verifier to the platform's format.

export function signProxyRequest(opts: {
  key: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  nowMs?: number;
}): string {
  const seconds = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const identity = Object.entries(opts.headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .filter(([name]) => name.startsWith('x-mcp-auth-'))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}:${value}`);
  const text = [
    'mcp-proxy-auth/v1',
    String(seconds),
    opts.method.toUpperCase(),
    opts.path,
    ...identity,
  ].join('\n');
  const mac = createHmac('sha256', opts.key).update(text, 'utf8').digest('hex');
  return `v1:${String(seconds)}:${mac}`;
}
