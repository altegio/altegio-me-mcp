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
  | 'contract_drift'
  /**
   * The create route did not book and did not say why: a 412 that carries
   * X-App-Security-Level, or a create answer that names no booking (the fake
   * 201). Both are documented for the create route; the client falls back to the
   * business's booking widget.
   */
  | 'anti_fraud';

export interface UpstreamErrorInit {
  status?: number | null;
  codes?: readonly number[];
  /** Names of the fields a 422 says are required, from meta.errors keyed by field. */
  requiredFields?: readonly string[];
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
  /** meta.errors[].code on a 422 or a 403, otherwise empty. */
  readonly codes: readonly number[];
  /**
   * The fields a 422 names as required (`meta.errors` keyed by field, with a
   * message that says the parameter is required or was not passed). Field names
   * only, never messages.
   */
  readonly requiredFields: readonly string[];
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
    this.requiredFields = Object.freeze([...(init.requiredFields ?? [])]);
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.upstreamMessage = init.upstreamMessage ?? null;
    this.credential = init.credential ?? 'server';
  }
}
