import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { BookingClient } from '../booking/client.js';
import { RequestGate, PRODUCTION_GATE_OPTIONS } from '../booking/gate.js';
import { DIRECT_USER_TOKEN_HEADER } from '../security/caller-auth.js';
import { productionTools } from '../tools/registry.js';
import {
  closeAllApps,
  postMcp,
  startApp,
  toolCallBody,
  type Harness,
} from './helpers/http-harness.js';

// Opt-in live flow of the client's own places (ROADMAP criterion 2, ME-04,
// ME-05, plan 04-04, D-03 and D-04). It drives the real app in process with
// CALLER_AUTH=optional and the direct X-Altegio-User-Token header (the shape
// the platform proxy sends headless) against the real Altegio API:
//
//   me_list_places -> me_list_bookings -> business_list_dates ->
//   business_list_time_slots -> book_check
//
// and ends at a verified, pre-selected booking link naming the usual team
// member and service. book_check creates no record and holds no slot, and no
// tool here writes, so nothing is booked; opening the link creates nothing
// until the client confirms in the widget.
//
// It runs only with ALTEGIO_E2E=1 and ALTEGIO_E2E_USER=1, through
//
//   ALTEGIO_E2E=1 ALTEGIO_E2E_USER=1 node --env-file=.env \
//     ./node_modules/jest/bin/jest.js --testPathPatterns=me-flow.live --runInBand
//
// which loads the partner token (ALTEGIO_API_TOKEN) and the user token
// (ALTEGIO_USER_TOKEN) from the local .env into this process only. The
// required CI job sets neither flag, so every test here reports as skipped
// there. All calls go through the production RequestGate, one at a time, and
// the run stays within MAX_UPSTREAM_CALLS, because developer 2630 is shared
// with marketplace confirmations (docs/runbooks/operations.md).
//
// The run prints two lines, `ME_FLOW_LINK <url>` (ids and a time, no names)
// and `ME_FLOW_SUMMARY <json>` (counts and the chosen ids, date and slot), and
// writes the same to loadtest-output/me-flow-run.json, which is git-ignored.
// No token, phone, name or code is printed or written. Each conditional step
// asserts its condition with a message naming what was missing, so a skipped
// test in a live run always means the gate was not applied.

const LIVE =
  process.env.ALTEGIO_E2E === '1' && process.env.ALTEGIO_E2E_USER === '1';
const describeLive = LIVE ? describe : describe.skip;

const MAX_UPSTREAM_CALLS = 12;
const LIVE_TIMEOUT_MS = 60_000;
const DEFAULT_API_BASE = 'https://api.alteg.io/api/v1';
/** Values that are not a real partner token: unset, .env.example, the unit-test token. */
const PLACEHOLDER_TOKENS: ReadonlySet<string> = new Set([
  '',
  'your_partner_token_here',
  'test-partner-token',
]);
/** Values that are not a real user token: unset, blank, .env.example. */
const PLACEHOLDER_USER_TOKENS: ReadonlySet<string> = new Set([
  '',
  'your_user_token_here',
]);
const OUTPUT_DIR = join(process.cwd(), 'loadtest-output');

type Structured = Record<string, unknown>;

/** Fails with a message that names the missing condition (never a token). */
function need(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

interface ToolAnswer {
  isError: boolean;
  structured: Structured;
}

interface Usual {
  service_ids: number[];
  team_member_id: number;
}

interface Place {
  location_id: number;
  online_booking: boolean;
  usual: Usual | null;
}

describeLive('live own-place flow (ALTEGIO_E2E=1, ALTEGIO_E2E_USER=1)', () => {
  let harness: Harness;
  let partnerToken = '';
  let userToken = '';
  /** Every upstream request URL, in order. */
  const requests: URL[] = [];
  /** Every tool answer as text, for the no-token scan. */
  const answerTexts: string[] = [];

  let placeCount = 0;
  let bookingCount = 0;
  let locationId = 0;
  let usual: Usual | null = null;
  let date = '';
  let datetime = '';
  let checkStatus = '';
  let linkKind = '';
  let linkUrl = '';

  beforeAll(async () => {
    // No message below carries a token value.
    partnerToken = process.env.ALTEGIO_API_TOKEN ?? '';
    if (PLACEHOLDER_TOKENS.has(partnerToken.trim())) {
      throw new Error(
        'ALTEGIO_API_TOKEN in .env must hold the partner token of developer account 2630; it is missing or a placeholder'
      );
    }
    userToken = process.env.ALTEGIO_USER_TOKEN ?? '';
    if (PLACEHOLDER_USER_TOKENS.has(userToken.trim())) {
      throw new Error(
        'ALTEGIO_USER_TOKEN in .env must hold the user token of a test client; it is missing, blank or a placeholder'
      );
    }

    const counting: typeof fetch = (input, init) => {
      requests.push(
        input instanceof URL
          ? input
          : new URL(typeof input === 'string' ? input : input.url)
      );
      return fetch(input, init);
    };
    harness = await startApp({
      tools: productionTools,
      toolDeps: {
        booking: new BookingClient({
          base: process.env.ALTEGIO_API_BASE ?? DEFAULT_API_BASE,
          token: partnerToken,
          fetch: counting,
          gate: new RequestGate({ ...PRODUCTION_GATE_OPTIONS }),
        }),
      },
      // As production: the partner token is a secret of the log scrubber; the
      // user token is scrubbed per request from the header that carried it.
      secrets: [partnerToken],
      callerAuth: {
        mode: 'optional',
        validator: {
          validate: () => Promise.resolve('valid' as const),
        },
      },
    });
  });

  afterAll(async () => {
    await closeAllApps();
  });

  /** One sequential tools/call with the direct user-token header. */
  async function call(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolAnswer> {
    const res = await postMcp(harness.baseUrl, toolCallBody(name, args), {
      [DIRECT_USER_TOKEN_HEADER]: userToken,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    answerTexts.push(text);
    const body = JSON.parse(text) as {
      result?: { isError?: boolean; structuredContent?: Structured };
    };
    return {
      isError: body.result?.isError === true,
      structured: body.result?.structuredContent ?? {},
    };
  }

  function itemsOf<T>(answer: ToolAnswer): T[] {
    const items = answer.structured.items;
    return Array.isArray(items) ? (items as T[]) : [];
  }

  it(
    'me_list_places lists the own places; the first one with online booking and a usual is picked',
    async () => {
      const answer = await call('me_list_places', {});
      expect(answer.isError).toBe(false);
      const places = itemsOf<Place>(answer);
      placeCount = places.length;
      need(
        places.length > 0,
        'me_list_places returned no place for this user token'
      );
      const place = places.find(
        (entry) => entry.online_booking && entry.usual !== null
      );
      need(
        place !== undefined,
        'no own place with online booking and a usual (a kept past visit with a service)'
      );
      locationId = place?.location_id ?? 0;
      usual = place?.usual ?? null;
      expect(usual?.service_ids.length ?? 0).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS
  );

  it(
    'me_list_bookings lists the own bookings',
    async () => {
      const answer = await call('me_list_bookings', {});
      expect(answer.isError).toBe(false);
      expect(Array.isArray(answer.structured.items)).toBe(true);
      bookingCount = itemsOf<unknown>(answer).length;
    },
    LIVE_TIMEOUT_MS
  );

  it(
    'business_list_dates with the usual has a free date; the first is picked',
    async () => {
      const chosen = usual;
      need(chosen !== null, 'no usual was picked by the first step');
      const answer = await call('business_list_dates', {
        location_id: locationId,
        service_ids: chosen?.service_ids,
        team_member_id: chosen?.team_member_id,
      });
      expect(answer.isError).toBe(false);
      const dates = itemsOf<{ date: string }>(answer);
      need(
        dates.length > 0,
        'no free date for the usual service and team member at the chosen place'
      );
      date = dates[0]?.date ?? '';
    },
    LIVE_TIMEOUT_MS
  );

  it(
    'business_list_time_slots on that date has a free slot; the first is picked',
    async () => {
      const chosen = usual;
      need(date !== '', 'no free date was picked by the previous step');
      const answer = await call('business_list_time_slots', {
        location_id: locationId,
        service_ids: chosen?.service_ids,
        team_member_id: chosen?.team_member_id,
        date,
      });
      expect(answer.isError).toBe(false);
      const slots = itemsOf<{ datetime: string }>(answer);
      need(
        slots.length > 0,
        'no free slot on the first free date for the usual service and team member'
      );
      datetime = slots[0]?.datetime ?? '';
    },
    LIVE_TIMEOUT_MS
  );

  it(
    'book_check verifies the slot and gives a pre-selected link naming the usual team member and service',
    async () => {
      const chosen = usual;
      need(datetime !== '', 'no free slot was picked by the previous step');
      const answer = await call('book_check', {
        location_id: locationId,
        service_ids: chosen?.service_ids,
        team_member_id: chosen?.team_member_id,
        datetime,
      });
      expect(answer.isError).toBe(false);
      const out = answer.structured as {
        status?: string;
        link?: { url?: string; kind?: string };
      };
      checkStatus = out.status ?? '';
      linkKind = out.link?.kind ?? '';
      linkUrl = out.link?.url ?? '';
      expect(checkStatus).toBe('verified');
      expect(linkKind).toBe('preselected');
      // `m-1` stands for any team member; the services follow as `s<id>`, every
      // service of the usual in order, and the time token `d` comes last.
      const staff =
        (chosen?.team_member_id ?? 0) === 0
          ? 'm-1'
          : `m${String(chosen?.team_member_id)}`;
      const services = (chosen?.service_ids ?? [])
        .map((id) => `s${String(id)}`)
        .join('');
      expect(linkUrl).toContain(`${staff}${services}d`);
    },
    LIVE_TIMEOUT_MS
  );

  it('no response text and no log line contains either token', () => {
    // Only a label is reported on failure, never a token.
    const texts = [...answerTexts, JSON.stringify(harness.logs)];
    const leaks: string[] = [];
    for (const [label, token] of [
      ['partner token', partnerToken],
      ['user token', userToken],
    ] as const) {
      if (texts.some((text) => text.includes(token))) leaks.push(label);
    }
    expect(leaks).toEqual([]);
  });

  it(`stays within ${MAX_UPSTREAM_CALLS} upstream calls and reports the run`, () => {
    expect(requests.length).toBeLessThanOrEqual(MAX_UPSTREAM_CALLS);
    const summary = {
      places: placeCount,
      bookings: bookingCount,
      location_id: locationId,
      service_ids: usual?.service_ids ?? [],
      team_member_id: usual?.team_member_id ?? null,
      date,
      slot: datetime,
      book_check_status: checkStatus,
      link_kind: linkKind,
      upstream_calls: requests.length,
    };
    process.stdout.write(`ME_FLOW_LINK ${linkUrl}\n`);
    process.stdout.write(`ME_FLOW_SUMMARY ${JSON.stringify(summary)}\n`);
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(
      join(OUTPUT_DIR, 'me-flow-run.json'),
      `${JSON.stringify(
        { run_at: new Date().toISOString(), link: linkUrl, ...summary },
        null,
        2
      )}\n`
    );
  });
});
