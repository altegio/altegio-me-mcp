import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  MIN_PROXY_KEY_LENGTH,
  parseProxyKeys,
} from '../security/proxy-auth.js';

// Order matters: it is the order in which problems are reported.
export const CONFIG_KEYS = [
  'PORT',
  'ALTEGIO_API_BASE',
  'ALTEGIO_API_TOKEN',
  'PUBLIC_BASE_URL',
  'LOG_LEVEL',
  'NODE_ENV',
  'PROXY_AUTH',
  'MCP_PROXY_BACKEND_KEY',
  'MCP_PROXY_BACKEND_KEY_FILE',
  'COMMIT_SHA',
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

const COMMIT_SHA_FORMAT = /^[0-9a-f]{7,40}$/;

const httpUrl = (): z.ZodURL => z.url({ protocol: /^https?$/ });

// ALTEGIO_API_TOKEN is validated exactly as in Altegio.Pro MCP (D-02): any
// non-empty string. A wrong or placeholder token shows up as a 401 on the
// first upstream call, which starts in Phase 2. A token shorter than the
// scrubber minimum is reported at startup by src/server.ts (WR-04).
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
    ALTEGIO_API_TOKEN: z.string().min(1, 'Partner API token is required'),
    PUBLIC_BASE_URL: httpUrl(),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    NODE_ENV: z.enum(NODE_ENVS).default('production'),
    PROXY_AUTH: z.enum(PROXY_AUTH_MODES).default('required'),
    MCP_PROXY_BACKEND_KEY: z.string().optional(),
    MCP_PROXY_BACKEND_KEY_FILE: z
      .string()
      .refine((path) => isAbsolute(path))
      .optional(),
    COMMIT_SHA: z.string().regex(COMMIT_SHA_FORMAT).optional(),
  })
  .superRefine(
    (config, ctx) => {
      // Runs even when other keys failed, so every problem is reported at
      // once; the values may then be unvalidated, hence the defensive reads.
      const {
        NODE_ENV: nodeEnv,
        ALTEGIO_API_BASE: base,
        PROXY_AUTH: proxyAuth,
        MCP_PROXY_BACKEND_KEY: proxyKey,
        MCP_PROXY_BACKEND_KEY_FILE: proxyKeyFile,
      } = config as {
        NODE_ENV?: unknown;
        ALTEGIO_API_BASE?: unknown;
        PROXY_AUTH?: unknown;
        MCP_PROXY_BACKEND_KEY?: unknown;
        MCP_PROXY_BACKEND_KEY_FILE?: unknown;
      };

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
      if (typeof base !== 'string' || !URL.canParse(base)) return;
      if (new URL(base).protocol !== 'https:') {
        ctx.addIssue({
          code: 'custom',
          path: ['ALTEGIO_API_BASE'],
          message: 'https required in production',
        });
      }
    },
    { when: () => true }
  );

export type Config = z.output<typeof ConfigSchema>;

// Fixed text per key. zod's own messages can quote the input, so none of them
// is ever passed through (threat T-1-12).
const PARTNER_TOKEN_REQUIRED = 'Partner API token is required';

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
  ALTEGIO_API_TOKEN: {
    missing: PARTNER_TOKEN_REQUIRED,
    invalid: PARTNER_TOKEN_REQUIRED,
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
  COMMIT_SHA: {
    missing: 'is required (see .env.example)',
    invalid: 'must be 7 to 40 lowercase hexadecimal characters',
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
