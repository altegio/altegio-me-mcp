import { createHash } from 'node:crypto';
import type { PartnerTokenVerdict } from '../booking/client.js';

// Validation of a caller's Altegio partner token (ADR 0004). Altegio is the
// only authority on its partner tokens, so a token is valid when Altegio
// accepts it on the probe call (BookingClient.probePartnerToken). Verdicts are
// cached by a hash of the token, never by the token: a valid one for five
// minutes, so a busy partner costs one probe per five minutes, an invalid one
// for thirty seconds, so a revoked token stops working soon. 'unavailable'
// (Altegio did not answer) is never cached and never treated as invalid.
// Concurrent checks of one token share a single probe.

export const PARTNER_TOKEN_VALID_TTL_MS = 5 * 60_000;
export const PARTNER_TOKEN_INVALID_TTL_MS = 30_000;
export const PARTNER_TOKEN_CACHE_MAX = 10_000;
/** Budget of one probe, gate wait included; below the tool-call deadline. */
export const PARTNER_TOKEN_PROBE_TIMEOUT_MS = 8_000;

// Printable ASCII without spaces, a sane length: anything else is refused
// without a probe, so garbage costs no upstream call.
const TOKEN_SHAPE = /^[\x21-\x7E]{8,512}$/;

/** True for 8 to 512 printable ASCII characters without spaces: a token worth sending upstream. */
export function isTokenShaped(token: string): boolean {
  return TOKEN_SHAPE.test(token);
}

/**
 * A stable pseudonym for a partner token: the first 16 hex digits of its
 * SHA-256, the same form as the platform proxy's `token_hash`, so our call log
 * and the proxy's request line group one partner the same way.
 */
export function partnerIdOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);
}

export interface PartnerTokenValidator {
  validate(token: string): Promise<PartnerTokenVerdict>;
}

export interface PartnerTokenValidatorOptions {
  /** One upstream check of the token; the signal bounds it. */
  probe: (token: string, signal: AbortSignal) => Promise<PartnerTokenVerdict>;
  validTtlMs?: number;
  invalidTtlMs?: number;
  maxEntries?: number;
  /** Maximum concurrent distinct token probes; duplicate checks still share. */
  maxPending?: number;
  timeoutMs?: number;
  now?: () => number;
}

interface CacheEntry {
  verdict: 'valid' | 'invalid';
  expiresAt: number;
}

export function createPartnerTokenValidator(
  options: PartnerTokenValidatorOptions
): PartnerTokenValidator {
  const validTtlMs = options.validTtlMs ?? PARTNER_TOKEN_VALID_TTL_MS;
  const invalidTtlMs = options.invalidTtlMs ?? PARTNER_TOKEN_INVALID_TTL_MS;
  const maxEntries = options.maxEntries ?? PARTNER_TOKEN_CACHE_MAX;
  const maxPending = options.maxPending ?? 64;
  const timeoutMs = options.timeoutMs ?? PARTNER_TOKEN_PROBE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<PartnerTokenVerdict>>();

  const remember = (key: string, verdict: 'valid' | 'invalid'): void => {
    cache.delete(key);
    cache.set(key, {
      verdict,
      expiresAt: now() + (verdict === 'valid' ? validTtlMs : invalidTtlMs),
    });
    // Insertion order is age order: the first key is the oldest entry.
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
  };

  const check = async (
    key: string,
    token: string
  ): Promise<PartnerTokenVerdict> => {
    let verdict: PartnerTokenVerdict;
    try {
      verdict = await options.probe(token, AbortSignal.timeout(timeoutMs));
    } catch {
      verdict = 'unavailable';
    }
    if (verdict !== 'unavailable') remember(key, verdict);
    return verdict;
  };

  return {
    validate(token: string): Promise<PartnerTokenVerdict> {
      if (!isTokenShaped(token)) return Promise.resolve('invalid');
      const key = createHash('sha256').update(token, 'utf8').digest('hex');
      const hit = cache.get(key);
      if (hit !== undefined) {
        if (hit.expiresAt > now()) return Promise.resolve(hit.verdict);
        cache.delete(key);
      }
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;
      if (inFlight.size >= maxPending) return Promise.resolve('unavailable');
      const started = check(key, token).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, started);
      return started;
    },
  };
}
