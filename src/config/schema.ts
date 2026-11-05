import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  CALLER_AUTH_MODES,
  CALLER_KIND_CLIENT,
  CALLER_KIND_PARTNER,
  SIGNED_KIND_HEADER,
  SIGNED_PARTNER_TOKEN_HEADER,
  SIGNED_SCOPE_HEADER,
  SIGNED_USER_TOKEN_HEADER,
} from '../security/caller-auth.js';
import { isValidCidr } from '../security/client-ip.js';
import {
  MIN_PROXY_KEY_LENGTH,
  parseProxyKeys,
} from '../security/proxy-auth.js';

// Fixed text, naming both settings and no value. zod's own messages can quote
// the input, so none of them is ever passed through (threat T-1-12).
const PARTNER_TOKEN_REQUIRED =
  'Partner API token is required (ALTEGIO_API_TOKEN or ALTEGIO_API_TOKEN_FILE)';

// Order matters: it is the order in which problems are reported.
export const CONFIG_KEYS = [
  'PORT',
  'ALTEGIO_API_BASE',
  'ALTEGIO_APP_BASE',
  'ALTEGIO_API_TOKEN',
  'ALTEGIO_API_TOKEN_FILE',
  'PUBLIC_BASE_URL',
  'LOG_LEVEL',
  'NODE_ENV',
  'PROXY_AUTH',
  'MCP_PROXY_BACKEND_KEY',
  'MCP_PROXY_BACKEND_KEY_FILE',
  'CALLER_AUTH',
  'CLIENT_USER_TOKEN_HEADER',
  'CLIENT_SCOPE_HEADER',
  'CLIENT_CALLER_KIND',
  'CONFIRMATION_SECRET',
  'COMMIT_SHA',
  'TRUSTED_PROXY_HOPS',
  'SHARED_EGRESS_CIDRS',
  'EXTRA_ALLOWED_ORIGINS',
  'EXTRA_ALLOWED_HOSTS',
  'EDGE_MAX_INFLIGHT',
  'EDGE_MAX_INFLIGHT_PER_IP',
  'EDGE_IP_BURST',
  'EDGE_IP_REFILL_PER_SEC',
  'EDGE_POOL_BURST',
  'EDGE_POOL_REFILL_PER_SEC',
  'GATE_MAX_QUEUE_PER_KEY',
  'MARKETPLACE_APPLICATION_ID',
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

export const LOG_LEVELS = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'silent',
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const NODE_ENVS = ['development', 'test', 'production'] as const;

// 'required' is the default and fails closed: without a usable proxy key the
// server does not start. Only an explicit 'off' disables the check (D-04).
const PROXY_AUTH_MODES = ['required', 'off'] as const;

// The proxy signature covers only x-mcp-auth-* headers (ADR 0004 D7), so a
// configured header name of the signed client identity must keep that prefix
// and must not be one of the headers that already mean something else.
const SIGNED_HEADER_NAME = /^x-mcp-auth-[a-z0-9-]+$/;
const RESERVED_SIGNED_HEADERS: ReadonlySet<string> = new Set([
  SIGNED_KIND_HEADER,
  SIGNED_PARTNER_TOKEN_HEADER,
  'x-mcp-auth-request-id',
]);
const CALLER_KIND_FORMAT = /^[a-z][a-z0-9_-]{0,31}$/;

const signedHeaderName = (fallback: string) =>
  z
    .string()
    .transform((value) => value.toLowerCase())
    .pipe(
      z
        .string()
        .regex(SIGNED_HEADER_NAME)
        .refine((name) => !RESERVED_SIGNED_HEADERS.has(name))
    )
    .default(fallback);

const COMMIT_SHA_FORMAT = /^[0-9a-f]{7,40}$/;
const CONFIRMATION_SECRET_FORMAT = /^[\u0021-\u007e]{32,512}$/;

const httpUrl = (): z.ZodURL => z.url({ protocol: /^https?$/ });

// Edge protection numbers (OPS-06). The defaults are tuned by the load test
// (plan 03-12); the README documents every one.
const positiveInteger = (fallback: number) =>
  z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1))
    .default(fallback);

const positiveNumber = (fallback: number) =>
  z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .transform(Number)
    .pipe(z.number().positive())
    .default(fallback);

const commaList = (value: string): string[] =>
  value.split(',').map((entry) => entry.trim());

const isHttpUrl = (value: string): boolean =>
  URL.canParse(value) && /^https?:$/.test(new URL(value).protocol);

// Only the origin of each entry is kept, so a trailing slash or a path cannot
// make an allowed origin miss the comparison in the origin guard.
const originList = (fallback: string[]) =>
  z
    .string()
    .transform(commaList)
    .pipe(z.array(z.string().refine(isHttpUrl)).min(1))
    .transform((entries) => entries.map((entry) => new URL(entry).origin))
    .default(fallback);

const cidrList = (fallback: string[]) =>
  z
    .string()
    .transform(commaList)
    .pipe(z.array(z.string().refine(isValidCidr)).min(1))
    .default(fallback);

// ALTEGIO_API_TOKEN is validated exactly as in Altegio.Pro MCP (D-02): any
// non-empty string. A wrong or placeholder token shows up as a 401 on the
// first upstream call, which starts in Phase 2. A token shorter than the
// scrubber minimum is reported at startup by src/server.ts (WR-04).
//
// ALTEGIO_API_TOKEN_FILE is the production form (OPS-04, D-05): the absolute
// path of the mounted secret, re-read while the process runs so a rotation by
// the platform needs no restart. It wins over ALTEGIO_API_TOKEN in
// src/server.ts, and one of the two must be set.
//
// NODE_ENV defaults to production so a deployment that sets nothing runs with
// the loopback Origin allowance off, and the partner token is only ever sent
// to an https API base in production (WR-03).
const ConfigSchema = z
  .object({
    PORT: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(65535))
      .default(8080),
    ALTEGIO_API_BASE: httpUrl().default('https://api.alteg.io/api/v1'),
    // The Integrations Hub partner routes live on the app host, not under
    // the API base (the installation status of the gate below).
    ALTEGIO_APP_BASE: httpUrl().default('https://app.alteg.io'),
    ALTEGIO_API_TOKEN: z.string().min(1).optional(),
    ALTEGIO_API_TOKEN_FILE: z
      .string()
      .refine((path) => isAbsolute(path))
      .optional(),
    PUBLIC_BASE_URL: httpUrl(),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    NODE_ENV: z.enum(NODE_ENVS).default('production'),
    PROXY_AUTH: z.enum(PROXY_AUTH_MODES).default('required'),
    MCP_PROXY_BACKEND_KEY: z.string().optional(),
    MCP_PROXY_BACKEND_KEY_FILE: z
      .string()
      .refine((path) => isAbsolute(path))
      .optional(),
    // 'required' is the default and fails closed: no partner token, no
    // service (ADR 0004). 'optional' keeps serving callers without one with
    // our own token, for the rollout of the proxy lane only.
    CALLER_AUTH: z.enum(CALLER_AUTH_MODES).default('required'),
    // The signed client identity (ADR 0005, D-01): where the proxy puts the
    // client's Altegio user token and scope list, and the x-mcp-auth-kind value
    // that marks a client. The defaults are the names proposed in I8.
    CLIENT_USER_TOKEN_HEADER: signedHeaderName(SIGNED_USER_TOKEN_HEADER),
    CLIENT_SCOPE_HEADER: signedHeaderName(SIGNED_SCOPE_HEADER),
    CLIENT_CALLER_KIND: z
      .string()
      .regex(CALLER_KIND_FORMAT)
      .refine((kind) => kind !== CALLER_KIND_PARTNER)
      .default(CALLER_KIND_CLIENT),
    // The key of the confirmation tokens of the write tools (ADR 0006, D-03).
    // Unset gives each process its own random key, so a confirmation is valid
    // only on the instance that issued it; set it to share them across
    // instances. Printable ASCII without spaces, so it survives an env file.
    CONFIRMATION_SECRET: z
      .string()
      .regex(CONFIRMATION_SECRET_FORMAT)
      .optional(),
    COMMIT_SHA: z.string().regex(COMMIT_SHA_FORMAT).optional(),
    // How many proxies sit between the caller and us, counted from the right of
    // X-Forwarded-For. 1 is the platform proxy; 0 is a deployment with none.
    TRUSTED_PROXY_HOPS: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(0))
      .default(1),
    // Anthropic's published outbound range: many claude.ai users share it, so
    // it is one pool, not one caller.
    SHARED_EGRESS_CIDRS: cidrList(['160.79.104.0/21']),
    EXTRA_ALLOWED_ORIGINS: originList([
      'https://claude.ai',
      'https://claude.com',
    ]),
    EXTRA_ALLOWED_HOSTS: z
      .string()
      .transform((value) => value.trim().split(/\s+/).filter(Boolean))
      .pipe(z.array(z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)))
      .default([]),
    EDGE_MAX_INFLIGHT: positiveInteger(60),
    EDGE_MAX_INFLIGHT_PER_IP: positiveInteger(6),
    EDGE_IP_BURST: positiveInteger(40),
    EDGE_IP_REFILL_PER_SEC: positiveNumber(3),
    EDGE_POOL_BURST: positiveInteger(200),
    EDGE_POOL_REFILL_PER_SEC: positiveNumber(20),
    GATE_MAX_QUEUE_PER_KEY: positiveInteger(8),
    // The assistant-booking gate (ADR 0006, D3 amended 2026-10-27): the id of
    // this server's Integrations Hub application (2642 in production). Set, a
    // client books from the chat only where it is active; unset, everywhere.
    MARKETPLACE_APPLICATION_ID: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().positive())
      .optional(),
  })
  .superRefine(
    (config, ctx) => {
      // Runs even when other keys failed, so every problem is reported at
      // once; the values may then be unvalidated, hence the defensive reads.
      const {
        NODE_ENV: nodeEnv,
        ALTEGIO_API_BASE: base,
        ALTEGIO_APP_BASE: appBase,
        ALTEGIO_API_TOKEN: token,
        ALTEGIO_API_TOKEN_FILE: tokenFile,
        PROXY_AUTH: proxyAuth,
        MCP_PROXY_BACKEND_KEY: proxyKey,
        MCP_PROXY_BACKEND_KEY_FILE: proxyKeyFile,
        CLIENT_USER_TOKEN_HEADER: userTokenHeader,
        CLIENT_SCOPE_HEADER: scopeHeader,
      } = config as {
        NODE_ENV?: unknown;
        ALTEGIO_API_BASE?: unknown;
        ALTEGIO_APP_BASE?: unknown;
        ALTEGIO_API_TOKEN?: unknown;
        ALTEGIO_API_TOKEN_FILE?: unknown;
        PROXY_AUTH?: unknown;
        MCP_PROXY_BACKEND_KEY?: unknown;
        MCP_PROXY_BACKEND_KEY_FILE?: unknown;
        CLIENT_USER_TOKEN_HEADER?: unknown;
        CLIENT_SCOPE_HEADER?: unknown;
      };

      // One header cannot carry both the user token and the scope list.
      if (
        typeof userTokenHeader === 'string' &&
        userTokenHeader === scopeHeader
      ) {
        for (const key of ['CLIENT_USER_TOKEN_HEADER', 'CLIENT_SCOPE_HEADER']) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'the two client headers must differ',
          });
        }
      }

      // One of the two token settings must be set; a file path that is set but
      // invalid is reported by its own rule, not as a missing token.
      if (token === undefined && tokenFile === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['ALTEGIO_API_TOKEN'],
          message: PARTNER_TOKEN_REQUIRED,
        });
      }

      // Fail closed: anything but an explicit 'off' needs a usable proxy key.
      // The file wins over the plain value in src/server.ts; a plain value that
      // is set must still hold a key of the minimum length.
      if (proxyAuth !== 'off') {
        if (proxyKeyFile === undefined && proxyKey === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['MCP_PROXY_BACKEND_KEY_FILE'],
            message: 'proxy key is required',
          });
        }
        if (
          proxyKey !== undefined &&
          (typeof proxyKey !== 'string' ||
            parseProxyKeys(proxyKey).length === 0)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['MCP_PROXY_BACKEND_KEY'],
            message: 'proxy key is too short',
          });
        }
      }

      if (nodeEnv !== 'production') return;
      for (const [key, value] of [
        ['ALTEGIO_API_BASE', base],
        ['ALTEGIO_APP_BASE', appBase],
      ] as const) {
        if (typeof value !== 'string' || !URL.canParse(value)) continue;
        if (new URL(value).protocol !== 'https:') {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'https required in production',
          });
        }
      }
    },
    { when: () => true }
  );

export type Config = z.output<typeof ConfigSchema>;

const SIGNED_HEADER_RULE =
  'must be a header name that starts with x-mcp-auth- (letters, digits and - after it), is not x-mcp-auth-kind, x-mcp-auth-altegio-partner-token or x-mcp-auth-request-id, and differs from the other client header';

const POSITIVE_INTEGER = 'must be a positive integer';
const POSITIVE_NUMBER = 'must be a positive number';

const MESSAGES: Readonly<
  Record<ConfigKey, { missing: string; invalid: string }>
> = {
  PORT: {
    missing: 'is required (see .env.example)',
    invalid: 'must be an integer between 1 and 65535',
  },
  ALTEGIO_API_BASE: {
    missing: 'is required (see .env.example)',
    invalid:
      'must be an https URL (http is accepted only when NODE_ENV is development or test)',
  },
  ALTEGIO_APP_BASE: {
    missing: 'is required (see .env.example)',
    invalid:
      'must be an https URL (http is accepted only when NODE_ENV is development or test)',
  },
  ALTEGIO_API_TOKEN: {
    missing: PARTNER_TOKEN_REQUIRED,
    invalid: PARTNER_TOKEN_REQUIRED,
  },
  ALTEGIO_API_TOKEN_FILE: {
    missing: PARTNER_TOKEN_REQUIRED,
    invalid: 'must be an absolute file path',
  },
  PUBLIC_BASE_URL: {
    missing: 'is required (see .env.example)',
    invalid: 'must be an http(s) URL',
  },
  LOG_LEVEL: {
    missing: 'is required (see .env.example)',
    invalid: `must be one of ${LOG_LEVELS.join(', ')}`,
  },
  NODE_ENV: {
    missing: 'is required (see .env.example)',
    invalid: `must be one of ${NODE_ENVS.join(', ')}`,
  },
  PROXY_AUTH: {
    missing: 'is required (see .env.example)',
    invalid: `must be one of ${PROXY_AUTH_MODES.join(', ')}`,
  },
  MCP_PROXY_BACKEND_KEY: {
    missing: 'is required (see .env.example)',
    invalid: `must hold at least one key of ${String(MIN_PROXY_KEY_LENGTH)} or more characters`,
  },
  MCP_PROXY_BACKEND_KEY_FILE: {
    missing:
      'is required when PROXY_AUTH is required: set it to the path of the mounted proxy key file (or set MCP_PROXY_BACKEND_KEY; local runs set PROXY_AUTH=off)',
    invalid: 'must be an absolute file path',
  },
  CALLER_AUTH: {
    missing: 'is required (see .env.example)',
    invalid: `must be one of ${CALLER_AUTH_MODES.join(', ')}`,
  },
  CLIENT_USER_TOKEN_HEADER: {
    missing: 'is required (see .env.example)',
    invalid: SIGNED_HEADER_RULE,
  },
  CLIENT_SCOPE_HEADER: {
    missing: 'is required (see .env.example)',
    invalid: SIGNED_HEADER_RULE,
  },
  CLIENT_CALLER_KIND: {
    missing: 'is required (see .env.example)',
    invalid:
      'must be 1 to 32 characters (a lower-case letter, then lower-case letters, digits, _ or -) and must not be partner',
  },
  CONFIRMATION_SECRET: {
    missing: 'is required (see .env.example)',
    invalid:
      'must be 32 to 512 printable ASCII characters without spaces (it is the key of the confirmation tokens)',
  },
  COMMIT_SHA: {
    missing: 'is required (see .env.example)',
    invalid: 'must be 7 to 40 lowercase hexadecimal characters',
  },
  TRUSTED_PROXY_HOPS: {
    missing: 'is required (see .env.example)',
    invalid: 'must be a non-negative integer',
  },
  SHARED_EGRESS_CIDRS: {
    missing: 'is required (see .env.example)',
    invalid:
      'must be a comma-separated list of IPv4 or IPv6 CIDRs, for example 160.79.104.0/21',
  },
  EXTRA_ALLOWED_ORIGINS: {
    missing: 'is required (see .env.example)',
    invalid:
      'must be a comma-separated list of http(s) origins, for example https://claude.ai',
  },
  EXTRA_ALLOWED_HOSTS: {
    missing: 'is required (see .env.example)',
    invalid:
      'must be space-separated lower-case hostnames without ports or wildcards',
  },
  EDGE_MAX_INFLIGHT: {
    missing: 'is required (see .env.example)',
    invalid: POSITIVE_INTEGER,
  },
  EDGE_MAX_INFLIGHT_PER_IP: {
    missing: 'is required (see .env.example)',
    invalid: POSITIVE_INTEGER,
  },
  EDGE_IP_BURST: {
    missing: 'is required (see .env.example)',
    invalid: POSITIVE_INTEGER,
  },
  EDGE_IP_REFILL_PER_SEC: {
    missing: 'is required (see .env.example)',
    invalid: POSITIVE_NUMBER,
  },
  EDGE_POOL_BURST: {
    missing: 'is required (see .env.example)',
    invalid: POSITIVE_INTEGER,
  },
  EDGE_POOL_REFILL_PER_SEC: {
    missing: 'is required (see .env.example)',
    invalid: POSITIVE_NUMBER,
  },
  GATE_MAX_QUEUE_PER_KEY: {
    missing: 'is required (see .env.example)',
    invalid: POSITIVE_INTEGER,
  },
  MARKETPLACE_APPLICATION_ID: {
    missing: 'is required (see .env.example)',
    invalid: POSITIVE_INTEGER,
  },
};

export interface ConfigIssue {
  key: ConfigKey;
  message: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(
      `Invalid configuration: ${issues.map((issue) => issue.key).join(', ')}`
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function isConfigKey(value: unknown): value is ConfigKey {
  return CONFIG_KEYS.some((key) => key === value);
}

// A value that is empty after trimming counts as not set, so defaults apply.
function normalize(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

// Pure: takes the environment as an argument and never reads process.env.
export function loadConfig(env: Record<string, string | undefined>): Config {
  const input: Record<string, string | undefined> = {};
  for (const key of CONFIG_KEYS) {
    input[key] = normalize(env[key]);
  }

  const result = ConfigSchema.safeParse(input);
  if (result.success) return result.data;

  const failed = new Set<ConfigKey>();
  for (const issue of result.error.issues) {
    const key: unknown = issue.path[0];
    if (isConfigKey(key)) failed.add(key);
  }
  const issues: ConfigIssue[] = CONFIG_KEYS.filter((key) =>
    failed.has(key)
  ).map((key) => ({
    key,
    message:
      input[key] === undefined ? MESSAGES[key].missing : MESSAGES[key].invalid,
  }));
  throw new ConfigError(issues);
}

export function formatConfigError(error: ConfigError): string {
  return [
    'Invalid configuration:',
    ...error.issues.map((issue) => `  - ${issue.key}: ${issue.message}`),
    'See .env.example',
  ].join('\n');
}
