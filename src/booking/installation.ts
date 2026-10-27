import type { BookingClient } from './client.js';
import type { GateCallOptions } from './http.js';

// The assistant-booking gate (ADR 0006, D3 amended 2026-10-27). A business
// takes bookings from the chat while this server's Integrations Hub
// application is active at its location. Altegio switches the application on
// for every location that has Altegio.me; an owner who removes it in
// Integrations turns the chat bookings off, and the Hub then answers 404 for
// that location, exactly as for a location that never had it. So the gate
// asks one question, "is it installed?", and never "was it removed?".
//
// Verdicts are cached per location, both ways, so a preview and its confirm
// cost one Hub call. A Hub that cannot answer does not close the business:
// the verdict is then `unknown`, the caller books as before, and the failure
// is reported once per cache entry.

export type InstallationVerdict = 'accepts' | 'declines' | 'unknown';

/** How long a verdict from the Hub is reused. */
export const INSTALLATION_CACHE_TTL_MS = 10 * 60_000;
/** How long an `unknown` verdict is reused, so an outage is not hammered. */
export const INSTALLATION_UNKNOWN_TTL_MS = 30_000;
export const INSTALLATION_CACHE_MAX = 10_000;

export interface InstallationGate {
  /** The marketplace application the gate asks about. */
  readonly applicationId: number;
  /** Whether the business at `locationId` takes bookings from the chat. */
  verdict(
    locationId: number,
    call?: GateCallOptions
  ): Promise<InstallationVerdict>;
}

export interface InstallationGateOptions {
  booking: Pick<BookingClient, 'installationStatus'>;
  applicationId: number;
  ttlMs?: number;
  unknownTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
  /** Called once per cache entry when the Hub could not say. */
  onUnavailable?: (locationId: number, error: unknown) => void;
}

interface CacheEntry {
  verdict: InstallationVerdict;
  expiresAt: number;
}

export function createInstallationGate(
  options: InstallationGateOptions
): InstallationGate {
  const { booking, applicationId } = options;
  if (!Number.isInteger(applicationId) || applicationId <= 0) {
    throw new Error(
      'installation gate: applicationId must be a positive integer'
    );
  }
  const ttlMs = options.ttlMs ?? INSTALLATION_CACHE_TTL_MS;
  const unknownTtlMs = options.unknownTtlMs ?? INSTALLATION_UNKNOWN_TTL_MS;
  const maxEntries = options.maxEntries ?? INSTALLATION_CACHE_MAX;
  const now = options.now ?? Date.now;
  const cache = new Map<number, CacheEntry>();
  const inflight = new Map<number, Promise<InstallationVerdict>>();

  async function ask(
    locationId: number,
    call: GateCallOptions | undefined
  ): Promise<InstallationVerdict> {
    try {
      const status = await booking.installationStatus(
        locationId,
        applicationId,
        { signal: call?.signal, key: call?.key }
      );
      // `pending` is an owner's grant the partner has not confirmed yet: the
      // owner asked for it, so the business is open.
      return status === 'active' || status === 'pending'
        ? 'accepts'
        : 'declines';
    } catch (error) {
      options.onUnavailable?.(locationId, error);
      return 'unknown';
    }
  }

  function remember(locationId: number, verdict: InstallationVerdict): void {
    // Insertion order is age: the oldest entry goes first.
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.delete(locationId);
    cache.set(locationId, {
      verdict,
      expiresAt: now() + (verdict === 'unknown' ? unknownTtlMs : ttlMs),
    });
  }

  return {
    applicationId,
    async verdict(locationId, call) {
      const hit = cache.get(locationId);
      if (hit !== undefined && hit.expiresAt > now()) return hit.verdict;
      let asking = inflight.get(locationId);
      if (asking === undefined) {
        asking = ask(locationId, call)
          .then((verdict) => {
            remember(locationId, verdict);
            return verdict;
          })
          .finally(() => {
            inflight.delete(locationId);
          });
        inflight.set(locationId, asking);
      }
      return asking;
    },
  };
}
