import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from '@jest/globals';
import { BookingClient, type BusinessCard, type TimeSlot } from '../client.js';
import {
  ALLOWED_FORM_HOST_SUFFIXES,
  buildBookingLink,
  plainBookingLink,
  SLOT_DATETIME_PATTERN,
} from '../deep-link.js';
import { RequestGate } from '../gate.js';
import {
  companyDataSchema,
  datesDataSchema,
  servicesDataSchema,
  teamMembersDataSchema,
  timeSlotsDataSchema,
} from '../schemas.js';
import {
  createRecordingFetch,
  RECORDED_ROUTES,
  type RecordedRoute,
  type Recording,
} from './helpers/live-recorder.js';

// Opt-in live suite against the real Altegio booking API, gated as in
// Altegio.Pro MCP (D-10): it runs only with ALTEGIO_E2E=1, through
// `npm run test:live`, which loads the partner token of developer account
// 2630 and ALTEGIO_E2E_LOCATION_ID from the local .env. The required CI job
// never sets ALTEGIO_E2E, so every test here reports as skipped there.
//
// The suite discovers a free slot instead of hard-coding one (first service,
// first bookable team member, first date, first slot), parses every response
// with the route schemas the fixture contract tests use (BAPI-03), and
// confirms D-04: two identical book_check calls are both accepted and the
// slot is still free afterwards, so the validation route holds nothing. All
// calls go through the real RequestGate, sequentially, and the run stays
// within MAX_UPSTREAM_CALLS, because the partner budget is shared with
// Altegio.Pro MCP (D-03). With ALTEGIO_E2E_RECORD=1 the latest successful
// response of each route is written, sanitised, to fixtures/live/.
//
// Conditional cases assert their condition instead of being skipped, so a
// skipped test in a live run always means the gate was not applied.

const LIVE = process.env.ALTEGIO_E2E === '1';
const RECORD = process.env.ALTEGIO_E2E_RECORD === '1';
const describeLive = LIVE ? describe : describe.skip;

const MAX_UPSTREAM_CALLS = 20;
const LIVE_TIMEOUT_MS = 30_000;
const DEFAULT_API_BASE = 'https://api.alteg.io/api/v1';
/** Values that are not a real partner token: unset, .env.example, the unit-test token. */
const PLACEHOLDER_TOKENS: ReadonlySet<string> = new Set([
  '',
  'your_partner_token_here',
  'test-partner-token',
]);
const LIVE_DIR = join(
  process.cwd(),
  'src',
  'booking',
  '__tests__',
  'fixtures',
  'live'
);

function hostAllowed(url: string): boolean {
  const host = new URL(url).hostname;
  return ALLOWED_FORM_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === 'string' ? input : input.url);
}

/** A value an earlier test in this file was expected to find. */
function found<T>(value: T | null, label: string): T {
  if (value === null) {
    throw new Error(`${label} was not found by an earlier live test`);
  }
  return value;
}

describeLive('live Altegio booking API (ALTEGIO_E2E=1)', () => {
  let client: BookingClient;
  let locationId = 0;
  /** Every upstream request URL, in order. */
  const requests: URL[] = [];
  const recordings: Recording[] = [];

  let card: BusinessCard | null = null;
  let catalogServiceIds: number[] = [];
  let serviceId: number | null = null;
  let teamMemberId: number | null = null;
  let date: string | null = null;
  let slot: TimeSlot | null = null;

  /** Sanitised envelope data of the latest response of a route. */
  function latestData(route: RecordedRoute): unknown {
    const recording = recordings
      .filter((entry) => entry.route === route)
      .at(-1);
    return found(recording ?? null, `a ${route} response`).data;
  }

  beforeAll(() => {
    // Neither message carries the token value.
    const token = process.env.ALTEGIO_API_TOKEN ?? '';
    if (PLACEHOLDER_TOKENS.has(token)) {
      throw new Error(
        'ALTEGIO_API_TOKEN in .env must hold the partner token of developer account 2630; it is missing or a placeholder'
      );
    }
    const rawLocation = process.env.ALTEGIO_E2E_LOCATION_ID ?? '';
    if (!/^[1-9]\d*$/.test(rawLocation)) {
      throw new Error(
        'ALTEGIO_E2E_LOCATION_ID in .env must be a positive integer location id'
      );
    }
    locationId = Number(rawLocation);

    const counting: typeof fetch = (input, init) => {
      requests.push(requestUrl(input));
      return fetch(input, init);
    };
    const sink = (recording: Recording): void => {
      recordings.push(recording);
      if (RECORD && recording.status >= 200 && recording.status < 300) {
        mkdirSync(LIVE_DIR, { recursive: true });
        writeFileSync(
          join(LIVE_DIR, `${recording.route}.json`),
          `${JSON.stringify(recording, null, 2)}\n`
        );
      }
    };
    client = new BookingClient({
      base: process.env.ALTEGIO_API_BASE ?? DEFAULT_API_BASE,
      token,
      gate: new RequestGate(),
      fetch: createRecordingFetch(counting, sink, [token]),
    });
  });

  it(
    'company: the card parses, widgetActive mirrors the active flag and the booking-form host is allow-listed',
    async () => {
      card = await client.company(locationId);

      const raw = latestData('company');
      expect(companyDataSchema.safeParse(raw).success).toBe(true);
      expect(card.locationId).toBe(locationId);
      // `active` is SalonService::isWidgetActive (license not frozen, business
      // active or created within 7 days), and the public widget shows its
      // disabled page when it is not 1. A location may legitimately report 0
      // (the demo location 722227 does) while the booking routes still answer,
      // so the card must mirror the flag rather than assume it.
      const active = (raw as { active?: unknown }).active;
      expect(card.widgetActive).toBe(active === 1 || active === true);
      const formUrl = found(card.bookingFormUrl, 'a booking-form URL');
      // On failure the diff names the observed host (02-RESEARCH A5).
      const host = new URL(formUrl).hostname;
      expect({
        host,
        allowListed: plainBookingLink(locationId, formUrl).reason === null,
      }).toEqual({ host, allowListed: true });
    },
    LIVE_TIMEOUT_MS
  );

  it(
    'services: at least one bookable service parses; the first is picked',
    async () => {
      const catalog = await client.services(locationId);

      expect(
        servicesDataSchema.safeParse(latestData('book_services')).success
      ).toBe(true);
      expect(catalog.services.length).toBeGreaterThan(0);
      catalogServiceIds = catalog.services.map((service) => service.id);
      serviceId = catalogServiceIds[0] ?? null;
    },
    LIVE_TIMEOUT_MS
  );

  it(
    'team members for that service parse; the first bookable is picked, else any team member (0)',
    async () => {
      const service = found(serviceId, 'a service');
      const members = await client.teamMembers(locationId, {
        serviceIds: [service],
      });

      expect(
        teamMembersDataSchema.safeParse(latestData('book_staff')).success
      ).toBe(true);
      teamMemberId = members.find((member) => member.bookable)?.id ?? 0;
      expect(teamMemberId).toBeGreaterThanOrEqual(0);
    },
    LIVE_TIMEOUT_MS
  );

  it(
    'dates for that service and team member: at least one parses; the first is picked',
    async () => {
      const dates = await client.dates(locationId, {
        serviceIds: [found(serviceId, 'a service')],
        teamMemberId: found(teamMemberId, 'a team member'),
      });

      expect(datesDataSchema.safeParse(latestData('book_dates')).success).toBe(
        true
      );
      expect(dates.length).toBeGreaterThan(0);
      date = [...dates].sort()[0] ?? null;
    },
    LIVE_TIMEOUT_MS
  );

  it(
    'time slots on that date: at least one parses, every datetime matches the slot pattern; the first is picked',
    async () => {
      const slots = await client.timeSlots(
        locationId,
        found(teamMemberId, 'a team member'),
        found(date, 'a date'),
        [found(serviceId, 'a service')]
      );

      expect(
        timeSlotsDataSchema.safeParse(latestData('book_times')).success
      ).toBe(true);
      expect(slots.length).toBeGreaterThan(0);
      expect(
        slots.filter((entry) => !SLOT_DATETIME_PATTERN.test(entry.datetime))
      ).toEqual([]);
      slot = slots[0] ?? null;
    },
    LIVE_TIMEOUT_MS
  );

  it(
    'time slots for any team member (path segment 0) parse',
    async () => {
      const day = found(date, 'a date');
      const slots = await client.timeSlots(locationId, 0, day, [
        found(serviceId, 'a service'),
      ]);

      expect(
        timeSlotsDataSchema.safeParse(latestData('book_times')).success
      ).toBe(true);
      expect(requests.at(-1)?.pathname).toMatch(
        new RegExp(`/book_times/${locationId}/0/${day}$`)
      );
      expect(
        slots.filter((entry) => !SLOT_DATETIME_PATTERN.test(entry.datetime))
      ).toEqual([]);
    },
    LIVE_TIMEOUT_MS
  );

  it(
    'D-04: two identical book_check calls on a free slot both return 201 and the slot is still listed afterwards',
    async () => {
      const chosen = found(slot, 'a free slot');
      const member = found(teamMemberId, 'a team member');
      const service = found(serviceId, 'a service');
      const day = found(date, 'a date');
      const selection = {
        serviceIds: [service],
        teamMemberId: member,
        datetime: chosen.datetime,
      };

      await expect(
        client.check(locationId, selection)
      ).resolves.toBeUndefined();
      await expect(
        client.check(locationId, selection)
      ).resolves.toBeUndefined();
      expect(
        recordings.filter(
          (entry) => entry.route === 'book_check' && entry.status === 201
        )
      ).toHaveLength(2);

      // A hold or a record would take the slot out of the free list.
      const after = await client.timeSlots(locationId, member, day, [service]);
      expect(after.map((entry) => entry.datetime)).toContain(chosen.datetime);
    },
    LIVE_TIMEOUT_MS
  );

  it(
    'two services: dates with both ids parse and the request carries two service_ids[] entries',
    async () => {
      const service = found(serviceId, 'a service');
      const member = found(teamMemberId, 'a team member');
      const offered =
        member > 0
          ? (
              await client.services(locationId, { teamMemberId: member })
            ).services.map((entry) => entry.id)
          : catalogServiceIds;
      const second = offered.find((id) => id !== service);
      if (second === undefined) {
        // The team member offers only the one service: nothing to combine.
        expect(offered.filter((id) => id !== service)).toEqual([]);
        return;
      }

      await client.dates(locationId, {
        serviceIds: [service, second],
        teamMemberId: member,
      });

      expect(datesDataSchema.safeParse(latestData('book_dates')).success).toBe(
        true
      );
      const request = requests
        .filter((url) => url.pathname.includes('/book_dates/'))
        .at(-1);
      expect(request?.searchParams.getAll('service_ids[]')).toEqual([
        String(service),
        String(second),
      ]);
    },
    LIVE_TIMEOUT_MS
  );

  it('the booking link built from the live card and slot points at an allow-listed host', () => {
    const liveCard = found(card, 'a business card');
    const link = buildBookingLink({
      locationId,
      formUrl: liveCard.bookingFormUrl,
      teamMemberId: found(teamMemberId, 'a team member'),
      serviceIds: [found(serviceId, 'a service')],
      slotDatetime: found(slot, 'a free slot').datetime,
      businessUtcOffsetHours: liveCard.utcOffsetHours,
      anyTeamMemberAllowed: liveCard.anyTeamMemberAllowed,
    });

    expect(hostAllowed(link.url)).toBe(true);
    expect(
      link.url.startsWith(
        plainBookingLink(locationId, liveCard.bookingFormUrl).url
      )
    ).toBe(true);
  });

  it('the recordings on disk hold no partner token and no e-mail address', () => {
    // Runs with the real token in the environment, which the required CI job
    // never has; the CI recordings test covers e-mails and phones only.
    const token = process.env.ALTEGIO_API_TOKEN ?? '';
    const files = existsSync(LIVE_DIR)
      ? readdirSync(LIVE_DIR).filter((name) => name.endsWith('.json'))
      : [];
    const problems: string[] = [];
    for (const name of files) {
      const text = readFileSync(join(LIVE_DIR, name), 'utf8');
      if (token.length >= 8 && text.includes(token)) {
        problems.push(`${name}: partner token`);
      }
      if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(text)) {
        problems.push(`${name}: e-mail address`);
      }
    }
    // Only file names and a label are reported, never the token.
    expect(problems).toEqual([]);
    if (RECORD) {
      expect(files.map((name) => name.replace(/\.json$/, '')).sort()).toEqual(
        [...RECORDED_ROUTES].sort()
      );
    }
  });

  it(`stays within ${MAX_UPSTREAM_CALLS} upstream calls`, () => {
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.length).toBeLessThanOrEqual(MAX_UPSTREAM_CALLS);
  });
});
