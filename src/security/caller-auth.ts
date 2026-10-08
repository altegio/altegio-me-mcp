import type { IncomingHttpHeaders } from 'node:http';
import type { RequestHandler, Response } from 'express';
import { getCallRecord } from '../observability/call-log.js';
import {
  CLIENT_GRANTABLE_SCOPES,
  SCOPE_DISCOVER,
  type Scope,
} from '../tools/scopes.js';
import { partnerIdOf, type PartnerTokenValidator } from './partner-token.js';

// Who may call POST /mcp (ADR 0004). The base tier is an Altegio partner
// token: the caller's own, validated with Altegio and then used for the
// caller's upstream calls instead of ours. Behind the platform proxy the token
// arrives only in the signed x-mcp-auth-* header the proxy sets, so the proxy
// signature covers it and a client cannot inject one past the proxy. Without
// the proxy (PROXY_AUTH=off: local runs, the own-domain fallback) the caller
// sends it directly, in the same headers the proxy accepts.
//
// Mounted after the proxy check and the edge limiter, so floods of bad tokens
// are limited before any probe, and before the body parser. The token is
// never logged: the call log carries its pseudonym (partnerIdOf).

/** 'required' refuses a call without a partner token; 'optional' serves it with ours. */
export const CALLER_AUTH_MODES = ['required', 'optional'] as const;
export type CallerAuthMode = (typeof CALLER_AUTH_MODES)[number];

/** Set by the proxy; covered by its signature. */
export const SIGNED_KIND_HEADER = 'x-mcp-auth-kind';
export const SIGNED_PARTNER_TOKEN_HEADER = 'x-mcp-auth-altegio-partner-token';
/** Sent by the caller itself when no proxy is in front. */
export const DIRECT_PARTNER_TOKEN_HEADER = 'x-altegio-partner-token';

export const CALLER_KIND_PARTNER = 'partner';
export const CALLER_KIND_CLIENT = 'client';
/** The signed client identity: the user token and the scopes the proxy grants. */
export const SIGNED_USER_TOKEN_HEADER = 'x-mcp-auth-altegio-user-token';
export const SIGNED_SCOPE_HEADER = 'x-mcp-auth-scope';
/** Sent by a client itself when no proxy is in front (local and headless runs). */
export const DIRECT_USER_TOKEN_HEADER = 'x-altegio-user-token';

/** Shown in WWW-Authenticate; names the protection space, not a host. */
const REALM = 'altegio-me';

export type Caller =
  | {
      kind: 'partner';
      /** The validated partner token; upstream calls are signed with it. */
      partnerToken: string;
      /** Pseudonym for logs. */
      partnerId: string;
      scopes: ReadonlySet<Scope>;
    }
  | {
      /**
       * A signed-in client (ADR 0005, D-01): their Altegio user token, signed
       * by the proxy or, without it, sent directly.
       */
      kind: 'client';
      /** The client's user token; sent only on the signed-in routes. */
      userToken: string;
      /** The partner token that came with the client, when one did. */
      partnerToken: string | null;
      /** Pseudonym of that partner token for logs. */
      partnerId: string | null;
      scopes: ReadonlySet<Scope>;
    }
  | {
      /** CALLER_AUTH=optional without a token: served with our own token. */
      kind: 'anonymous';
      scopes: ReadonlySet<Scope>;
    };

export type CallerAuthReason = 'no_partner_token' | 'invalid_partner_token';

/** What a partner token grants: the base tier only. The client tier needs a client sign-in. */
const PARTNER_SCOPES: ReadonlySet<Scope> = new Set<Scope>([SCOPE_DISCOVER]);

/**
 * What a client sign-in grants: the base tier plus each grantable scope the
 * proxy's signed scope list names, or all of them when the client came with a
 * direct header (`listed` null: local and headless runs). Nothing else is ever
 * granted, whatever the list says: mcp:me:book is nobody's yet.
 */
function clientScopes(listed: readonly string[] | null): ReadonlySet<Scope> {
  const granted = new Set<Scope>([SCOPE_DISCOVER]);
  for (const scope of CLIENT_GRANTABLE_SCOPES) {
    if (listed === null || listed.includes(scope)) granted.add(scope);
  }
  return granted;
}

/** Kept only while the proxy lane rolls out; see CALLER_AUTH in the README. */
const ANONYMOUS_SCOPES: ReadonlySet<Scope> = PARTNER_SCOPES;

function single(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** What a request presents as the client's user token. */
export type PresentedUser =
  | { kind: 'none' }
  | {
      kind: 'token';
      token: string;
      /** The signed scope list behind the proxy; null for a direct header. */
      scopes: readonly string[] | null;
    };

/**
 * The client's user token a request presents. Behind the proxy only the signed
 * header counts, and only when the signed kind is the client kind; without the
 * proxy only the direct header counts.
 */
export function presentedUserToken(
  headers: IncomingHttpHeaders,
  behindProxy: boolean
): PresentedUser {
  if (behindProxy) {
    const kind = nonBlank(single(headers[SIGNED_KIND_HEADER]));
    const token = nonBlank(single(headers[SIGNED_USER_TOKEN_HEADER]));
    if (kind !== CALLER_KIND_CLIENT || token === undefined) {
      return { kind: 'none' };
    }
    const listed = nonBlank(single(headers[SIGNED_SCOPE_HEADER]));
    return {
      kind: 'token',
      token,
      scopes: listed === undefined ? [] : listed.split(/\s+/),
    };
  }
  const direct = nonBlank(single(headers[DIRECT_USER_TOKEN_HEADER]));
  return direct === undefined
    ? { kind: 'none' }
    : { kind: 'token', token: direct, scopes: null };
}

const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;

type Presented =
  { kind: 'none' } | { kind: 'token'; token: string } | { kind: 'unsupported' };

/**
 * The partner token a request presents. Behind the proxy only the signed
 * header counts; a caller's own Authorization never reaches us there, and an
 * x-mcp-auth-kind other than 'partner' is a credential this server does not
 * serve yet (OAuth arrives with Phase 2).
 */
export function presentedPartnerToken(
  headers: IncomingHttpHeaders,
  behindProxy: boolean
): Presented {
  if (behindProxy) {
    const kind = nonBlank(single(headers[SIGNED_KIND_HEADER]));
    const token = nonBlank(single(headers[SIGNED_PARTNER_TOKEN_HEADER]));
    if (kind !== undefined && kind !== CALLER_KIND_PARTNER) {
      return { kind: 'unsupported' };
    }
    return token === undefined ? { kind: 'none' } : { kind: 'token', token };
  }
  const direct = nonBlank(single(headers[DIRECT_PARTNER_TOKEN_HEADER]));
  if (direct !== undefined) return { kind: 'token', token: direct };
  const authorization = single(headers.authorization);
  if (authorization === undefined) return { kind: 'none' };
  const match = BEARER.exec(authorization);
  return match?.[1] === undefined
    ? { kind: 'unsupported' }
    : { kind: 'token', token: match[1] };
}

export const PARTNER_TOKEN_REQUIRED = {
  error: 'partner_token_required',
  error_description:
    'Send an Altegio partner token: Authorization: Bearer <partner token>',
} as const;

export const PARTNER_TOKEN_INVALID = {
  error: 'invalid_token',
  error_description: 'The Altegio partner token was not accepted',
} as const;

export const PARTNER_CHECK_UNAVAILABLE = {
  error: 'temporarily_unavailable',
  error_description: 'The partner token could not be checked; retry shortly',
} as const;

const RETRY_AFTER_SECONDS = 5;

function refuse(
  res: Response,
  reason: CallerAuthReason,
  body: typeof PARTNER_TOKEN_REQUIRED | typeof PARTNER_TOKEN_INVALID
): void {
  const record = getCallRecord(res);
  record.auth_reason = reason;
  record.error_type = body.error;
  // RFC 6750 section 3.1: a request with no credentials gets no error code.
  res.setHeader(
    'WWW-Authenticate',
    reason === 'no_partner_token'
      ? `Bearer realm="${REALM}"`
      : `Bearer realm="${REALM}", error="invalid_token", error_description="${body.error_description}"`
  );
  res.status(401).json(body);
}

export function getCaller(res: Response): Caller | null {
  return (res.locals.caller as Caller | undefined) ?? null;
}

export function createCallerAuthMiddleware(opts: {
  mode: CallerAuthMode;
  behindProxy: boolean;
  validator: PartnerTokenValidator;
}): RequestHandler {
  return (req, res, next) => {
    const record = getCallRecord(res);
    const user = presentedUserToken(req.headers, opts.behindProxy);
    if (user.kind === 'token') {
      const caller: Caller = {
        kind: 'client',
        userToken: user.token,
        partnerToken: null,
        partnerId: null,
        scopes: clientScopes(user.scopes),
      };
      res.locals.caller = caller;
      record.caller = caller.kind;
      next();
      return;
    }
    const presented = presentedPartnerToken(req.headers, opts.behindProxy);
    if (presented.kind === 'unsupported') {
      refuse(res, 'invalid_partner_token', PARTNER_TOKEN_INVALID);
      return;
    }
    if (presented.kind === 'none') {
      if (opts.mode === 'required') {
        refuse(res, 'no_partner_token', PARTNER_TOKEN_REQUIRED);
        return;
      }
      const caller: Caller = { kind: 'anonymous', scopes: ANONYMOUS_SCOPES };
      res.locals.caller = caller;
      record.caller = caller.kind;
      next();
      return;
    }

    const { token } = presented;
    opts.validator.validate(token).then(
      (verdict) => {
        if (verdict === 'invalid') {
          refuse(res, 'invalid_partner_token', PARTNER_TOKEN_INVALID);
          return;
        }
        if (verdict === 'unavailable') {
          record.error_type = 'partner_check_unavailable';
          res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
          res.status(503).json(PARTNER_CHECK_UNAVAILABLE);
          return;
        }
        const caller: Caller = {
          kind: 'partner',
          partnerToken: token,
          partnerId: partnerIdOf(token),
          scopes: PARTNER_SCOPES,
        };
        res.locals.caller = caller;
        record.caller = caller.kind;
        record.partner_id = caller.partnerId;
        next();
      },
      (error: unknown) => {
        next(error);
      }
    );
  };
}
