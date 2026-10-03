import { z } from 'zod';

// Order matters: it is the order in which problems are reported.
export const CONFIG_KEYS = [
  'PORT',
  'ALTEGIO_API_BASE',
  'ALTEGIO_API_TOKEN',
  'PUBLIC_BASE_URL',
  'LOG_LEVEL',
  'NODE_ENV',
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

const httpUrl = (): z.ZodURL => z.url({ protocol: /^https?$/ });

// ALTEGIO_API_TOKEN is validated exactly as in Altegio.Pro MCP (D-02): any
// non-empty string. A wrong or placeholder token shows up as a 401 on the
// first upstream call, which starts in Phase 2.
const ConfigSchema = z.object({
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
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
});

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
    invalid: 'must be an http(s) URL',
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
