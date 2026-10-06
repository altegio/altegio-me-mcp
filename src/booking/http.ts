import {
  createStaticSecretSource,
  type SecretSource,
} from '../config/secret-source.js';
import { scrubSecrets } from '../observability/redact.js';
import { UpstreamError, type UpstreamErrorKind } from './errors.js';
import {
  abortReason,
  DEFAULT_RETRY_AFTER_SECONDS,
  GateSaturatedError,
  INLINE_RETRY_MAX_SECONDS,
  retryAfterSeconds,
} from './gate.js';

// One HTTP exchange with the Altegio API: headers, URL building, timeout,
// envelope parsing and status mapping. Matches Altegio.Pro MCP (D-10): the
// v2 Accept header and the partner token as a Bearer credential. The token
// travels only in the Authorization header, never in the URL.
//
// The token comes from a SecretSource, so a rotation by the platform reaches
// the running process without a restart (OPS-04): the Authorization header is
// built from the source's current value on every attempt, an upstream 401 or
// 403 forces one re-read and, when the token changed, one retry, and upstream
// messages are scrubbed with the current and the previous token.
//
// A call may instead carry the caller's own partner token (ADR 0004): it is
// sent in place of the server's, a 401 or 403 is never retried with another
// token (the caller's token was refused, not rotated), and upstream messages
// are scrubbed with it.

export const ALTEGIO_ACCEPT = 'application/vnd.api.v2+json';
export const UPSTREAM_TIMEOUT_MS = 10_000;

/** What one upstream call tells the gate about its caller. */
export interface GateCallOptions {
  /** Aborts the call: a queued call leaves the gate, a started one stops. */
  signal?: AbortSignal;
  /** Caller identity for the per-key queue cap; null or missing is uncapped. */
  key?: string | null;
}

/** What a tool hands the booking client for one upstream call. */
export interface UpstreamCallOptions extends GateCallOptions {
  /** The caller's validated partner token; missing signs with the server's. */
  partnerToken?: string;
}

/** Admission control for upstream calls; the throttle implements it. */
export interface GateLike {
  run<T>(start: () => Promise<T>, opts?: GateCallOptions): Promise<T>;
  pauseUntil(untilMs: number): void;
}

/** Runs every call at once and ignores pauses. */
export const PASS_THROUGH_GATE: GateLike = Object.freeze({
  run<T>(start: () => Promise<T>, opts?: GateCallOptions): Promise<T> {
    if (opts?.signal?.aborted === true) {
      return Promise.reject(abortReason(opts.signal));
    }
    return start();
  },
  pauseUntil(): void {
    // Nothing to pause.
  },
});

export interface BookingHttpOptions {
  base: string;
  /** A plain token, wrapped in a static source. Exactly one of token and tokenSource. */
  token?: string;
  /** A token that can change while the process runs. */
  tokenSource?: SecretSource;
  fetch?: typeof fetch;
  gate?: GateLike;
  timeoutMs?: number;
  /** Clock for rate-limit pauses; defaults to Date.now. */
  now?: () => number;
}

export interface UpstreamCallSpec extends UpstreamCallOptions {
  method: 'GET' | 'POST';
  /** Route template, for example '/company/{location_id}'. */
  route: string;
  /** Concrete path built from integers, for example '/company/722227'. */
  path: string;
  query?: Readonly<Record<string, string | number | undefined>>;
  /** Sent as repeated service_ids[] entries, in this order. */
  serviceIds?: readonly number[];
  /** JSON body, POST only. */
  body?: unknown;
}

export interface UpstreamReply {
  status: number;
  /** envelope.data, or null for an empty 2xx body. */
  data: unknown;
}

/** BAPI-01: every non-2xx status maps to exactly one kind. */
function kindOfStatus(status: number): UpstreamErrorKind {
  if (status === 400) return 'bad_request';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 422) return 'rejected';
  if (status === 429) return 'rate_limited';
  if (status >= 500 && status <= 599) return 'unavailable';
  return 'contract_drift';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimeout(error: unknown): boolean {
  return isRecord(error) && error.name === 'TimeoutError';
}

/**
 * The tool call ended before the API answered: its deadline passed or its
 * client went away. Never worded like the per-fetch timeout, so the log tells
 * the three apart.
 */
function cancelledError(route: string, signal: AbortSignal): UpstreamError {
  const reason: unknown = signal.reason;
  return new UpstreamError('unavailable', route, {
    cause: new Error(
      isTimeout(reason)
        ? 'Altegio API call stopped: the tool call ran out of time'
        : 'Altegio API call cancelled: the tool call was dropped',
      { cause: reason }
    ),
  });
}

/** envelope.data of a 2xx body; null for an empty body. */
function parseEnvelopeData(
  route: string,
  status: number,
  text: string
): unknown {
  if (text === '') return null;
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch (error) {
    throw new UpstreamError('contract_drift', route, { status, cause: error });
  }
  if (!isRecord(envelope)) {
    throw new UpstreamError('contract_drift', route, { status });
  }
  return envelope.data ?? null;
}

/**
 * meta.message and the numeric meta.errors[].code of an error envelope. A
 * body that is not such an envelope gives neither; the body itself is never
 * kept.
 */
function readErrorMeta(text: string): {
  message: string | null;
  codes: number[];
} {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { message: null, codes: [] };
  }
  const meta = isRecord(envelope) ? envelope.meta : undefined;
  if (!isRecord(meta)) return { message: null, codes: [] };
  const errors = Array.isArray(meta.errors) ? (meta.errors as unknown[]) : [];
  const codes = errors.flatMap((entry) =>
    isRecord(entry) &&
    typeof entry.code === 'number' &&
    Number.isInteger(entry.code)
      ? [entry.code]
      : []
  );
  return {
    message: typeof meta.message === 'string' ? meta.message : null,
    codes,
  };
}

/** One finished HTTP exchange, before status mapping. */
interface RawReply {
  status: number;
  headers: Headers;
  text: string;
}

export class BookingHttp {
  private readonly base: string;
  private readonly tokenSource: SecretSource;
  private readonly fetchImpl: typeof fetch;
  private readonly gate: GateLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: BookingHttpOptions) {
    this.base = options.base.endsWith('/')
      ? options.base.slice(0, -1)
      : options.base;
    if ((options.token === undefined) === (options.tokenSource === undefined)) {
      throw new Error('BookingHttp needs exactly one of token and tokenSource');
    }
    this.tokenSource =
      options.tokenSource ?? createStaticSecretSource(options.token ?? '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.gate = options.gate ?? PASS_THROUGH_GATE;
    this.timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  async send(call: UpstreamCallSpec): Promise<UpstreamReply> {
    const url = new URL(`${this.base}${call.path}`);
    for (const [key, value] of Object.entries(call.query ?? {})) {
      if (value !== undefined) url.searchParams.append(key, String(value));
    }
    for (const id of call.serviceIds ?? []) {
      url.searchParams.append('service_ids[]', String(id));
    }

    const hasBody = call.body !== undefined;
    const body = hasBody ? JSON.stringify(call.body) : undefined;
    // Built per attempt: a retry after a rotation carries the new token.
    const initFor = (token: string): RequestInit => {
      const headers: Record<string, string> = {
        Accept: ALTEGIO_ACCEPT,
        Authorization: `Bearer ${token}`,
      };
      if (hasBody) headers['Content-Type'] = 'application/json';
      return {
        method: call.method,
        headers,
        body,
        // A redirect would carry the partner token to another URL; it is
        // reported as an unexpected status instead.
        redirect: 'manual',
      };
    };

    const caller: GateCallOptions = { signal: call.signal, key: call.key };
    const callerToken = call.partnerToken;
    // The caller's token is the only one this call may carry: a refusal of it
    // is the caller's to fix, and falling back to ours would hand them our
    // access (ADR 0004).
    const tokenNow = (): string => callerToken ?? this.tokenSource.current();
    const sentToken = tokenNow();
    let reply = await this.attempt(call.route, url, initFor(sentToken), caller);
    if (
      callerToken === undefined &&
      (reply.status === 401 || reply.status === 403)
    ) {
      // The partner token may have been rotated: re-read it once (at most once
      // per 60 s) and, when it differs from the one just refused, send the call
      // once more. A call that was dropped meanwhile is not retried. The token
      // is compared as well as the re-read result, so a call that was refused
      // with the old token after another call already refreshed it still
      // retries.
      const changed = await this.tokenSource.refresh();
      const next = this.tokenSource.current();
      if (changed || next !== sentToken) {
        if (call.signal?.aborted === true) {
          throw cancelledError(call.route, call.signal);
        }
        reply = await this.attempt(call.route, url, initFor(next), caller);
      }
    }
    let retryAfter: number | null = null;
    if (reply.status === 429 && callerToken !== undefined) {
      // Most likely the caller's own per-partner limit: the caller waits and
      // nobody else does. Our egress stays below the per-address limit, so the
      // shared gate is not paused and the call is not retried inline; one
      // partner exhausting its budget never slows another (ADR 0004).
      retryAfter = this.advisedWait(reply.headers);
    } else if (reply.status === 429) {
      retryAfter = this.pauseFor(reply.headers);
      // At most one retry, and only for a short advised wait. The upstream
      // did not process a rate-limited request, so sending it again is safe,
      // the book_check POST included. The gate holds the retry until the
      // pause ends. A call that was dropped meanwhile is not retried.
      if (retryAfter <= INLINE_RETRY_MAX_SECONDS) {
        if (call.signal?.aborted === true) {
          throw cancelledError(call.route, call.signal);
        }
        reply = await this.attempt(
          call.route,
          url,
          initFor(tokenNow()),
          caller
        );
        if (reply.status === 429) retryAfter = this.pauseFor(reply.headers);
      }
    }

    if (reply.status >= 200 && reply.status < 300) {
      return {
        status: reply.status,
        data: parseEnvelopeData(call.route, reply.status, reply.text),
      };
    }
    throw this.statusError(
      call.route,
      reply.status,
      reply.text,
      retryAfter,
      callerToken
    );
  }

  /** One fetch through the gate; failures before a status become UpstreamErrors. */
  private async attempt(
    route: string,
    url: URL,
    init: RequestInit,
    caller: GateCallOptions
  ): Promise<RawReply> {
    const callSignal = caller.signal;
    try {
      return await this.gate.run(
        async () => {
          // The per-fetch timeout starts when the gate admits the call, so
          // time spent waiting in the gate does not count against it. The
          // tool call's own signal (disconnect or deadline) stops the fetch
          // too (WR-04).
          const timeout = AbortSignal.timeout(this.timeoutMs);
          const response = await this.fetchImpl(url, {
            ...init,
            signal:
              callSignal === undefined
                ? timeout
                : AbortSignal.any([timeout, callSignal]),
          });
          return {
            status: response.status,
            headers: response.headers,
            text: await response.text(),
          };
        },
        { signal: callSignal, key: caller.key }
      );
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      if (error instanceof GateSaturatedError) {
        // Nothing was sent: the gate turned the call away to keep it inside
        // the host timeout and the shared partner budget.
        throw new UpstreamError('rate_limited', route, {
          status: null,
          retryAfterSeconds: error.retryAfterSeconds,
          cause: error,
        });
      }
      if (callSignal?.aborted === true) {
        throw cancelledError(route, callSignal);
      }
      throw new UpstreamError('unavailable', route, {
        cause: isTimeout(error)
          ? new Error(`Altegio API call timed out after ${this.timeoutMs} ms`, {
              cause: error,
            })
          : error,
      });
    }
  }

  /** Pauses the shared gate for the advised wait of a 429 and returns it in seconds. */
  private pauseFor(headers: Headers): number {
    const wait = this.advisedWait(headers);
    this.gate.pauseUntil(this.now() + wait * 1000);
    return wait;
  }

  /** The advised wait of a 429 in seconds, without pausing anybody. */
  private advisedWait(headers: Headers): number {
    return (
      retryAfterSeconds(headers, this.now()) ?? DEFAULT_RETRY_AFTER_SECONDS
    );
  }

  private statusError(
    route: string,
    status: number,
    text: string,
    retryAfter: number | null,
    callerToken: string | undefined
  ): UpstreamError {
    const meta = readErrorMeta(text);
    const kind = kindOfStatus(status);
    return new UpstreamError(kind, route, {
      status,
      credential: callerToken === undefined ? 'server' : 'caller',
      codes: kind === 'rejected' ? meta.codes : [],
      retryAfterSeconds: kind === 'rate_limited' ? retryAfter : null,
      // Scrubbed before anything else touches it (WR-04): later sanitising
      // or truncation could otherwise split the token past the scrubber.
      upstreamMessage:
        meta.message === null
          ? null
          : scrubSecrets(
              meta.message,
              callerToken === undefined
                ? this.tokenSource.known()
                : [callerToken, ...this.tokenSource.known()]
            ),
    });
  }
}
