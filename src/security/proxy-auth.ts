import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { RequestHandler } from 'express';
import { getCallRecord } from '../observability/call-log.js';

// Proxy-origin check for POST /mcp (OPS-03, D-04). The public run.app address
// cannot be closed to the platform proxy, so this signature is the gate that
// makes the proxy's controls meaningful. The format is the platform's own
// (mcp-proxy backend-auth): v1:<unix-seconds>:<hex HMAC-SHA256> over
//   mcp-proxy-auth/v1, the seconds, the upper-case method, the path and query
//   exactly as sent, and one "name:value" line per x-mcp-auth-* header, sorted
//   by name, joined by newlines.
// The body is not covered. Unlike the platform's reference verifier this one
// never allows a request because no key is configured: an empty key list
// refuses everything, and src/server.ts refuses to start without a key.

export const PROXY_AUTH_HEADER = 'x-mcp-proxy-auth';
export const PROXY_AUTH_SKEW_SEC = 300;
export const MIN_PROXY_KEY_LENGTH = 32;

const SIGNATURE_FORMAT = /^v1:(\d{1,12}):([0-9a-f]{64})$/;
const IDENTITY_PREFIX = 'x-mcp-auth-';
const CANONICAL_VERSION = 'mcp-proxy-auth/v1';

export type ProxyAuthReason =
  'missing' | 'malformed' | 'stale' | 'bad_signature';

export type ProxyAuthResult =
  { ok: true } | { ok: false; reason: ProxyAuthReason };

// A comma-separated list, so a rotation can carry the old and the new key at
// once. Keys shorter than the minimum are dropped, as the platform does.
export function parseProxyKeys(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length >= MIN_PROXY_KEY_LENGTH);
}

function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(', ') : (value ?? '');
}

// Sorted by header NAME, not by whole line: ':' sorts after '-', so when one
// name is a prefix of another the two orders differ and only this one matches
// the platform's signer.
function canonicalString(
  seconds: number,
  method: string,
  path: string,
  headers: IncomingHttpHeaders
): string {
  const identity = Object.keys(headers)
    .filter((name) => name.startsWith(IDENTITY_PREFIX))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => `${name}:${headerText(headers[name])}`);
  return [
    CANONICAL_VERSION,
    String(seconds),
    method.toUpperCase(),
    path,
    ...identity,
  ].join('\n');
}

export function verifyProxyRequest(opts: {
  keys: readonly string[];
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  nowMs?: number;
}): ProxyAuthResult {
  const raw = opts.headers[PROXY_AUTH_HEADER];
  if (typeof raw !== 'string' || raw === '') {
    return { ok: false, reason: 'missing' };
  }
  const match = SIGNATURE_FORMAT.exec(raw);
  if (match === null) return { ok: false, reason: 'malformed' };
  // The platform signs String(Number(ts)), so leading zeros normalise.
  const seconds = Number(match[1]);
  const nowSeconds = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - seconds) > PROXY_AUTH_SKEW_SEC) {
    return { ok: false, reason: 'stale' };
  }
  const received = Buffer.from(match[2] ?? '', 'hex');
  const text = canonicalString(seconds, opts.method, opts.path, opts.headers);
  let accepted = false;
  // Every key is tried even after a match, so timing does not tell which
  // position in the rotation list matched.
  for (const key of opts.keys) {
    const expected = createHmac('sha256', key).update(text, 'utf8').digest();
    if (
      expected.length === received.length &&
      timingSafeEqual(expected, received)
    ) {
      accepted = true;
    }
  }
  return accepted ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

export const PROXY_AUTH_REFUSAL = {
  error: 'proxy_auth_required',
  error_description: 'requests must come through mcp-proxy',
} as const;

// Mounted after the call log (so a refusal is still logged once) and before
// the body parser. The signature header and the keys are never logged.
export function createProxyAuthMiddleware(opts: {
  keys: () => readonly string[];
  now?: () => number;
}): RequestHandler {
  return (req, res, next) => {
    const result = verifyProxyRequest({
      keys: opts.keys(),
      method: req.method,
      path: req.originalUrl,
      headers: req.headers,
      nowMs: opts.now?.(),
    });
    if (result.ok) {
      res.locals.proxyVerified = true;
      const requestId = req.headers['x-mcp-auth-request-id'];
      // The v1 signature covers this identity header. Never adopt unsigned or
      // arbitrary free text as a correlation ID in responses or operational logs.
      if (
        typeof requestId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          requestId
        )
      ) {
        res.locals.requestId = requestId;
        res.setHeader('x-request-id', requestId);
      }
      next();
      return;
    }
    // The reason, never the header, goes on the call record (the call log
    // writes it, throttled).
    getCallRecord(res).auth_reason = result.reason;
    getCallRecord(res).error_type = 'proxy_auth_required';
    res.status(401).json(PROXY_AUTH_REFUSAL);
  };
}
