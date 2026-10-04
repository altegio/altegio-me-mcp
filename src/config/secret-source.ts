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
// rotated-out secret can still be scrubbed from output.

export const SECRET_TTL_MS = 60_000;

export interface SecretSource {
  current(): string;
  known(): readonly string[];
  /** Forced re-read, at most once per TTL; resolves true when the value changed. */
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
      if (now() - readAt < ttlMs) return Promise.resolve(false);
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
