import { z } from 'zod';
import { BOOKING_ROUTES, type CompanySummary } from '../booking/client.js';
import { upstreamCall } from './context.js';
import { ToolError } from './errors.js';
import { defineTool } from './factory.js';
import { UPSTREAM_READ_HINTS, untrustedText } from './business.js';
import type { ToolDeps } from './registry.js';
import { toToolError } from './upstream-errors.js';
import {
  UNTRUSTED_NOTE,
  sanitizeUntrusted,
  withUntrustedBlock,
} from './untrusted.js';

// business_search (owner decision 2026-10-12): a client names a business and
// its city; nobody asks a client for a location id. The API has no text
// search (docs/research/altegio-booking-api.md), so the tool resolves the
// country and the city from the reference lists, lists the city's businesses
// (GET /companies?city_id=, at most three pages of 1000) and matches the name
// here. The lists are reused for a while per process; nothing about the
// client is kept. The answer is a short list of candidates for the client to
// confirm, each with the location id the other tools take.

const TOOL_NAME = 'business_search';
const MAX_MATCHES = 10;
const NAME_MAX_CHARS = 120;

const searchInput = z.strictObject({
  name: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .describe(
      'The business name as the client says it, two characters or more; whole words, in any order, case does not matter.'
    ),
  city: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .describe(
      'The city, as a name; the English name works best, the local name is also accepted.'
    ),
  country: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .describe('The country, as its English name.'),
});

type SearchInput = z.infer<typeof searchInput>;

const matchSchema = z.strictObject({
  location_id: z
    .number()
    .int()
    .describe('Location id of the business, the id the other tools take.'),
  name: z.string().describe(`Business name. ${UNTRUSTED_NOTE}`),
  address: untrustedText('Street address.'),
});

const searchOutput = z.strictObject({
  city: z.strictObject({
    id: z.number().int().describe('City id in Altegio.'),
    name: z
      .string()
      .describe(`City name as Altegio lists it. ${UNTRUSTED_NOTE}`),
    country: z
      .string()
      .describe(`Country name as Altegio lists it. ${UNTRUSTED_NOTE}`),
  }),
  matches: z
    .array(matchSchema)
    .describe(
      'Businesses in the city whose name holds every word of the query, best match first, at most 10.'
    ),
  businesses_in_city: z
    .number()
    .int()
    .describe('How many businesses of the city were searched.'),
  city_cut: z
    .boolean()
    .describe(
      'True when the city holds more businesses than the search read, so a business may be missing.'
    ),
});

type SearchOutput = z.infer<typeof searchOutput>;

/**
 * Case, accent and punctuation insensitive text for matching: NFKD, combining
 * marks removed, letters and digits kept, everything else a single space.
 */
export function normalizeForMatch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Match rank: 0 the whole name, 1 the start, 2 somewhere inside, null no match. */
export function nameRank(query: string, candidate: string): number | null {
  const q = normalizeForMatch(query);
  const c = normalizeForMatch(candidate);
  if (q === '' || c === '') return null;
  if (c === q) return 0;
  if (c.startsWith(`${q} `)) return 1;
  const words = q.split(' ');
  const padded = ` ${c} `;
  // Every word of the query as a whole word of the name, in any order.
  if (words.every((word) => padded.includes(` ${word} `))) return 2;
  // The query without its spaces equal to a run of whole words of the name
  // without theirs ("Ba Barber" finds "BaBarber", "BaBarber" finds "Ba Barber
  // Podil"); a word fragment ("Bar" in "Barbershop") never matches.
  const compact = q.replace(/ /g, '');
  const parts = c.split(' ');
  for (let start = 0; start < parts.length; start += 1) {
    let run = '';
    for (let end = start; end < parts.length; end += 1) {
      run += parts[end];
      if (run === compact) return 2;
      if (run.length >= compact.length) break;
    }
  }
  return null;
}

/**
 * The reference entry whose title matches the query best: the whole title,
 * else a bracketed or separated part of it ("Київ (Kyiv)" for "Kyiv"), else
 * the title starting with the query. Null when nothing matches or the match
 * is ambiguous between unrelated titles.
 */
export function pickReference<T extends { title: string }>(
  query: string,
  entries: readonly T[]
): T | null {
  const q = normalizeForMatch(query);
  if (q === '') return null;
  const whole = entries.filter((entry) => normalizeForMatch(entry.title) === q);
  if (whole.length >= 1) return whole[0] ?? null;
  const part = entries.filter((entry) =>
    entry.title
      .split(/[()/,;|]+/)
      .map((piece) => normalizeForMatch(piece))
      .some((piece) => piece === q)
  );
  if (part.length >= 1) return part[0] ?? null;
  const starts = entries.filter((entry) =>
    normalizeForMatch(entry.title).startsWith(`${q} `)
  );
  return starts.length === 1 ? (starts[0] ?? null) : null;
}

function renderSearch(out: SearchOutput): string {
  const lines: string[] = [];
  const fields: Record<string, string> = {};
  if (out.matches.length === 0) {
    lines.push(
      `No business named like that among the ${out.businesses_in_city} businesses of ${out.city.name}, ${out.city.country} that take online bookings through Altegio.`
    );
    lines.push(
      'Next: check the spelling or try another word of the name; a business that does not use Altegio for online booking cannot be found here.'
    );
  } else {
    lines.push(
      `${out.matches.length} business${out.matches.length === 1 ? '' : 'es'} named like that in ${out.city.name}, ${out.city.country}, best match first. Confirm the right one with the client before booking; its location_id is what the other tools take.`
    );
    // Ids in the prose, names and addresses only inside the untrusted block,
    // as the card does.
    lines.push(
      `Matches, in order: ${out.matches.map((match) => `location_id ${match.location_id}`).join(', ')}.`
    );
    for (const match of out.matches) {
      fields[`business ${match.location_id}`] = match.name;
      if (match.address !== null) {
        fields[`address ${match.location_id}`] = match.address;
      }
    }
  }
  if (out.city_cut) {
    lines.push(
      `The city holds more businesses than the search read (${out.businesses_in_city}); a business may be missing.`
    );
  }
  fields.city = out.city.name;
  fields.country = out.city.country;
  return withUntrustedBlock(lines.join('\n'), fields);
}

function notFound(what: 'country' | 'city', input: SearchInput): ToolError {
  return what === 'country'
    ? new ToolError(
        `No country named "${sanitizeUntrusted(input.country, { maxChars: 60 }) ?? ''}" in Altegio.`,
        'give the country as its English name, for example "Ukraine" or "Kazakhstan".'
      )
    : new ToolError(
        `No city named "${sanitizeUntrusted(input.city, { maxChars: 100 }) ?? ''}" in that country in Altegio.`,
        'give the city as its English or local name; a small town may be listed under the nearest city.'
      );
}

export const businessSearch = defineTool<
  typeof searchInput,
  typeof searchOutput,
  ToolDeps
>({
  name: TOOL_NAME,
  title: 'Find a business by name',
  description:
    'Finds businesses that take online bookings through Altegio by name in a city: the client names the business, the city and the country, and the answer lists the matching businesses with their location ids, best match first, at most 10. Use it when the client names a place that is not among their own places; confirm the right match with the client, then continue with business_get or the services and slots. Matching is by whole words in any order, case and accents do not matter. No text search exists upstream: the tool reads the city’s business list (up to three pages of 1000) and matches here.',
  annotations: UPSTREAM_READ_HINTS,
  upstream: [
    BOOKING_ROUTES.countries,
    BOOKING_ROUTES.cities,
    BOOKING_ROUTES.companies,
  ],
  input: searchInput,
  output: searchOutput,
  render: renderSearch,
  handler: async ({ input, deps, ctx }) => {
    const call = upstreamCall(ctx);
    let countries;
    try {
      countries = await deps.booking.countries(call);
    } catch (error) {
      throw toToolError(error);
    }
    const country = pickReference(input.country, countries);
    if (country === null) throw notFound('country', input);

    let cities;
    try {
      cities = await deps.booking.cities(country.id, call);
    } catch (error) {
      throw toToolError(error);
    }
    const city = pickReference(input.city, cities);
    if (city === null) throw notFound('city', input);

    let listing;
    try {
      listing = await deps.booking.companiesInCity(city.id, call);
    } catch (error) {
      throw toToolError(error);
    }

    const ranked: { rank: number; business: CompanySummary }[] = [];
    for (const business of listing.businesses) {
      if (!business.active) continue;
      const rank = nameRank(input.name, business.name);
      if (rank !== null) ranked.push({ rank, business });
    }
    ranked.sort(
      (a, b) =>
        a.rank - b.rank ||
        a.business.name.localeCompare(b.business.name) ||
        a.business.locationId - b.business.locationId
    );

    return {
      city: {
        id: city.id,
        name: sanitizeUntrusted(city.title, { maxChars: 100 }) ?? '',
        country: sanitizeUntrusted(country.title, { maxChars: 60 }) ?? '',
      },
      matches: ranked.slice(0, MAX_MATCHES).map(({ business }) => ({
        location_id: business.locationId,
        name:
          sanitizeUntrusted(business.name, { maxChars: NAME_MAX_CHARS }) ?? '',
        address: sanitizeUntrusted(business.address),
      })),
      businesses_in_city: listing.businesses.length,
      city_cut: listing.cut,
    };
  },
});
