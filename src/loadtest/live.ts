import {
  LIVE_MAX_DURATION_SEC,
  LIVE_MAX_RATE_PER_SEC,
  UsageError,
  type LoadtestArgs,
} from './args.js';

// The bounded tier 3 run (OPS-07, D-03), for plan 03-16 only. It reads through
// the deployed service with the five read-only tools that make exactly one
// upstream call each (never book_check, which makes up to four), one request at
// a time, at no more than 2.7 calls a second: 90% of the gate's ceiling, so
// Altegio.Pro MCP, which shares the partner token, keeps its share. Requests
// carry no signature: the platform proxy in front of the service signs them.
//
// Hard stops, checked after every response: HTTP 401, 429 or 5xx (any status
// but 200), a JSON-RPC error, or a tool error whose text says the booking
// service is busy or did not accept this server's access. Any of them ends the
// run at once as FAIL; nothing is retried (T-03-38).

export interface LiveDeps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface LiveResult {
  status: 'PASS' | 'FAIL';
  /** Why the run stopped early; null for a run that reached its duration. */
  stoppedBy: string | null;
  requests: number;
  toolErrors: number;
  elapsedMs: number;
  /** Requests a second over the whole run. */
  averageRate: number;
  /** Requests per tool name. */
  perTool: Record<string, number>;
  /** HTTP statuses seen, as text keys. */
  httpStatuses: Record<string, number>;
}

/** The five tools of a live run, in call order; each makes one upstream call. */
export const LIVE_TOOLS = [
  'business_get',
  'business_list_services',
  'business_list_team_members',
  'business_list_dates',
  'business_list_time_slots',
] as const;
type LiveTool = (typeof LIVE_TOOLS)[number];

/** After this many other tool errors a run stops: something is wrong with the inputs. */
const MAX_OTHER_TOOL_ERRORS = 5;

const THROTTLE_TEXT = /busy|not accept/i;

interface Discovered {
  serviceId: number | null;
  teamMemberId: number;
  date: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstItem(
  structured: Record<string, unknown> | null
): Record<string, unknown> | null {
  const items = structured?.items;
  return Array.isArray(items) ? record(items[0]) : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toolArguments(
  tool: LiveTool,
  location: number,
  found: Discovered,
  nowMs: number
): Record<string, unknown> {
  const location_id = location;
  switch (tool) {
    case 'business_get':
    case 'business_list_services':
    case 'business_list_team_members':
      return { location_id };
    case 'business_list_dates':
      return {
        location_id,
        service_ids: [found.serviceId],
        team_member_id: found.teamMemberId,
      };
    case 'business_list_time_slots':
      return {
        location_id,
        service_ids: [found.serviceId],
        team_member_id: found.teamMemberId,
        date:
          found.date ?? new Date(nowMs + 86_400_000).toISOString().slice(0, 10),
      };
  }
}

function toolText(result: Record<string, unknown>): string {
  const content = result.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const text = record(part)?.text;
      return typeof text === 'string' ? text : '';
    })
    .join('\n');
}

/**
 * Runs the bounded live scenario. Throws UsageError, before any request, when
 * the run was not announced.
 */
export async function runLive(
  args: LoadtestArgs,
  deps: LiveDeps
): Promise<LiveResult> {
  // The guard is repeated here so that no caller can reach a request without it.
  if (args.scenario !== 'live') {
    throw new UsageError('runLive is for the live scenario only');
  }
  if (!args.confirmAnnounced) {
    throw new UsageError(
      'Refusing to start: the live scenario needs --confirm-announced'
    );
  }
  if (args.target === null)
    throw new UsageError('--target is required for live');

  const durationMs = Math.min(args.durationSec, LIVE_MAX_DURATION_SEC) * 1000;
  const rate = Math.min(args.rate, LIVE_MAX_RATE_PER_SEC);
  const intervalMs = 1000 / rate;
  const endpoint = `${args.target}/mcp`;

  const perTool: Record<string, number> = {};
  const httpStatuses: Record<string, number> = {};
  const found: Discovered = { serviceId: null, teamMemberId: 0, date: null };
  let requests = 0;
  let toolErrors = 0;
  let otherToolErrors = 0;
  let stoppedBy: string | null = null;

  const startedAt = deps.now();
  let nextAt = startedAt;

  while (stoppedBy === null && deps.now() - startedAt < durationMs) {
    const tool = LIVE_TOOLS[requests % LIVE_TOOLS.length]!;
    if (
      (tool === 'business_list_dates' || tool === 'business_list_time_slots') &&
      found.serviceId === null
    ) {
      stoppedBy = 'no service found at the location to ask about dates';
      break;
    }
    requests += 1;
    perTool[tool] = (perTool[tool] ?? 0) + 1;

    const response = await deps.fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'user-agent': 'altegio-me-mcp-loadtest/1 (announced live run)',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: requests,
        method: 'tools/call',
        params: {
          name: tool,
          arguments: toolArguments(tool, args.location, found, deps.now()),
        },
      }),
    });
    const statusKey = String(response.status);
    httpStatuses[statusKey] = (httpStatuses[statusKey] ?? 0) + 1;
    const text = await response.text();

    if (response.status !== 200) {
      stoppedBy = `HTTP ${statusKey}`;
      break;
    }
    const body = record(parseJson(text));
    if (body === null) {
      stoppedBy = 'the reply was not JSON';
      break;
    }
    if (body.error !== undefined) {
      stoppedBy = 'JSON-RPC error';
      break;
    }
    const result = record(body.result);
    if (result === null) {
      stoppedBy = 'the reply carried no result';
      break;
    }
    if (result.isError === true) {
      toolErrors += 1;
      if (THROTTLE_TEXT.test(toolText(result))) {
        stoppedBy =
          'tool error: the booking service is busy or did not accept access';
        break;
      }
      otherToolErrors += 1;
      if (otherToolErrors > MAX_OTHER_TOOL_ERRORS) {
        stoppedBy = 'too many other tool errors';
        break;
      }
    } else {
      const item = firstItem(record(result.structuredContent));
      if (tool === 'business_list_services' && typeof item?.id === 'number') {
        found.serviceId = item.id;
      }
      if (
        tool === 'business_list_team_members' &&
        typeof item?.id === 'number'
      ) {
        found.teamMemberId = item.id;
      }
      if (tool === 'business_list_dates' && typeof item?.date === 'string') {
        found.date = item.date;
      }
    }

    nextAt += intervalMs;
    const wait = nextAt - deps.now();
    if (wait > 0) await deps.sleep(wait);
  }

  const elapsedMs = Math.max(1, deps.now() - startedAt);
  return {
    status: stoppedBy === null ? 'PASS' : 'FAIL',
    stoppedBy,
    requests,
    toolErrors,
    elapsedMs,
    averageRate: (requests / elapsedMs) * 1000,
    perTool,
    httpStatuses,
  };
}
