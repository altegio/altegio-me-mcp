import pino, { type DestinationStream, type Logger } from 'pino';
import type { LogLevel } from '../config/schema.js';

// Cloud Logging reads `severity` and `message`; pino's numeric level and its
// default `msg` key would show up as an unclassified entry.
export const SEVERITY_BY_LEVEL: Readonly<Record<string, string>> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

const REDACT_PATHS = [
  'token',
  '*.token',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'ALTEGIO_API_TOKEN',
  '*.ALTEGIO_API_TOKEN',
  'partnerToken',
  '*.partnerToken',
];

export interface LoggerOptions {
  level: LogLevel;
  // Tests pass an in-memory destination; the process writes to stdout.
  destination?: DestinationStream;
}

// No in-process pretty transport: `npm run dev` pipes the output through
// pino-pretty, and production keeps one JSON object per line.
export function createLogger({ level, destination }: LoggerOptions): Logger {
  return pino(
    {
      level,
      messageKey: 'message',
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ severity: SEVERITY_BY_LEVEL[label] ?? 'DEFAULT' }),
      },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    },
    destination ?? process.stdout
  );
}
