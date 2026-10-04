import type { Server } from 'node:http';
import type { Logger } from 'pino';
import { createApp } from './app.js';
import { BookingClient } from './booking/client.js';
import { RequestGate } from './booking/gate.js';
import {
  ConfigError,
  formatConfigError,
  loadConfig,
  type Config,
} from './config/schema.js';
import { createLogger } from './observability/logger.js';
import { MIN_SECRET_LENGTH, scrubSecrets } from './observability/redact.js';
import { productionTools } from './tools/registry.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from './util/package-metadata.js';

// Cloud Run sends SIGTERM and kills the container 10 seconds later.
const FORCED_EXIT_MS = 8000;
const MAX_ERROR_MESSAGE_CHARS = 300;

function loadConfigOrExit(): Config {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      // No logger exists yet, and console is banned.
      process.stderr.write(`${formatConfigError(error)}\n`);
      process.exit(1);
    }
    throw error;
  }
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

function errorMessage(error: unknown, secrets: readonly string[]): string {
  const raw = error instanceof Error ? error.message : String(error);
  return scrubSecrets(raw, secrets).slice(0, MAX_ERROR_MESSAGE_CHARS);
}

function main(): void {
  const config = loadConfigOrExit();
  const logger = createLogger({ level: config.LOG_LEVEL });
  const secrets = [config.ALTEGIO_API_TOKEN];

  // The token rule stays as in Altegio.Pro MCP (any non-empty string), so a
  // token too short to scrub is reported here by name, never by value (WR-04).
  if (config.ALTEGIO_API_TOKEN.length < MIN_SECRET_LENGTH) {
    logger.warn(
      { event: 'config_warning', setting: 'ALTEGIO_API_TOKEN' },
      'partner token is shorter than the secret scrubber minimum, so it cannot be redacted from output'
    );
  }

  const reportFatal = (error: unknown): void => {
    logger.fatal(
      {
        event: 'process_error',
        error_type: errorClass(error),
        error_message: errorMessage(error, secrets),
      },
      'fatal process error'
    );
    process.exit(1);
  };
  process.on('uncaughtException', reportFatal);
  process.on('unhandledRejection', reportFatal);

  const app = createApp({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    tools: productionTools,
    // No upstream call at startup: /health stays free of Altegio API calls.
    toolDeps: {
      booking: new BookingClient({
        base: config.ALTEGIO_API_BASE,
        token: config.ALTEGIO_API_TOKEN,
        // One gate per process, shared by every request and session: all
        // upstream calls stay below the API limits together (BAPI-02).
        gate: new RequestGate(),
      }),
    },
    logger,
    secrets,
    allowedOrigins: [new URL(config.PUBLIC_BASE_URL).origin],
    allowLoopbackOrigins: config.NODE_ENV !== 'production',
  });

  const httpServer = app.listen(config.PORT, '0.0.0.0');

  httpServer.once('listening', () => {
    logger.info(
      { event: 'server_started', port: config.PORT, version: PACKAGE_VERSION },
      'listening'
    );
  });

  httpServer.once('error', (error) => {
    logger.fatal(
      { event: 'server_error', error_type: errorClass(error) },
      'server error'
    );
    process.exit(1);
  });

  registerShutdown(httpServer, logger);
}

function registerShutdown(httpServer: Server, logger: Logger): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: 'shutdown', signal }, 'shutting down');
    // Stop accepting, let in-flight requests finish, drop idle keep-alives.
    httpServer.close(() => {
      process.exit(0);
    });
    httpServer.closeIdleConnections();
    setTimeout(() => {
      process.exit(1);
    }, FORCED_EXIT_MS).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
