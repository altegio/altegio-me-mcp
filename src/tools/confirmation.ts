import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';

// Confirmation tokens of the write tools (ADR 0006, D-03), after the Pro MCP
// convention: a tool that changes a booking runs in two calls. The first
// validates and returns a preview with a confirmation_token; the second, with
// the identical arguments and that token, writes. The token is
// `<expiry ms>.<base64url HMAC-SHA256>` over the expiry, the tool name, a
// SHA-256 of the signed-in client's user token and the canonical arguments
// without the token, so a token made for one selection, one tool or one
// sign-in verifies for no other. The key is CONFIRMATION_SECRET when set, else
// a random key of this process (a token then lives on the instance that issued
// it). A token that does not verify is never ignored: the caller refuses the
// call in band and sends nothing upstream.
//
// A token works once. The used set lives in the instance, is pruned of expired
// entries on every issue and redeem, and so stays small. Its limit is stated:
// it is per process, so with several instances sharing one CONFIRMATION_SECRET
// the same token can be redeemed once per instance within its 10 minutes. The
// booking API stops what that would do, because a second booking at the same
// time is refused with its 433 or 437.

/** The name of the argument every write tool takes. */
export const CONFIRMATION_TOKEN_ARG = 'confirmation_token';

/** How long a preview stays confirmable: 10 minutes. */
export const CONFIRMATION_TTL_MS = 600_000;

/** An upper bound on the token a caller may send; real tokens are about 60 characters. */
const MAX_TOKEN_CHARS = 200;

export const confirmationTokenInput = z
  .string()
  .min(1)
  .max(MAX_TOKEN_CHARS)
  .optional()
  .describe(
    'Leave out on the first call, which returns a preview. After the client agreed to the preview, repeat the identical call with the confirmation_token it returned; the token is bound to these exact arguments and this sign-in, and expires in 10 minutes.'
  );

export type ConfirmationVerdict = 'ok' | 'invalid' | 'expired' | 'used';

export interface Confirmations {
  /** A token for this call, valid for CONFIRMATION_TTL_MS from `nowMs`. */
  issue(
    toolName: string,
    userToken: string,
    args: unknown,
    nowMs?: number
  ): { token: string; expiresAt: number };
  /** Whether `token` was issued for exactly this tool, sign-in and arguments, and is still valid. */
  redeem(
    token: string,
    toolName: string,
    userToken: string,
    args: unknown,
    nowMs?: number
  ): ConfirmationVerdict;
  /** How many redeemed tokens the instance still remembers; a seam for tests. */
  usedCount(): number;
}

export interface ConfirmationOptions {
  /** The shared key, so several instances accept each other's tokens; unset gives a random key of this process. */
  secret?: string;
  /** Clock in epoch milliseconds; defaults to Date.now. */
  now?: () => number;
}

const TOKEN_PATTERN = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/;

/** The arguments as one string: object keys sorted at every depth, arrays in order. */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeys(record[key])])
    );
  }
  return value;
}

/** The arguments the token is bound to: everything but the token itself. */
function boundArguments(args: unknown): string {
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    const { [CONFIRMATION_TOKEN_ARG]: _token, ...rest } = args as Record<
      string,
      unknown
    >;
    return canonical(rest);
  }
  return canonical(args);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function createConfirmations(
  options: ConfirmationOptions = {}
): Confirmations {
  const key =
    options.secret === undefined
      ? randomBytes(32)
      : Buffer.from(options.secret, 'utf8');
  const clock = options.now ?? Date.now;

  const mac = (
    expiresAt: number,
    toolName: string,
    userToken: string,
    args: unknown
  ): Buffer =>
    createHmac('sha256', key)
      .update(
        `${expiresAt}\n${toolName}\n${sha256Hex(userToken)}\n${boundArguments(args)}`
      )
      .digest();

  // Redeemed tokens and when each expires, so the set can be pruned.
  const used = new Map<string, number>();
  const prune = (nowMs: number): void => {
    for (const [token, expiresAt] of used) {
      if (expiresAt < nowMs) used.delete(token);
    }
  };

  return {
    issue(toolName, userToken, args, nowMs = clock()) {
      prune(nowMs);
      const expiresAt = nowMs + CONFIRMATION_TTL_MS;
      const signature = mac(expiresAt, toolName, userToken, args);
      return {
        token: `${expiresAt}.${signature.toString('base64url')}`,
        expiresAt,
      };
    },
    redeem(token, toolName, userToken, args, nowMs = clock()) {
      prune(nowMs);
      const match = TOKEN_PATTERN.exec(token);
      if (match === null) return 'invalid';
      const expiresAt = Number(match[1]);
      if (!Number.isSafeInteger(expiresAt)) return 'invalid';
      // Compared as text, not as decoded bytes: the last character of a
      // 43-character base64url value carries two unused bits, so two texts
      // could decode to the same MAC.
      const presented = Buffer.from(match[2] ?? '', 'utf8');
      const expected = Buffer.from(
        mac(expiresAt, toolName, userToken, args).toString('base64url'),
        'utf8'
      );
      if (
        presented.length !== expected.length ||
        !timingSafeEqual(presented, expected)
      ) {
        return 'invalid';
      }
      if (expiresAt < nowMs) return 'expired';
      if (used.has(token)) return 'used';
      used.set(token, expiresAt);
      return 'ok';
    },
    usedCount: () => used.size,
  };
}

/** One instance per process: every write tool shares it unless a test passes its own. */
export const DEFAULT_CONFIRMATIONS: Confirmations = createConfirmations();
