import type { Server } from 'node:http';
import type { Logger } from 'pino';
import { createApp } from './app.js';
import { BookingClient } from './booking/client.js';
import { RequestGate } from './booking/gate.js';
import {
  createFileSecretSource,
  createStaticSecretSource,
  knownValues,
  type SecretSource,
} from './config/secret-source.js';
import {
  ConfigError,
  formatConfigError,
  loadConfig,
  type Config,
} from './config/schema.js';
import { createLogger } from './observability/logger.js';
import { MIN_SECRET_LENGTH, scrubSecrets } from './observability/redact.js';
import { createSharedEgressList } from './security/client-ip.js';
import { createEdgeLimiter } from './security/edge-limiter.js';
import { MIN_PROXY_KEY_LENGTH, parseProxyKeys } from './security/proxy-auth.js';
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

function exitWithProxyKeyProblem(reason: string): never {
  // Names the setting, never a value (OPS-04, threat T-03-15).
  process.stderr.write(
    `Proxy key unusable: ${reason}\n  - MCP_PROXY_BACKEND_KEY_FILE: mount a file that holds at least one key of ${String(MIN_PROXY_KEY_LENGTH)} or more characters (or set PROXY_AUTH=off for local runs)\n`
  );
  process.exit(1);
}

function exitWithTokenProblem(reason: string): never {
  // Names the setting, never a value (OPS-04, threat T-03-22).
  process.stderr.write(
    `Partner token unusable: ${reason}\n  - ALTEGIO_API_TOKEN_FILE: mount a file that holds the partner token (or set ALTEGIO_API_TOKEN for local runs)\n`
  );
  process.exit(1);
}

// The file wins over the plain value, and an unreadable or empty file is never
// replaced by the plain value: startup stops instead (T-03-22).
async function buildTokenSource(
  config: Config,
  logger: Logger
): Promise<SecretSource> {
  if (config.ALTEGIO_API_TOKEN_FILE !== undefined) {
    try {
      return await createFileSecretSource({
        path: config.ALTEGIO_API_TOKEN_FILE,
        setting: 'ALTEGIO_API_TOKEN_FILE',
        logger,
      });
    } catch {
      return exitWithTokenProblem(
        'ALTEGIO_API_TOKEN_FILE is unreadable or empty'
      );
    }
  }
  if (config.ALTEGIO_API_TOKEN === undefined) {
    return exitWithTokenProblem(
      'neither ALTEGIO_API_TOKEN nor ALTEGIO_API_TOKEN_FILE is set'
    );
  }
  return createStaticSecretSource(config.ALTEGIO_API_TOKEN);
}

// The file wins over the plain value. The initial read is awaited, so a
// missing mount stops startup instead of leaving /mcp open (fail closed).
async function buildProxyKeySource(config: Config): Promise<SecretSource> {
  let source: SecretSource;
  if (config.MCP_PROXY_BACKEND_KEY_FILE !== undefined) {
    try {
      source = await createFileSecretSource({
        path: config.MCP_PROXY_BACKEND_KEY_FILE,
        setting: 'MCP_PROXY_BACKEND_KEY_FILE',
      });
    } catch {
      return exitWithProxyKeyProblem(
        'MCP_PROXY_BACKEND_KEY_FILE is unreadable or empty'
      );
    }
  } else {
    source = createStaticSecretSource(config.MCP_PROXY_BACKEND_KEY ?? '');
  }
  if (parseProxyKeys(source.current()).length === 0) {
    return exitWithProxyKeyProblem('no key of the minimum length was found');
  }
  return source;
}

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const logger = createLogger({ level: config.LOG_LEVEL });
  const tokenSource = await buildTokenSource(config, logger);

  let proxyAuth: { keys: () => readonly string[] } | null = null;
  let proxyKeys: SecretSource | null = null;
  if (config.PROXY_AUTH === 'required') {
    const keySource = await buildProxyKeySource(config);
    proxyKeys = keySource;
    proxyAuth = { keys: () => parseProxyKeys(keySource.current()) };
  }

  // Read per request, so a rotation is covered at once: the partner token now
  // and before it, the plain value when one is set next to the file, and every
  // single proxy key now and before (a payload such as 'old,new' is split, so
  // a rotated-out key quoted on its own is redacted too). None of them may
  // reach a log line or a tool result.
  const plainToken = config.ALTEGIO_API_TOKEN;
  const secrets = (): readonly string[] => [
    ...knownValues(tokenSource),
    ...(plainToken === undefined ? [] : [plainToken]),
    ...(proxyKeys === null ? [] : knownValues(proxyKeys, parseProxyKeys)),
  ];

  // The token rule stays as in Altegio.Pro MCP (any non-empty string), so a
  // token too short to scrub is reported here by name, never by value (WR-04).
  if (tokenSource.current().length < MIN_SECRET_LENGTH) {
    logger.warn(
      {
        event: 'config_warning',
        setting:
          config.ALTEGIO_API_TOKEN_FILE === undefined
            ? 'ALTEGIO_API_TOKEN'
            : 'ALTEGIO_API_TOKEN_FILE',
      },
      'partner token is shorter than the secret scrubber minimum, so it cannot be redacted from output'
    );
  }

  const reportFatal = (error: unknown): void => {
    logger.fatal(
      {
        event: 'process_error',
        error_type: errorClass(error),
        error_message: errorMessage(error, secrets()),
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
        tokenSource,
        // One gate per process, shared by every request and session: all
        // upstream calls stay below the API limits together (BAPI-02).
        gate: new RequestGate({
          maxQueuePerKey: config.GATE_MAX_QUEUE_PER_KEY,
        }),
      }),
    },
    logger,
    secrets,
    allowedOrigins: [new URL(config.PUBLIC_BASE_URL).origin],
    allowLoopbackOrigins: config.NODE_ENV !== 'production',
    proxyAuth,
    edge: {
      limiter: createEdgeLimiter({
        maxInflight: config.EDGE_MAX_INFLIGHT,
        maxInflightPerIp: config.EDGE_MAX_INFLIGHT_PER_IP,
        ipBurst: config.EDGE_IP_BURST,
        ipRefillPerSec: config.EDGE_IP_REFILL_PER_SEC,
        poolBurst: config.EDGE_POOL_BURST,
        poolRefillPerSec: config.EDGE_POOL_REFILL_PER_SEC,
      }),
      identity: {
        trustedHops: config.TRUSTED_PROXY_HOPS,
        proxyAuthOn: config.PROXY_AUTH === 'required',
        sharedEgress: createSharedEgressList(config.SHARED_EGRESS_CIDRS),
      },
    },
    commit: config.COMMIT_SHA ?? null,
  });

  const httpServer = app.listen(config.PORT, '0.0.0.0');

  httpServer.once('listening', () => {
    logger.info(
      { event: 'server_started', port: config.PORT, version: PACKAGE_VERSION },
      'listening'
    );
    // After the listening line, so that line stays the first one written.
    if (config.PROXY_AUTH === 'off') {
      logger.warn(
        { event: 'config_warning', setting: 'PROXY_AUTH' },
        'proxy signature check is off: /mcp serves requests that did not come through mcp-proxy'
      );
    }
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

main().catch((error: unknown) => {
  process.stderr.write(`Startup failed: ${errorClass(error)}\n`);
  process.exit(1);
});
