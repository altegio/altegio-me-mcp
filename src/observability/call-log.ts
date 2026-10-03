import type { Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import type { ToolOutcome } from '../tools/factory.js';

// One structured log line per POST /mcp. The line is built from a closed field
// set, so request bodies, tool arguments and results can never reach the logs
// (OBS-01, threat T-1-10).

export type RpcMethod =
  | 'initialize'
  | 'notifications/initialized'
  | 'notifications/cancelled'
  | 'ping'
  | 'tools/list'
  | 'tools/call'
  | 'batch'
  | 'unparsed'
  | 'other';

export type CallOutcome =
  ToolOutcome | 'protocol_error' | 'http_error' | 'aborted';

export interface CallRecord {
  tool: string | null;
  outcome: CallOutcome | null;
  error_type: string | null;
}

const KNOWN_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'notifications/initialized',
  'notifications/cancelled',
  'ping',
  'tools/list',
  'tools/call',
]);

const MCP_CLIENT_MAX_CHARS = 100;
const PROTOCOL_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const NON_PRINTABLE_ASCII = /[^\x20-\x7E]/g;

function newRecord(): CallRecord {
  return { tool: null, outcome: null, error_type: null };
}

export function getCallRecord(res: Response): CallRecord {
  const existing = res.locals.callRecord as CallRecord | undefined;
  return existing ?? newRecord();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcMethodOf(body: unknown): RpcMethod {
  if (Array.isArray(body)) return 'batch';
  if (!isPlainObject(body)) return 'unparsed';
  const method = body.method;
  return typeof method === 'string' && KNOWN_METHODS.has(method)
    ? (method as RpcMethod)
    : 'other';
}

function printable(value: string): string | null {
  const cleaned = value
    .replace(NON_PRINTABLE_ASCII, '')
    .slice(0, MCP_CLIENT_MAX_CHARS);
  return cleaned.length > 0 ? cleaned : null;
}

function clientOf(
  req: Request,
  method: RpcMethod,
  body: unknown
): string | null {
  if (
    method === 'initialize' &&
    isPlainObject(body) &&
    isPlainObject(body.params)
  ) {
    const clientInfo = body.params.clientInfo;
    if (isPlainObject(clientInfo) && typeof clientInfo.name === 'string') {
      const name = printable(clientInfo.name);
      if (name !== null) return name;
    }
  }
  const userAgent = req.headers['user-agent'];
  return typeof userAgent === 'string' ? printable(userAgent) : null;
}

function toolOf(
  record: CallRecord,
  method: RpcMethod,
  body: unknown,
  toolNames: ReadonlySet<string>
): string | null {
  if (record.tool !== null) return record.tool;
  if (method !== 'tools/call') return null;
  if (isPlainObject(body) && isPlainObject(body.params)) {
    const name = body.params.name;
    if (typeof name === 'string' && toolNames.has(name)) return name;
  }
  return 'unknown';
}

function protocolVersionOf(req: Request): string | null {
  const header = req.headers['mcp-protocol-version'];
  return typeof header === 'string' && PROTOCOL_VERSION_PATTERN.test(header)
    ? header
    : null;
}

function outcomeOf(
  record: CallRecord,
  aborted: boolean,
  status: number
): CallOutcome {
  if (aborted) return 'aborted';
  if (record.outcome !== null) return record.outcome;
  if (status < 300) return 'ok';
  return status === 400 ? 'protocol_error' : 'http_error';
}

export function createCallLogMiddleware(
  logger: Logger,
  toolNames: ReadonlySet<string>
): RequestHandler {
  return (req, res, next) => {
    const record = newRecord();
    res.locals.callRecord = record;
    const startedAt = performance.now();
    let written = false;

    const write = (): void => {
      if (written) return;
      written = true;
      const body: unknown = req.body;
      const method = rpcMethodOf(body);
      const status = res.statusCode;
      const outcome = outcomeOf(record, !res.writableFinished, status);
      const line = {
        event: 'mcp_call',
        rpc_method: method,
        tool: toolOf(record, method, body, toolNames),
        mcp_client: clientOf(req, method, body),
        protocol_version: protocolVersionOf(req),
        http_status: status,
        latency_ms: Math.round(performance.now() - startedAt),
        outcome,
        error_type: record.error_type,
      };
      if (outcome === 'ok') {
        logger.info(line, 'mcp_call');
      } else if (status >= 500) {
        logger.error(line, 'mcp_call');
      } else {
        logger.warn(line, 'mcp_call');
      }
    };

    res.on('finish', write);
    res.on('close', write);
    next();
  };
}
