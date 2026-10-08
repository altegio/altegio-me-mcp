// Typed failure of one Altegio API call. SDK-free, like the rest of
// src/booking. Tools turn each kind into an in-band error that names the next
// action; the kind, never upstream text, decides what that action is.

export type UpstreamErrorKind =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'rejected'
  | 'rate_limited'
  | 'unavailable'
  | 'contract_drift';

export interface UpstreamErrorInit {
  status?: number | null;
  codes?: readonly number[];
  retryAfterSeconds?: number | null;
  upstreamMessage?: string | null;
  /** Whose partner token the call carried; defaults to the server's. */
  credential?: UpstreamCredential;
  cause?: unknown;
}

/**
 * 'caller': the caller's own partner token (ADR 0004); 'server': ours; 'user':
 * the call carried a signed-in client's user token (ADR 0005).
 */
export type UpstreamCredential = 'server' | 'caller' | 'user';

export class UpstreamError extends Error {
  readonly kind: UpstreamErrorKind;
  /** Route template, for example '/company/{location_id}'. */
  readonly route: string;
  /** HTTP status; null for a timeout or a network failure. */
  readonly status: number | null;
  /** meta.errors[].code on a 422, otherwise empty. */
  readonly codes: readonly number[];
  /** Seconds until the upstream accepts calls again; rate_limited only. */
  readonly retryAfterSeconds: number | null;
  /**
   * meta.message from the upstream error body with the partner token already
   * scrubbed. Third-party text: never copied into `message`.
   */
  readonly upstreamMessage: string | null;
  /** Whose partner token the call carried, so a refusal names the right party. */
  readonly credential: UpstreamCredential;

  constructor(
    kind: UpstreamErrorKind,
    route: string,
    init: UpstreamErrorInit = {}
  ) {
    // A fixed sentence from our own values only, so logs and generic error
    // results never carry upstream text.
    super(`Altegio API error ${kind} on ${route}`, { cause: init.cause });
    this.name = 'UpstreamError';
    this.kind = kind;
    this.route = route;
    this.status = init.status ?? null;
    this.codes = Object.freeze([...(init.codes ?? [])]);
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.upstreamMessage = init.upstreamMessage ?? null;
    this.credential = init.credential ?? 'server';
  }
}
