import { afterEach, describe, expect, it } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BookingClient } from '../booking/client.js';
import { ALTEGIO_ACCEPT } from '../booking/http.js';
import {
  fakeFetch,
  loadFixture,
  type FakeFetch,
} from '../booking/__tests__/helpers/fake-fetch.js';
import { productionTools } from '../tools/registry.js';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '../tools/untrusted.js';
import {
  CANARY_SECRET,
  closeAllApps,
  postMcp,
  startApp,
  toolCallBody,
  type Harness,
} from './helpers/http-harness.js';

// End to end through every layer the phase builds: SDK client -> POST /mcp ->
// MCP layer -> business_get -> BookingClient -> BookingHttp -> (fake) Altegio
// API. Only fetch is replaced; everything else is the production code.

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
