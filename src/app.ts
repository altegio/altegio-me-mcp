import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import type { Logger } from 'pino';
import { createMcpRequestHandler } from './mcp/stateless-handler.js';
import { createCallLogMiddleware } from './observability/call-log.js';
import type { DefinedTool } from './tools/factory.js';

export const MCP_BODY_LIMIT = '100kb';

export interface AppDeps<D> {
  name: string;
  version: string;
  tools: readonly DefinedTool<D>[];
  toolDeps: D;
  logger: Logger;
  secrets: readonly string[];
  allowedOrigins: readonly string[];
  allowLoopbackOrigins: boolean;
}

interface JsonRpcErrorBody {
  jsonrpc: '2.0';
  error: { code: number; message: string };
  id: null;
}

function rpcError(code: number, message: string): JsonRpcErrorBody {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

function errorTypeOf(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'type' in err) {
    const type = (err as { type?: unknown }).type;
    return typeof type === 'string' ? type : null;
  }
  return null;
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
    res.json({ status: 'ok', version: deps.version });
  });

  app.post(
    '/mcp',
    createCallLogMiddleware(deps.logger, toolNames),
    express.json({ limit: MCP_BODY_LIMIT }),
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
      default:
        res.status(500).json(rpcError(-32603, 'Internal error'));
    }
  });

  return app;
}
