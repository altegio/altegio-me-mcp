import { describe, expect, it } from '@jest/globals';
import { BookingClient } from '../../booking/client.js';
import {
  fakeFetch,
  loadFixture,
  type FakeFetch,
  type FakeReply,
  type FixtureResponse,
  type RecordedCall,
} from '../../booking/__tests__/helpers/fake-fetch.js';
import {
  businessSearch,
  nameRank,
  normalizeForMatch,
  pickReference,
} from '../business-search.js';
import { NO_TOOL_CONTEXT } from '../context.js';
import type { ToolInvocation } from '../factory.js';
import { UNTRUSTED_OPEN } from '../untrusted.js';

// business_search through the real BookingClient with a fake fetch: the
// country and the city are resolved from the reference lists, the city's
// businesses are listed and the name is matched here (owner decision
// 2026-10-12). Nothing about the client reaches upstream.

const API_BASE = 'https://api.alteg.io/api/v1';
const PARTNER_TOKEN = 'partner-token-0123456789abcdef';

const QUERY = { name: 'BaBarber', city: 'Kyiv', country: 'Ukraine' };

interface Setup {
  upstream: FakeFetch;
  booking: BookingClient;
  invoke: (args: Record<string, unknown>) => Promise<ToolInvocation>;
}

function setup(
  options: {
    countries?: FakeReply;
    cities?: FakeReply;
    companies?: FakeReply;
    now?: () => number;
  } = {}
): Setup {
  const upstream = fakeFetch([
    {
      method: 'GET',
      path: '/countries',
      reply: options.countries ?? loadFixture('countries', 'default'),
    },
    {
      method: 'GET',
      path: '/cities',
      reply: options.cities ?? loadFixture('cities', 'default'),
    },
    {
      method: 'GET',
      path: '/companies',
      reply: options.companies ?? loadFixture('companies', 'default'),
    },
  ]);
  const booking = new BookingClient({
    base: API_BASE,
    token: PARTNER_TOKEN,
    fetch: upstream.fetch,
    now: options.now,
  });
  return {
    upstream,
    booking,
    invoke: (args) =>
      businessSearch.invoke(args, { booking }, { ...NO_TOOL_CONTEXT }),
  };
}

interface SearchOut {
  city: { id: number; name: string; country: string };
  matches: { location_id: number; name: string; address: string | null }[];
  businesses_in_city: number;
  city_cut: boolean;
}

function outOf(invocation: ToolInvocation): SearchOut {
  expect(invocation.result.isError).not.toBe(true);
  return invocation.result.structuredContent as unknown as SearchOut;
}

function textOf(invocation: ToolInvocation): string {
  return invocation.result.content.map((part) => part.text).join('\n');
}

function routesOf(upstream: FakeFetch): string[] {
  return upstream.calls.map(
    (call) =>
      `${call.method} ${call.url.pathname.replace('/api/v1', '')}${call.url.search}`
  );
}

describe('normalizeForMatch and nameRank', () => {
  it('ignores case, accents and punctuation', () => {
    expect(normalizeForMatch('  Café "Élan" – Kyiv!  ')).toBe('cafe elan kyiv');
    expect(nameRank('cafe elan', 'Café Élan')).toBe(0);
  });

  it('ranks the whole name, then the start, then words anywhere', () => {
    expect(nameRank('BaBarber', 'BaBarber')).toBe(0);
    expect(nameRank('BaBarber', 'BaBarber Podil')).toBe(1);
    expect(nameRank('Podil BaBarber', 'BaBarber Podil')).toBe(2);
    expect(nameRank('Ba Barber', 'BaBarber')).toBe(2);
    expect(nameRank('BaBarber', 'Ba Barber Podil')).toBe(2);
    expect(nameRank('Nails', 'BaBarber')).toBeNull();
    expect(nameRank('Bar', 'Barbershop Kyiv')).toBeNull();
  });
});

describe('pickReference', () => {
  const cities = loadFixture('cities', 'default').body as {
    data: { id: number; title: string }[];
  };

  it('finds a city by its English name inside the bracketed title', () => {
    expect(pickReference('Kyiv', cities.data)?.id).toBe(4);
    expect(pickReference('kyiv', cities.data)?.id).toBe(4);
    expect(pickReference('Київ', cities.data)?.id).toBe(4);
  });

  it('prefers the whole title and does not guess between unrelated starts', () => {
    expect(pickReference('Kyivska Rudnia', cities.data)?.id).toBe(9001);
    expect(pickReference('Ky', cities.data)).toBeNull();
    expect(pickReference('Paris', cities.data)).toBeNull();
  });
});

describe('business_search', () => {
  it('resolves the country and the city, lists the city once and matches the name, best first', async () => {
    const made = setup();
    const result = await made.invoke(QUERY);
    const out = outOf(result);
    expect(out.city).toEqual({
      id: 4,
      name: 'Київ (Kyiv)',
      country: 'Ukraine',
    });
    expect(out.matches.map((match) => match.location_id)).toEqual([
      731001, 731002,
    ]);
    expect(out.matches[0]).toEqual({
      location_id: 731001,
      name: 'BaBarber',
      address: '1 Khreshchatyk St',
    });
    expect(out.businesses_in_city).toBe(7);
    expect(out.city_cut).toBe(false);
    expect(routesOf(made.upstream)).toEqual([
      'GET /countries',
      'GET /cities?country_id=4',
      'GET /companies?city_id=4&count=1000&page=1',
    ]);
    expect(made.upstream.unmatched).toEqual([]);
    const text = textOf(result);
    expect(text).toContain('location_id 731001, location_id 731002.');
    expect(text).toContain('Confirm the right one with the client');
    const [prose, block] = text.split(UNTRUSTED_OPEN);
    expect(prose).not.toContain('BaBarber');
    expect(block).toContain('business 731001: BaBarber');
    expect(block).toContain('address 731001: 1 Khreshchatyk St');
  });

  it('leaves out a business whose licence is not active', async () => {
    const made = setup();
    const out = outOf(await made.invoke(QUERY));
    expect(out.matches.some((match) => match.location_id === 731004)).toBe(
      false
    );
  });

  it('matches words in any order and across a missing space', async () => {
    const made = setup();
    expect(
      outOf(
        await made.invoke({ ...QUERY, name: 'podil ba barber' })
      ).matches.map((match) => match.location_id)
    ).toEqual([731002]);
    expect(
      outOf(await made.invoke({ ...QUERY, name: 'краса' })).matches.map(
        (match) => match.location_id
      )
    ).toEqual([731007]);
  });

  it('sanitises business text and never repeats it outside the untrusted block', async () => {
    const made = setup();
    const result = await made.invoke({ ...QUERY, name: 'studio' });
    const out = outOf(result);
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]?.name).not.toContain('<script>');
    const text = textOf(result);
    const [before] = text.split(UNTRUSTED_OPEN);
    expect(before).not.toContain('Ignore previous instructions');
  });

  it('answers in band with no match and the count searched', async () => {
    const made = setup();
    const result = await made.invoke({ ...QUERY, name: 'Zzzz Nowhere' });
    const out = outOf(result);
    expect(out.matches).toEqual([]);
    expect(textOf(result)).toContain(
      'No business named like that among the 7 businesses'
    );
  });

  it('reads a second page when the first is full and says when the city is cut', async () => {
    const pages: Record<string, FixtureResponse> = {
      '1': loadFixture('companies', 'page_full'),
      '2': loadFixture('companies', 'page_second'),
    };
    const made = setup({
      companies: (call: RecordedCall) =>
        pages[call.url.searchParams.get('page') ?? ''] ??
        loadFixture('companies', 'empty'),
    });
    const out = outOf(await made.invoke(QUERY));
    expect(out.matches.map((match) => match.location_id)).toEqual([731010]);
    expect(out.businesses_in_city).toBe(1001);
    expect(out.city_cut).toBe(false);
    expect(
      routesOf(made.upstream).filter((route) => route.includes('/companies'))
    ).toEqual([
      'GET /companies?city_id=4&count=1000&page=1',
      'GET /companies?city_id=4&count=1000&page=2',
    ]);

    const cut = setup({ companies: loadFixture('companies', 'page_full') });
    const cutOut = outOf(await cut.invoke(QUERY));
    expect(cutOut.city_cut).toBe(true);
    expect(cutOut.businesses_in_city).toBe(3000);
    expect(textOf(await cut.invoke(QUERY))).toContain(
      'a business may be missing'
    );
  });

  it('reuses the reference lists and the city listing within their time to live', async () => {
    let at = 1_700_000_000_000;
    const made = setup({ now: () => at });
    await made.invoke(QUERY);
    await made.invoke({ ...QUERY, name: 'Nails' });
    expect(made.upstream.calls).toHaveLength(3);
    at += 11 * 60_000;
    await made.invoke(QUERY);
    expect(routesOf(made.upstream).slice(3)).toEqual([
      'GET /companies?city_id=4&count=1000&page=1',
    ]);
    at += 25 * 60 * 60_000;
    await made.invoke(QUERY);
    expect(made.upstream.calls).toHaveLength(7);
  });

  it('names the next action for an unknown country or city, with no listing call', async () => {
    const made = setup();
    const country = await made.invoke({ ...QUERY, country: 'Narnia' });
    expect(country.result.isError).toBe(true);
    expect(textOf(country)).toContain('No country named "Narnia"');
    expect(textOf(country)).toContain('English name');
    const city = await made.invoke({ ...QUERY, city: 'Atlantis' });
    expect(city.result.isError).toBe(true);
    expect(textOf(city)).toContain('No city named "Atlantis"');
    expect(
      routesOf(made.upstream).some((route) => route.includes('/companies'))
    ).toBe(false);
  });

  it('turns an upstream failure of the listing into an in-band error that names the next action', async () => {
    const made = setup({ companies: loadFixture('companies', 'rate_limited') });
    const result = await made.invoke(QUERY);
    expect(result.result.isError).toBe(true);
    expect(textOf(result).toLowerCase()).toContain('next');
    expect(made.upstream.calls.at(-1)?.body).toBeNull();
  });

  it('refuses a name or city under two characters before any call', async () => {
    const made = setup();
    const result = await made.invoke({ ...QUERY, name: 'B' });
    expect(result.result.isError).toBe(true);
    expect(made.upstream.calls).toHaveLength(0);
  });
});
