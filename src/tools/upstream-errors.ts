import { UpstreamError, type UpstreamErrorKind } from '../booking/errors.js';
import { DEFAULT_RETRY_AFTER_SECONDS } from '../booking/gate.js';
import { ToolError } from './errors.js';

// The one mapping from a failed Altegio API call to an in-band tool error
// (BAPI-01, FND-08). The error kind, never upstream text, decides the message
// and the next action. Both are static English (D-09); the scrubbed upstream
// text travels only in the ToolError `upstream` option, which the result
// renderer quotes as data. "Business" is the user-facing term (D-07).

export interface UpstreamErrorText {
  message: string;
  nextAction: string;
}

export type UpstreamErrorOverrides = Partial<
  Record<
    UpstreamErrorKind,
    UpstreamErrorText | ((error: UpstreamError) => UpstreamErrorText)
  >
>;

const TEMPORARILY_UNAVAILABLE =
  'tell the user the booking service is temporarily unavailable and try again later.';

const REJECTED_REQUEST: UpstreamErrorText = {
  message: 'The booking service rejected the request.',
  nextAction: 'check the parameters and call the tool again.',
};

/** The wait a rate-limited answer advised, rounded up; the default when it advised none. */
export function waitSeconds(error: UpstreamError): number {
  const advised = error.retryAfterSeconds;
  if (advised === null || !Number.isFinite(advised) || advised <= 0) {
    return DEFAULT_RETRY_AFTER_SECONDS;
  }
  return Math.ceil(advised);
}

export function defaultText(error: UpstreamError): UpstreamErrorText {
  switch (error.kind) {
    case 'not_found':
      return {
        message: 'No business was found for this location id.',
        nextAction:
          'check the location id; it is the numeric id of an Altegio business location.',
      };
    case 'bad_request':
    case 'rejected':
      return REJECTED_REQUEST;
    case 'unauthorized':
      // The call carried the signed-in client's user token: their sign-in
      // expired or was revoked, and only a new sign-in helps.
      if (error.credential === 'user') {
        return {
          message:
            "The booking service did not accept the client's sign-in for this connection.",
          nextAction:
            'tell the user their sign-in has expired or was revoked and they need to connect again; do not retry.',
        };
      }
      // The caller's own partner token was refused after it passed admission
      // (revoked or blocked since): only the integrator can renew it.
      if (error.credential === 'caller') {
        return {
          message:
            "The booking service did not accept this connection's Altegio partner token.",
          nextAction:
            'tell the user the connection needs a valid Altegio partner token; do not retry.',
        };
      }
      // Names no credential: the user can do nothing about our access.
      return {
        message: "The booking service did not accept this server's access.",
        nextAction: TEMPORARILY_UNAVAILABLE,
      };
    case 'rate_limited':
      return {
        message: 'The booking service is busy right now.',
        nextAction: `wait ${waitSeconds(error)} seconds, then repeat the same call.`,
      };
    case 'unavailable':
      return {
        message: 'The booking service did not answer in time.',
        nextAction:
          'retry once; if it fails again, tell the user the booking service is temporarily unavailable.',
      };
    case 'contract_drift':
      return {
        message: 'The booking service returned data in an unexpected format.',
        nextAction: TEMPORARILY_UNAVAILABLE,
      };
    case 'anti_fraud':
      return {
        message: 'The booking service could not confirm this request.',
        nextAction:
          "tell the user to complete the booking in the business's booking widget.",
      };
  }
}

export interface ToToolErrorOptions {
  /**
   * Whether the upstream message is quoted in the error as data (default). A
   * write call turns it off: a create rejection can quote the phone or name
   * that was sent.
   */
  quoteUpstream?: boolean;
}

/**
 * Turn whatever a tool handler caught into the error it should throw: a
 * ToolError for an UpstreamError (per-kind defaults, replaced per kind by
 * `overrides`), any other Error unchanged, and a non-Error value an Error.
 */
export function toToolError(
  error: unknown,
  overrides: UpstreamErrorOverrides = {},
  options: ToToolErrorOptions = {}
): Error {
  if (!(error instanceof UpstreamError)) {
    return error instanceof Error ? error : new Error('Non-error value thrown');
  }
  const override = overrides[error.kind];
  const text =
    override === undefined
      ? defaultText(error)
      : typeof override === 'function'
        ? override(error)
        : override;
  return new ToolError(text.message, text.nextAction, {
    upstream: options.quoteUpstream === false ? null : error.upstreamMessage,
    cause: error,
  });
}
