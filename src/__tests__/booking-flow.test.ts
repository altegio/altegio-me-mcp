import { afterEach, describe, expect, it } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BOOKING_ROUTES, BookingClient } from '../booking/client.js';
import { GateSaturatedError } from '../booking/gate.js';
import { ALTEGIO_ACCEPT, type GateLike } from '../booking/http.js';
import {
  fakeFetch,
  loadFixture,
  type FakeFetch,
  type FixtureResponse,
} from '../booking/__tests__/helpers/fake-fetch.js';
import { productionTools } from '../tools/registry.js';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '../tools/untrusted.js';
import {
  CANARY_SECRET,
  PARTNER_TOKEN,
  closeAllApps,
  postMcp,
  startApp,
  stubPartnerValidator,
  toolCallBody,
  waitForLogs,
  type Harness,
  type LogLine,
} from './helpers/http-harness.js';

// End to end through every layer the phase builds: SDK client -> POST /mcp ->
// MCP layer -> tools -> BookingClient -> BookingHttp -> (fake) Altegio API.
// Only fetch is replaced; everything else is the production code. The full
// known-business flow (ROADMAP success criterion 1) is driven only from data
// that earlier calls returned, starting from a location id.

const API_BASE = 'https://api.alteg.io/api/v1';
const LOCATION_ID = 722227;

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await closeAllApps();
});

async function startWithCompanyFixture(): Promise<{
  harness: Harness;
  upstream: FakeFetch;
}> {
  const upstream = fakeFetch([
    {
      method: 'GET',
      path: `/company/${LOCATION_ID}`,
      reply: loadFixture('company', 'default'),
    },
  ]);
  const harness = await startApp({
    tools: productionTools,
    toolDeps: {
      booking: new BookingClient({
        base: API_BASE,
        token: CANARY_SECRET,
        fetch: upstream.fetch,
      }),
    },
  });
  return { harness, upstream };
}

async function connect(harness: Harness): Promise<Client> {
  const client = new Client({ name: 'jest-booking-flow', version: '0.0.0' });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${harness.baseUrl}/mcp`))
  );
  return client;
}

describe('business_get end to end (tracer)', () => {
  it('lists business_get over POST /mcp', async () => {
    const { harness } = await startWithCompanyFixture();
    const client = await connect(harness);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('business_get');
  });

  it('returns the business card from one company call with the partner token in the Authorization header', async () => {
    const { harness, upstream } = await startWithCompanyFixture();
    const client = await connect(harness);

    // The SDK client validates structuredContent against the output schema.
    const result = await client.callTool({
      name: 'business_get',
      arguments: { location_id: LOCATION_ID },
    });

    expect(result.isError).toBeFalsy();
    expect(upstream.unmatched).toEqual([]);
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0];
    expect(call?.method).toBe('GET');
    expect(call?.url.toString()).toBe(
      `${API_BASE}/company/${LOCATION_ID}?forBooking=1&showBookforms=1`
    );
    expect(call?.headers.get('accept')).toBe(ALTEGIO_ACCEPT);
    expect(call?.headers.get('authorization')).toBe(`Bearer ${CANARY_SECRET}`);

    const card = result.structuredContent as {
      location_id: number;
      name: string | null;
      online_booking: { booking_form_url: string | null; enabled: boolean };
    };
    expect(card.location_id).toBe(LOCATION_ID);
    expect(card.name).toBe('Demo Beauty Studio');
    expect(card.online_booking.booking_form_url).toBe(
      'https://n1463903.alteg.io/'
    );
    expect(card.online_booking.enabled).toBe(true);

    const text =
      (result.content as { type: string; text: string }[])[0]?.text ?? '';
    const open = text.indexOf(UNTRUSTED_OPEN);
    const name = text.indexOf('Demo Beauty Studio');
    const close = text.indexOf(UNTRUSTED_CLOSE);
    expect(open).toBeGreaterThanOrEqual(0);
    expect(name).toBeGreaterThan(open);
    expect(close).toBeGreaterThan(name);
    // Our own summary comes first and carries no business text.
    expect(text.slice(0, open)).not.toContain('Demo Beauty Studio');
  });

  it('never returns the partner token in the raw HTTP response', async () => {
    const { harness, upstream } = await startWithCompanyFixture();
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('business_get', { location_id: LOCATION_ID })
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Demo Beauty Studio');
    expect(body).not.toContain(CANARY_SECRET);
    expect(upstream.calls).toHaveLength(1);
  });
});

// The full known-business flow: business_get, services, team members, dates,
// time slots, then book_check, with the slot datetime carried through
// unchanged (assumption_delta_decision invariant of plan 02-08).

const DATE = '2026-10-05';

/** Every fixture route the flow needs; book_check answers with `check`. */
function flowUpstream(check: FixtureResponse): FakeFetch {
  return fakeFetch([
    {
      method: 'GET',
      path: `/company/${LOCATION_ID}`,
      reply: loadFixture('company', 'default'),
    },
    {
      method: 'GET',
      path: `/book_services/${LOCATION_ID}`,
      reply: loadFixture('book_services', 'default'),
    },
    {
      method: 'GET',
      path: `/book_staff/${LOCATION_ID}`,
      reply: loadFixture('book_staff', 'default'),
    },
    {
      method: 'GET',
      path: `/book_dates/${LOCATION_ID}`,
      reply: loadFixture('book_dates', 'default'),
    },
    {
      method: 'GET',
      path: `/book_times/${LOCATION_ID}/2098145/${DATE}`,
      reply: loadFixture('book_times', 'named_member'),
    },
    {
      method: 'GET',
      path: `/book_times/${LOCATION_ID}/0/${DATE}`,
      reply: loadFixture('book_times', 'any_member'),
    },
    { method: 'POST', path: `/book_check/${LOCATION_ID}`, reply: check },
  ]);
}

interface Flow {
  harness: Harness;
  upstream: FakeFetch;
  client: Client;
  /** Raw HTTP response bodies the MCP client received. */
  bodies: Promise<string>[];
}

async function startFlow(check: FixtureResponse): Promise<Flow> {
  const upstream = flowUpstream(check);
  const harness = await startApp({
    tools: productionTools,
    toolDeps: {
      booking: new BookingClient({
        base: API_BASE,
        token: CANARY_SECRET,
        fetch: upstream.fetch,
      }),
    },
  });
  const bodies: Promise<string>[] = [];
  const recording: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    bodies.push(response.clone().text());
    return response;
  };
  const client = new Client({ name: 'jest-booking-flow', version: '0.0.0' });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${harness.baseUrl}/mcp`), {
      fetch: recording,
    })
  );
  return { harness, upstream, client, bodies };
}

interface CallOutcome {
  isError: boolean;
  structured: Record<string, unknown> | undefined;
  text: string;
}

async function call(
  flow: Flow,
  name: string,
  args: Record<string, unknown>
): Promise<CallOutcome> {
  // The SDK client validates structuredContent against the output schema.
  const result = await flow.client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    structured: result.structuredContent as Record<string, unknown> | undefined,
    text: (result.content as { type: string; text: string }[])
      .map((part) => part.text)
      .join('\n'),
  };
}

function items<T>(outcome: CallOutcome): T[] {
  expect(outcome.isError).toBe(false);
  return (outcome.structured as { items: T[] }).items;
}

/** The ids, date and slot a client would pick, read only from earlier results. */
async function pickSlot(
  flow: Flow,
  variant: { teamMember: 'named' | 'any'; services: number }
): Promise<{ serviceIds: number[]; teamMemberId: number; datetime: string }> {
  const card = await call(flow, 'business_get', { location_id: LOCATION_ID });
  expect(card.isError).toBe(false);
  const locationId = (card.structured as { location_id: number }).location_id;
  expect(locationId).toBe(LOCATION_ID);

  const services = items<{ id: number }>(
    await call(flow, 'business_list_services', { location_id: locationId })
  );
  const serviceIds = services
    .slice(0, variant.services)
    .map((service) => service.id);

  let teamMemberId = 0;
  if (variant.teamMember === 'named') {
    const members = items<{ id: number }>(
      await call(flow, 'business_list_team_members', {
        location_id: locationId,
        service_ids: serviceIds,
      })
    );
    teamMemberId = members[0]?.id ?? -1;
  }

  const dates = items<{ date: string }>(
    await call(flow, 'business_list_dates', {
      location_id: locationId,
      service_ids: serviceIds,
      team_member_id: teamMemberId,
    })
  );
  const date = dates[0]?.date ?? '';

  const slots = items<{ datetime: string }>(
    await call(flow, 'business_list_time_slots', {
      location_id: locationId,
      service_ids: serviceIds,
      team_member_id: teamMemberId,
      date,
    })
  );
  return { serviceIds, teamMemberId, datetime: slots[0]?.datetime ?? '' };
}

/** d + YY + DD + MM + HH + mm, copied from the slot string's digits. */
function dToken(datetime: string): string {
  const match = /^\d{2}(\d{2})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(datetime);
  if (match === null) throw new Error(`not a slot datetime: ${datetime}`);
  const [, yy, month, day, hour, minute] = match;
  return `d${yy}${day}${month}${hour}${minute}`;
}

function checkBody(upstream: FakeFetch): string {
  const posts = upstream.calls.filter((entry) => entry.method === 'POST');
  expect(posts).toHaveLength(1);
  return posts[0]?.body ?? '';
}

const ROUTE_PATTERNS = Object.values(BOOKING_ROUTES).map((entry) => ({
  method: entry.method,
  pattern: new RegExp(
    `^/api/v1${entry.route.replace(/\{[a-z_]+\}/g, '[^/]+')}$`
  ),
}));

async function expectCleanTraffic(flow: Flow): Promise<void> {
  expect(flow.upstream.unmatched).toEqual([]);
  for (const entry of flow.upstream.calls) {
    const known = ROUTE_PATTERNS.some(
      (route) =>
        route.method === entry.method && route.pattern.test(entry.url.pathname)
    );
    expect(known).toBe(true);
  }
  const bodies = await Promise.all(flow.bodies);
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) expect(body).not.toContain(CANARY_SECRET);
}

async function toolCallLogs(
  harness: Harness,
  count: number
): Promise<LogLine[]> {
  const deadline = Date.now() + 2000;
  const calls = (): LogLine[] =>
    harness.logs.filter((line) => line.rpc_method === 'tools/call');
  while (calls().length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return calls();
}

type CheckOut = {
  status: string;
  link: { url: string; kind: string };
  selection: { team_member: unknown; time: string; date: string };
};

describe('known-business flow from a location id to a pre-selected link (ROADMAP criterion 1)', () => {
  it('variant A: a named team member and one service; the slot datetime reaches the check and the link unchanged', async () => {
    const flow = await startFlow(loadFixture('book_check', 'created_empty'));
    const { serviceIds, teamMemberId, datetime } = await pickSlot(flow, {
      teamMember: 'named',
      services: 1,
    });
    expect(serviceIds).toHaveLength(1);
    expect(teamMemberId).toBeGreaterThan(0);

    const result = await call(flow, 'book_check', {
      location_id: LOCATION_ID,
      service_ids: serviceIds,
      team_member_id: teamMemberId,
      datetime,
    });
    expect(result.isError).toBe(false);

    // The datetime from business_list_time_slots, byte for byte.
    const body = checkBody(flow.upstream);
    expect(body).toContain(`"datetime":"${datetime}"`);
    const sent = JSON.parse(body) as {
      appointments: {
        datetime: string;
        staff_id: number;
        services: number[];
      }[];
    };
    expect(sent.appointments).toHaveLength(1);
    expect(sent.appointments[0]?.datetime).toBe(datetime);
    expect(sent.appointments[0]?.staff_id).toBe(teamMemberId);
    expect(sent.appointments[0]?.services).toEqual(serviceIds);

    const out = result.structured as CheckOut;
    expect(out.status).toBe('verified');
    expect(out.link.kind).toBe('preselected');
    expect(out.link.url).toBe(
      `https://n1463903.alteg.io/company/${LOCATION_ID}?o=m${teamMemberId}s${serviceIds[0]}${dToken(datetime)}`
    );
    expect(out.link.url.endsWith(dToken(datetime))).toBe(true);
    expect(result.text).toContain(out.link.url);

    await expectCleanTraffic(flow);
    const logs = await toolCallLogs(flow.harness, 6);
    expect(logs.map((line) => line.tool)).toEqual([
      'business_get',
      'business_list_services',
      'business_list_team_members',
      'business_list_dates',
      'business_list_time_slots',
      'book_check',
    ]);
    for (const line of logs) expect(line.outcome).toBe('ok');
  });

  it('variant B: any team member and two services; path segment 0, staff_id 0, m-1 and both services in order', async () => {
    const flow = await startFlow(loadFixture('book_check', 'created_empty'));
    const { serviceIds, teamMemberId, datetime } = await pickSlot(flow, {
      teamMember: 'any',
      services: 2,
    });
    expect(serviceIds).toHaveLength(2);
    expect(teamMemberId).toBe(0);
    const slotRequest = flow.upstream.calls.find((entry) =>
      entry.url.pathname.includes('/book_times/')
    );
    expect(slotRequest?.url.pathname).toBe(
      `/api/v1/book_times/${LOCATION_ID}/0/${DATE}`
    );

    const result = await call(flow, 'book_check', {
      location_id: LOCATION_ID,
      service_ids: serviceIds,
      team_member_id: teamMemberId,
      datetime,
    });
    expect(result.isError).toBe(false);

    const body = checkBody(flow.upstream);
    expect(body).toContain(`"datetime":"${datetime}"`);
    expect(JSON.parse(body)).toEqual({
      appointments: [{ id: 1, services: serviceIds, staff_id: 0, datetime }],
    });

    const out = result.structured as CheckOut;
    expect(out.status).toBe('verified');
    expect(out.selection.team_member).toBeNull();
    expect(out.link.url).toBe(
      `https://n1463903.alteg.io/company/${LOCATION_ID}?o=m-1s${serviceIds[0]}s${serviceIds[1]}${dToken(datetime)}`
    );

    await expectCleanTraffic(flow);
    const logs = await toolCallLogs(flow.harness, 5);
    expect(logs.map((line) => line.tool)).toEqual([
      'business_get',
      'business_list_services',
      'business_list_dates',
      'business_list_time_slots',
      'book_check',
    ]);
    expect(logs.at(-1)?.outcome).toBe('ok');
  });

  it('variant C: a slot taken meanwhile (422, code 433) gives an error with no link that names business_list_time_slots', async () => {
    const flow = await startFlow(loadFixture('book_check', 'taken_433'));
    const { serviceIds, teamMemberId, datetime } = await pickSlot(flow, {
      teamMember: 'named',
      services: 1,
    });
    const result = await flow.client.callTool({
      name: 'book_check',
      arguments: {
        location_id: LOCATION_ID,
        service_ids: serviceIds,
        team_member_id: teamMemberId,
        datetime,
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const text = (result.content as { type: string; text: string }[])
      .map((part) => part.text)
      .join('\n');
    expect(text).toContain('business_list_time_slots');
    expect(text).not.toMatch(/https?:\/\//);
    expect(checkBody(flow.upstream)).toContain(`"datetime":"${datetime}"`);
    // No card, services or team-member read after a rejected check.
    expect(flow.upstream.calls.at(-1)?.method).toBe('POST');

    await expectCleanTraffic(flow);
    const logs = await toolCallLogs(flow.harness, 6);
    expect(logs).toHaveLength(6);
    expect(logs.at(-1)?.tool).toBe('book_check');
    expect(logs.at(-1)?.outcome).toBe('tool_error');
    for (const line of logs.slice(0, -1)) expect(line.outcome).toBe('ok');
  });

  it('lists the eleven tools over POST /mcp, with book_check annotated read-only and the client write tools as the only writes', async () => {
    const flow = await startFlow(loadFixture('book_check', 'created_empty'));
    const { tools } = await flow.client.listTools();
    // The MCP layer lists tools by name; the registry order is checked by the compliance suite.
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'business_get',
        'business_list_services',
        'business_list_team_members',
        'business_list_dates',
        'business_list_time_slots',
        'book_check',
        'me_list_places',
        'me_list_bookings',
        'me_book',
        'me_reschedule_booking',
        'me_cancel_booking',
      ].sort()
    );
    const check = tools.find((tool) => tool.name === 'book_check');
    expect(check?.annotations?.readOnlyHint).toBe(true);
    expect(check?.annotations?.destructiveHint).toBe(false);
    expect(
      tools
        .filter((tool) => tool.annotations?.readOnlyHint !== true)
        .map((tool) => tool.name)
        .sort()
    ).toEqual(['me_book', 'me_cancel_booking', 'me_reschedule_booking']);
    for (const name of ['me_reschedule_booking', 'me_cancel_booking']) {
      const change = tools.find((tool) => tool.name === name);
      expect(change?.annotations?.destructiveHint).toBe(true);
    }
  });
});

// WR-04 (D-01): a client that drops a tools/call stops the work behind it. The
// fake upstream never answers; once the HTTP request is aborted, the fetch of
// that tool call must see its signal abort and nothing else may be sent.

async function until(done: () => boolean, limitMs: number): Promise<boolean> {
  const stop = Date.now() + limitMs;
  while (!done()) {
    if (Date.now() > stop) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

describe('a client that disconnects mid tools/call (WR-04)', () => {
  it('aborts the upstream fetch of that call and sends nothing further', async () => {
    const stalled = fakeFetch([
      {
        method: 'GET',
        path: `/company/${LOCATION_ID}`,
        // fakeFetch rejects with the signal's reason when init.signal aborts.
        reply: () => new Promise<never>(() => undefined),
      },
    ]);
    const signals: AbortSignal[] = [];
    const recording: typeof fetch = (input, init) => {
      if (init?.signal) signals.push(init.signal);
      return stalled.fetch(input, init);
    };
    const harness = await startApp({
      tools: productionTools,
      toolDeps: {
        booking: new BookingClient({
          base: API_BASE,
          token: CANARY_SECRET,
          fetch: recording,
        }),
      },
    });

    const hangUp = new AbortController();
    const request = postMcp(
      harness.baseUrl,
      toolCallBody('business_get', { location_id: LOCATION_ID }),
      {},
      hangUp.signal
    ).catch(() => null);
    expect(await until(() => stalled.calls.length === 1, 2000)).toBe(true);

    setTimeout(() => hangUp.abort(), 100);
    await request;

    expect(await until(() => signals[0]?.aborted === true, 2000)).toBe(true);
    // Time for any wrongly started follow-up call to show up.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stalled.calls).toHaveLength(1);
    expect(signals).toHaveLength(1);
  });
});

// OPS-05 (research Pitfall 17): /health and tools/list stay green while a
// revoked token fails every real call, so each failed call logs the kind of the
// Altegio API failure; our own gate turning a call away is a separate field.

function companyReply(reply: FixtureResponse | (() => FixtureResponse)) {
  return fakeFetch([{ method: 'GET', path: `/company/${LOCATION_ID}`, reply }]);
}

async function callBusinessGet(
  booking: BookingClient
): Promise<{ line: LogLine; isError: boolean }> {
  const harness = await startApp({
    tools: productionTools,
    toolDeps: { booking },
  });
  const res = await postMcp(
    harness.baseUrl,
    toolCallBody('business_get', { location_id: LOCATION_ID })
  );
  const body = (await res.json()) as { result?: { isError?: boolean } };
  const logs = await waitForLogs(harness, 1);
  const line = logs.find((entry) => entry.rpc_method === 'tools/call');
  if (line === undefined) throw new Error('no tools/call log line');
  return { line, isError: body.result?.isError === true };
}

function clientFor(upstream: FakeFetch, gate?: GateLike): BookingClient {
  return new BookingClient({
    base: API_BASE,
    token: CANARY_SECRET,
    fetch: upstream.fetch,
    gate,
  });
}

describe('the call log names the upstream failure kind (OPS-05, T-03-18, T-03-19)', () => {
  it('logs upstream_kind unauthorized and no limited_by for an upstream 401', async () => {
    const upstream = companyReply({
      status: 401,
      headers: { 'content-type': 'application/json' },
      body: { success: false, data: null, meta: { message: 'Unauthorized' } },
    });
    const { line, isError } = await callBusinessGet(clientFor(upstream));
    expect(isError).toBe(true);
    expect(line.outcome).toBe('tool_error');
    expect(line.upstream_kind).toBe('unauthorized');
    expect(line.limited_by).toBeNull();
  });

  it('logs upstream_kind rate_limited for an upstream 429 that repeats after the inline retry', async () => {
    const upstream = companyReply({
      status: 429,
      headers: { 'content-type': 'application/json' },
      body: { success: false, data: null, meta: { message: 'Too many' } },
    });
    const { line } = await callBusinessGet(clientFor(upstream));
    expect(upstream.calls).toHaveLength(2);
    expect(line.upstream_kind).toBe('rate_limited');
    expect(line.limited_by).toBeNull();
  });

  it('logs limited_by gate and no upstream_kind for a call our own gate turned away', async () => {
    const upstream = companyReply(loadFixture('company', 'default'));
    const saturated: GateLike = {
      run: () => Promise.reject(new GateSaturatedError(3)),
      pauseUntil: () => undefined,
    };
    const { line, isError } = await callBusinessGet(
      clientFor(upstream, saturated)
    );
    expect(isError).toBe(true);
    expect(upstream.calls).toHaveLength(0);
    expect(line.limited_by).toBe('gate');
    expect(line.upstream_kind).toBeNull();
  });

  it('logs null for both on a successful call', async () => {
    const upstream = companyReply(loadFixture('company', 'default'));
    const { line, isError } = await callBusinessGet(clientFor(upstream));
    expect(isError).toBe(false);
    expect(line.outcome).toBe('ok');
    expect(line.upstream_kind).toBeNull();
    expect(line.limited_by).toBeNull();
  });

  it('logs null for both on a tool error the Altegio API did not cause', async () => {
    const upstream = companyReply(loadFixture('company', 'default'));
    const harness = await startApp({
      tools: productionTools,
      toolDeps: { booking: clientFor(upstream) },
    });
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('business_get', { location_id: 'not a number' })
    );
    expect(res.status).toBe(200);
    const logs = await waitForLogs(harness, 1);
    const line = logs.find((entry) => entry.rpc_method === 'tools/call');
    expect(line?.outcome).toBe('invalid_params');
    expect(line?.upstream_kind).toBeNull();
    expect(line?.limited_by).toBeNull();
  });
});

describe('the caller partner token end to end (ADR 0004)', () => {
  async function startRequired(): Promise<{
    harness: Harness;
    upstream: FakeFetch;
  }> {
    const upstream = fakeFetch([
      {
        method: 'GET',
        path: `/company/${LOCATION_ID}`,
        reply: loadFixture('company', 'default'),
      },
    ]);
    const harness = await startApp({
      tools: productionTools,
      toolDeps: {
        booking: new BookingClient({
          base: API_BASE,
          token: CANARY_SECRET,
          fetch: upstream.fetch,
        }),
      },
      callerAuth: { mode: 'required', validator: stubPartnerValidator() },
    });
    return { harness, upstream };
  }

  it('calls the Altegio API with the caller token, never the server token', async () => {
    const { harness, upstream } = await startRequired();
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('business_get', { location_id: LOCATION_ID }),
      { authorization: `Bearer ${PARTNER_TOKEN}` }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { isError?: boolean } };
    expect(body.result?.isError).not.toBe(true);
    expect(
      upstream.calls.map((call) => call.headers.get('authorization'))
    ).toEqual([`Bearer ${PARTNER_TOKEN}`]);
  });

  it('makes no upstream call without a caller token', async () => {
    const { harness, upstream } = await startRequired();
    const res = await postMcp(
      harness.baseUrl,
      toolCallBody('business_get', { location_id: LOCATION_ID })
    );
    expect(res.status).toBe(401);
    expect(upstream.calls).toEqual([]);
  });
});
