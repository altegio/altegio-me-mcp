import { readFile } from 'node:fs/promises';
import type { Logger } from 'pino';

// A secret read from a mounted file, so a Secret Manager rotation reaches a
// running instance without a redeploy (OPS-04). Cloud Run re-reads a volume on
// every read but freezes an environment variable at instance start.
//
// There is no timer of any kind: with request-based CPU a timer does not run
// between requests, so the refresh is lazy, on the request path (research
// Pitfall 14). current() returns the cached value at once; when the value is
// older than SECRET_TTL_MS it starts at most one background re-read whose
// result serves the calls after it. A failed or empty re-read keeps the last
// good value. known() returns the current and the previous value, so a
// rotated-out secret can still be scrubbed from output. refresh() is the
// forced re-read for a caller that was refused with the cached value: it does
// not depend on how recently the lazy re-read ran, only on its own pace of one
// per TTL.

export const SECRET_TTL_MS = 60_000;

export interface SecretSource {
  current(): string;
  known(): readonly string[];
  /**
   * Forced re-read for a caller the upstream refused, at most one per TTL
   * counted from the last forced one (a lazy re-read does not use it up).
   * Joins a re-read that is already running. Resolves true when the value
   * changed.
   */
  refresh(): Promise<boolean>;
}

export interface FileSecretSourceOptions {
  path: string;
  /** The setting that names the file, for messages. Never a value. */
  setting: string;
  ttlMs?: number;
  now?: () => number;
  readFile?: (path: string) => Promise<string>;
  logger?: Logger;
}

const FAILURE_LOG_INTERVAL_MS = 60_000;

function trimmed(text: string): string {
  return text.replace(/[\r\n]+$/, '').trim();
}

export async function createFileSecretSource(
  opts: FileSecretSourceOptions
): Promise<SecretSource> {
  const ttlMs = opts.ttlMs ?? SECRET_TTL_MS;
  const now = opts.now ?? Date.now;
  const read =
    opts.readFile ?? ((path: string) => readFile(path, { encoding: 'utf8' }));

  let value = trimmed(await read(opts.path));
  if (value === '') {
    throw new Error(`${opts.setting} points to an empty file`);
  }
  let previous: string | null = null;
  let readAt = now();
  let inFlight: Promise<boolean> | null = null;
  let lastFailureLogAt = Number.NEGATIVE_INFINITY;
  let lastForcedAt = Number.NEGATIVE_INFINITY;

  const reportFailure = (): void => {
    const at = now();
    if (at - lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) return;
    lastFailureLogAt = at;
    opts.logger?.warn(
      { event: 'secret_refresh_failed', setting: opts.setting },
      'secret refresh failed, keeping the last good value'
    );
  };

  const reread = (): Promise<boolean> => {
    if (inFlight !== null) return inFlight;
    readAt = now();
    inFlight = read(opts.path)
      .then((text) => {
        const next = trimmed(text);
        if (next === '') {
          reportFailure();
          return false;
        }
        if (next === value) return false;
        previous = value;
        value = next;
        return true;
      })
      .catch(() => {
        reportFailure();
        return false;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    current(): string {
      if (now() - readAt >= ttlMs) void reread();
      return value;
    },
    known(): readonly string[] {
      return previous === null ? [value] : [value, previous];
    },
    refresh(): Promise<boolean> {
      if (inFlight !== null) return inFlight;
      const at = now();
      // As in the failure log: a clock that steps backwards never blocks it.
      const gap = at - lastForcedAt;
      if (gap >= 0 && gap < ttlMs) return Promise.resolve(false);
      lastForcedAt = at;
      return reread();
    },
  };
}

export function createStaticSecretSource(secret: string): SecretSource {
  return {
    current: () => secret,
    known: () => [secret],
    refresh: () => Promise.resolve(false),
  };
}

/**
 * Every individual value a source holds or held (current and previous), for a
 * scrub list. known() returns whole payloads, so a key list such as 'old,new'
 * comes back as one comma string that would never match a single key quoted on
 * its own; `split` turns a payload into its values (parseProxyKeys for the
 * proxy key). Without `split` a payload is one value, as the partner token is.
 */
export function knownValues(
  source: SecretSource,
  split: (payload: string) => readonly string[] = (payload) => [payload]
): string[] {
  return [...new Set(source.known().flatMap((payload) => split(payload)))];
}
