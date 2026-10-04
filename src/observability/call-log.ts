import type { Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import type { UpstreamErrorKind } from '../booking/errors.js';
import type { ProxyAuthReason } from '../security/proxy-auth.js';
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
  auth_reason: ProxyAuthReason | null;
  limited_by: 'inflight' | 'ip' | 'pool' | 'gate' | null;
  upstream_kind: UpstreamErrorKind | null;
  origin_host: string | null;
  forwarded_for_count: number | null;
}

export interface CallLogOptions {
  now?: () => number;
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
// Enough for any JSON-RPC error body; a larger body is a result, not an error.
const BODY_COPY_LIMIT = 64 * 1024;
const JSON_CONTENT_TYPE = /^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i;

// Exported so a test that needs a record does not list every field.
export function createCallRecord(): CallRecord {
  return {
    tool: null,
    outcome: null,
    error_type: null,
    auth_reason: null,
    limited_by: null,
    upstream_kind: null,
    origin_host: null,
    forwarded_for_count: null,
  };
}

export function getCallRecord(res: Response): CallRecord {
  const existing = res.locals.callRecord as CallRecord | undefined;
  return existing ?? createCallRecord();
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

// A bounded copy of the response body, used only to tell a JSON-RPC error from
// a result. It is never logged and never stored on the call record (WR-05).
interface BodyCopy {
  chunks: Buffer[];
  size: number;
  truncated: boolean;
  headContentType: string | null;
}

function chunkBuffer(chunk: unknown, encoding: unknown): Buffer | null {
  if (typeof chunk === 'string') {
    return Buffer.from(
      chunk,
      typeof encoding === 'string' && Buffer.isEncoding(encoding)
        ? encoding
        : 'utf8'
    );
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return null;
}

function keepChunk(copy: BodyCopy, chunk: unknown, encoding: unknown): void {
  if (copy.truncated) return;
  const buffer = chunkBuffer(chunk, encoding);
  if (buffer === null || buffer.length === 0) return;
  const room = BODY_COPY_LIMIT - copy.size;
  if (buffer.length > room) {
    copy.chunks.push(Buffer.from(buffer.subarray(0, room)));
    copy.size += room;
    copy.truncated = true;
    return;
  }
  copy.chunks.push(Buffer.from(buffer));
  copy.size += buffer.length;
}

// writeHead(status, [message], headers) takes an object or a flat array.
function contentTypeOfHeadArgs(args: readonly unknown[]): string | null {
  for (const arg of args) {
    if (Array.isArray(arg)) {
      for (let index = 0; index + 1 < arg.length; index += 2) {
        const key: unknown = arg[index];
        const value: unknown = arg[index + 1];
        if (
          typeof key === 'string' &&
          key.toLowerCase() === 'content-type' &&
          typeof value === 'string'
        ) {
          return value;
        }
      }
    } else if (isPlainObject(arg)) {
      for (const [key, value] of Object.entries(arg)) {
        if (key.toLowerCase() === 'content-type' && typeof value === 'string') {
          return value;
        }
      }
    }
  }
  return null;
}

function captureBody(res: Response): BodyCopy {
  const copy: BodyCopy = {
    chunks: [],
    size: 0,
    truncated: false,
    headContentType: null,
  };
  const originalWriteHead = res.writeHead.bind(res) as (
    ...args: unknown[]
  ) => Response;
  const originalWrite = res.write.bind(res) as (...args: unknown[]) => boolean;
  const originalEnd = res.end.bind(res) as (...args: unknown[]) => Response;
  res.writeHead = ((...args: unknown[]) => {
    copy.headContentType = contentTypeOfHeadArgs(args.slice(1));
    return originalWriteHead(...args);
  }) as Response['writeHead'];
  res.write = ((...args: unknown[]) => {
    keepChunk(copy, args[0], args[1]);
    return originalWrite(...args);
  }) as Response['write'];
  res.end = ((...args: unknown[]) => {
    keepChunk(copy, args[0], args[1]);
    return originalEnd(...args);
  }) as Response['end'];
  return copy;
}

function hasErrorMember(value: unknown): boolean {
  return isPlainObject(value) && Object.hasOwn(value, 'error');
}

function bodyHasRpcError(res: Response, copy: BodyCopy): boolean {
  if (copy.truncated || copy.size === 0) return false;
  const header = res.getHeader('content-type');
  const contentType =
    typeof header === 'string' ? header : copy.headContentType;
  if (contentType === null || !JSON_CONTENT_TYPE.test(contentType)) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(copy.chunks).toString('utf8'));
  } catch {
    return false;
  }
  return Array.isArray(parsed)
    ? parsed.some(hasErrorMember)
    : hasErrorMember(parsed);
}

function outcomeOf(
  record: CallRecord,
  aborted: boolean,
  status: number,
  rpcError: () => boolean
): CallOutcome {
  if (aborted) return 'aborted';
  if (record.outcome !== null) return record.outcome;
  if (status < 300) return rpcError() ? 'protocol_error' : 'ok';
  return status === 400 ? 'protocol_error' : 'http_error';
}

export function createCallLogMiddleware(
  logger: Logger,
  toolNames: ReadonlySet<string>,
  _options?: CallLogOptions
): RequestHandler {
  return (req, res, next) => {
    const record = createCallRecord();
    res.locals.callRecord = record;
    const startedAt = performance.now();
    const copy = captureBody(res);
    let written = false;

    const write = (): void => {
      if (written) return;
      written = true;
      const body: unknown = req.body;
      const method = rpcMethodOf(body);
      const status = res.statusCode;
      const outcome = outcomeOf(record, !res.writableFinished, status, () =>
        bodyHasRpcError(res, copy)
      );
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
