import {
  LIVE_MAX_DURATION_SEC,
  LIVE_MAX_RATE_PER_SEC,
  LIVE_REQUEST_TIMEOUT_MS,
  UsageError,
  checkLiveTarget,
  type LoadtestArgs,
} from './args.js';

// The bounded tier 3 run (OPS-07, D-03), for plan 03-24 only. It reads through
// the public route (LIVE_PUBLIC_TARGET) with the five read-only tools of the
// discovery flow (never book_check, which makes up to four upstream calls),
// one request at a time. Four of them make one upstream call each;
// business_list_services makes two (the business card for the currency, and
// the services), so five tool calls are six upstream calls. The tool-call cap
// of 1.35 a second is therefore 1.62 upstream calls a second at full rate,
// above the production gate's 1.5: the gate, not this script, then holds the
// upstream rate, and a long run at the cap ends at the gate's busy stop.
// The partner token belongs to developer account 2630 and its budget is shared
// with the platform's marketplace confirmations (docs/runbooks/operations.md),
// not with Altegio.Pro MCP. Requests go to the target URL as given and carry no
// signature: the platform proxy in front of the service signs them.
//
// Hard stops, checked after every response: HTTP 401, 429 or 5xx (any status
// but 200), a JSON-RPC error, or a tool error whose text says the booking
// service is busy or did not accept this server's access. Any of them ends the
// run at once as FAIL; nothing is retried (T-03-38).

export interface LiveDeps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** A signal that aborts after `ms`; AbortSignal.timeout by default. */
  requestSignal?: (ms: number) => AbortSignal;
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

/** The five tools of a live run, in call order; business_list_services makes two upstream calls, the others one. */
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
  teamMemberId: number | null;
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

/**
 * The name of a thrown value, for the record. Only the name is kept: a message
 * can echo the URL. Anything that is not a short plain identifier is "Error".
 */
function errorName(error: unknown): string {
  const name =
    typeof error === 'object' && error !== null
      ? (error as { name?: unknown }).name
      : undefined;
  return typeof name === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(name)
    ? name
    : 'Error';
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
  // Plain http is allowed here for a loopback host only: the end-to-end test
  // drives the real app on 127.0.0.1, which parseArgs does not accept.
  checkLiveTarget(args.target, { allowLoopbackHttp: true });

  const durationMs = Math.min(args.durationSec, LIVE_MAX_DURATION_SEC) * 1000;
  const rate = Math.min(args.rate, LIVE_MAX_RATE_PER_SEC);
  const intervalMs = 1000 / rate;
  // The URL as given, nothing appended: the public route maps to /mcp itself.
  const endpoint = args.target;

  const perTool: Record<string, number> = {};
  const httpStatuses: Record<string, number> = {};
  const found: Discovered = {
    serviceId: null,
    teamMemberId: null,
    date: null,
  };
  const requestSignal =
    deps.requestSignal ?? ((ms: number) => AbortSignal.timeout(ms));
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
    if (
      (tool === 'business_list_dates' || tool === 'business_list_time_slots') &&
      found.teamMemberId === null
    ) {
      stoppedBy = 'no team member found at the location to ask about dates';
      break;
    }
    requests += 1;
    perTool[tool] = (perTool[tool] ?? 0) + 1;

    let response: Response;
    let text: string;
    try {
      response = await deps.fetch(endpoint, {
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
        signal: requestSignal(LIVE_REQUEST_TIMEOUT_MS),
      });
      const statusKey = String(response.status);
      httpStatuses[statusKey] = (httpStatuses[statusKey] ?? 0) + 1;
      text = await response.text();
    } catch (error) {
      // A timeout or a dropped connection ends the run with its counts: the
      // run already spent budget and must leave a record (T-03-55).
      stoppedBy = `network error: ${errorName(error)}`;
      break;
    }
    const statusKey = String(response.status);

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

    // No catch-up: after a slow reply the next start is at the reply time, and
    // the one after it a full interval later, never back to back (WR-58).
    nextAt = Math.max(nextAt + intervalMs, deps.now());
    const wait = Math.min(
      nextAt - deps.now(),
      startedAt + durationMs - deps.now()
    );
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
