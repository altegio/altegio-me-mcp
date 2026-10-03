// RED stub: replaced by the real implementation in the GREEN commit.
export const CONFIG_KEYS = [
  'PORT',
  'ALTEGIO_API_BASE',
  'ALTEGIO_API_TOKEN',
  'PUBLIC_BASE_URL',
  'LOG_LEVEL',
  'NODE_ENV',
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

export type LogLevel =
  'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

export interface Config {
  PORT: number;
  ALTEGIO_API_BASE: string;
  ALTEGIO_API_TOKEN: string;
  PUBLIC_BASE_URL: string;
  LOG_LEVEL: LogLevel;
  NODE_ENV: 'development' | 'test' | 'production';
}

export class ConfigError extends Error {
  readonly issues: readonly { key: ConfigKey; message: string }[] = [];
}

export function loadConfig(_env: Record<string, string | undefined>): Config {
  return {} as Config;
}

export function formatConfigError(_error: ConfigError): string {
  return '';
}
