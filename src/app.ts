import type { BlockList } from 'node:net';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import type { Logger } from 'pino';
import {
  createMcpRequestHandler,
  type SecretList,
} from './mcp/stateless-handler.js';
import {
  createCallLogMiddleware,
  getCallRecord,
} from './observability/call-log.js';
import {
  classifyClient,
  gateKeyOf,
  resolveClientAddress,
} from './security/client-ip.js';
import { createProxyAuthMiddleware } from './security/proxy-auth.js';
import type { DefinedTool } from './tools/factory.js';

export const MCP_BODY_LIMIT = '100kb';

export interface AppDeps<D> {
  name: string;
  version: string;
  tools: readonly DefinedTool<D>[];
  toolDeps: D;
  logger: Logger;
  // Every secret to scrub from tool results; a function is evaluated once per
  // request, so a rotated token is covered without a restart (OPS-04, SEC-03).
  secrets: SecretList;
  allowedOrigins: readonly string[];
  allowLoopbackOrigins: boolean;
  // Verifies the platform proxy's signature on POST /mcp (OPS-03, D-04). Absent
  // or null leaves the check off, which only src/server.ts does, and only for
  // an explicit PROXY_AUTH=off.
  proxyAuth?: { keys: () => readonly string[]; now?: () => number } | null;
  // The deployed commit, reported by /health.
  commit?: string | null;
  // Edge abuse protection for POST /mcp (OPS-06): the client identity step and
  // the limiter built by createEdgeLimiter(). Absent or null leaves both off.
  edge?: {
    limiter: RequestHandler;
    identity: {
      trustedHops: number;
      proxyAuthOn: boolean;
      sharedEgress: BlockList;
    };
  } | null;
}

interface JsonRpcErrorBody {
  jsonrpc: '2.0';
  error: { code: number; message: string };
  id: null;
}

function rpcError(code: number, message: string): JsonRpcErrorBody {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

// body-parser and http-errors attach the HTTP status the client caused.
function clientStatusOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const { status, statusCode } = err as {
    status?: unknown;
    statusCode?: unknown;
  };
  const code =
    typeof status === 'number'
      ? status
      : typeof statusCode === 'number'
        ? statusCode
        : null;
  return code !== null && Number.isInteger(code) && code >= 400 && code < 500
    ? code
    : null;
}

function errorTypeOf(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'type' in err) {
    const type = (err as { type?: unknown }).type;
    return typeof type === 'string' ? type : null;
  }
  return null;
}

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

// DNS-rebinding guard (research A7). A request without Origin comes from a
// host calling server to server and is served; a browser request carries one.
function isOriginAllowed(
  origin: string,
  allowedOrigins: readonly string[],
  allowLoopbackOrigins: boolean
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (allowedOrigins.includes(parsed.origin)) return true;
  return allowLoopbackOrigins && LOOPBACK_HOSTNAMES.has(parsed.hostname);
}

export function createApp<D>(deps: AppDeps<D>): Express {
  const app = express();
  app.disable('x-powered-by');

  // Throws on a duplicate tool name, so a bad registry fails at startup.
  const mcpHandler = createMcpRequestHandler({
    name: deps.name,
    version: deps.version,
    tools: deps.tools,
    toolDeps: deps.toolDeps,
    secrets: deps.secrets,
  });
  const toolNames: ReadonlySet<string> = new Set(
    deps.tools.map((tool) => tool.name)
  );

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: deps.version,
      commit: deps.commit ?? null,
    });
  });

  // Mounted after the call log so a rejected request is still logged once.
  const originGuard: RequestHandler = (req, res, next) => {
    const origin = req.headers.origin;
    if (
      origin === undefined ||
      isOriginAllowed(origin, deps.allowedOrigins, deps.allowLoopbackOrigins)
    ) {
      next();
      return;
    }
    res.status(403).json(rpcError(-32000, 'Forbidden origin'));
  };

  // MCP dropped JSON-RPC batching after 2025-03-26. An array body would let one
  // HTTP request fan out into many upstream Altegio calls (WR-01), so it is
  // refused before the MCP handler runs.
  const rejectBatch: RequestHandler = (req, res, next) => {
    if (Array.isArray(req.body)) {
      res
        .status(400)
        .json(rpcError(-32600, 'Batch requests are not supported'));
      return;
    }
    next();
  };

  // Which client a request belongs to, decided after the signature check so
  // forwarded data is read only on a request the proxy vouched for (OPS-06).
  // The key goes to the limiter and, through the gate, to the per-key queue
  // cap; the address itself is never stored, only how many entries
  // X-Forwarded-For carried.
  const edge: RequestHandler[] = [];
  if (deps.edge !== undefined && deps.edge !== null) {
    const { limiter, identity } = deps.edge;
    edge.push((req, res, next) => {
      const { address, forwardedForCount } = resolveClientAddress({
        headers: req.headers,
        verified: res.locals.proxyVerified === true,
        proxyAuthOn: identity.proxyAuthOn,
        trustedHops: identity.trustedHops,
      });
      const classification = classifyClient(address, identity.sharedEgress);
      res.locals.clientKind = classification.kind;
      res.locals.clientKey = gateKeyOf(classification);
      getCallRecord(res).forwarded_for_count = forwardedForCount;
      next();
    }, limiter);
  }

  // Chain: call log -> origin guard -> proxy auth -> client identity -> edge
  // limiter (a limiter built by createEdgeLimiter() in src/server.ts) -> body
  // parser -> batch refusal -> MCP handler. Proxy auth and the limiter run
  // before the body is parsed, so an unsigned or excess request on the public
  // run.app address costs no parsing.
  const proxyAuth: RequestHandler[] =
    deps.proxyAuth === undefined || deps.proxyAuth === null
      ? []
      : [createProxyAuthMiddleware(deps.proxyAuth)];

  app.post(
    '/mcp',
    createCallLogMiddleware(deps.logger, toolNames),
    originGuard,
    ...proxyAuth,
    ...edge,
    express.json({ limit: MCP_BODY_LIMIT }),
    rejectBatch,
    mcpHandler
  );

  const methodNotAllowed = (_req: Request, res: Response): void => {
    res
      .status(405)
      .set('Allow', 'POST')
      .json(rpcError(-32000, 'Method not allowed. Use POST.'));
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Never send err.message or a stack: Express's default handler would.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    switch (errorTypeOf(err)) {
      case 'entity.parse.failed':
        res.status(400).json(rpcError(-32700, 'Parse error'));
        return;
      case 'entity.too.large':
        res
          .status(413)
          .json(
            rpcError(-32000, `Request body too large (limit ${MCP_BODY_LIMIT})`)
          );
        return;
      default: {
        // A client mistake the parser reports with its own 4xx (unsupported
        // encoding or charset, aborted body) is not a server failure (WR-02).
        const clientStatus = clientStatusOf(err);
        if (clientStatus !== null) {
          res.status(clientStatus).json(rpcError(-32600, 'Invalid request'));
          return;
        }
        res.status(500).json(rpcError(-32603, 'Internal error'));
      }
    }
  });

  return app;
}
