import { mkdirSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { ALTEGIO_ACCEPT } from '../http.js';
import {
  bookingUserDataSchema,
  bookRecordCreateDataSchema,
  datesDataSchema,
  teamMembersDataSchema,
  timeSlotsDataSchema,
  userRecordsDataSchema,
} from '../schemas.js';
import { scrubSecrets } from '../../observability/redact.js';
import {
  createRecordingFetch,
  sanitizeRecording,
  type RecordedHeaders,
  type RecordedRoute,
  type Recording,
} from './helpers/live-recorder.js';
import {
  commonSlots,
  createdRecordIds,
  createPairBody,
  describeError,
  emailOf,
  fullnameOf,
  normalizePhone,
  type ErrorRecord,
} from './helpers/write-run.js';

// Opt-in live probe of a two-appointment booking (CASE-01, plan 05-01, D-01,
// D-02): at the owner's own business it checks two appointments in one
// `book_check`, creates them in one `book_record` with `appointments[2]` on two
// DIFFERENT, explicit team members at ONE start, reads the records, cancels both
// and reads again. It settles whether the backend accepts one client holding two
// simultaneous online records (assumption A1) and what the answers look like.
// Only the owner runs it, in their own shell, because it reads the local env file:
//
//   ALTEGIO_E2E=1 ALTEGIO_E2E_USER=1 ALTEGIO_E2E_WRITE=1 ALTEGIO_E2E_PAIR=1 \
//     node --env-file=.env ./node_modules/jest/bin/jest.js \
//     --testPathPatterns=pair-booking.live --runInBand
//
// It needs all four flags and is skipped in the required CI job, where none is
// set. It books at location 726120 (ALTEGIO_E2E_PAIR_LOCATION overrides), service
// 13884511 (ALTEGIO_E2E_PAIR_SERVICE_ID), at least two days ahead, because that
// business lets a client cancel up to 2 hours before the start. The two team
// members are ALTEGIO_E2E_PAIR_TEAM_MEMBER_IDS ("A,B", two different positive
// ids), else the first two that are bookable online for the service. Steps, one
// `it` each, at most 16 upstream calls in all:
//
//   a. GET /booking/user/data: the client's name, +digits phone and e-mail, kept
//      in memory only (the e-mail is sent only when non-empty).
//   b. GET /book_staff/{loc}: the two team members. Fewer than two prints
//      `PAIR_SKIPPED no_two_team_members` and skips the rest.
//   c. GET /book_dates for A and for B, then GET /book_times for A and B on the
//      first common date (and at most the next one): the first slot both have.
//      None prints `PAIR_SKIPPED no_common_slot` and skips the rest.
//   d. POST /book_check with both appointments (partner token only): 201 expected.
//   e. POST /book_check with both appointments on A (validation only): 422 with
//      code 437 expected; a 201 is recorded, not a failure.
//   f. POST /book_record with createPairBody(...): 201 with two record ids
//      expected. A 412, or a 2xx without two positive record ids, prints
//      `PAIR_ABORTED <reason>` and fails the step; a 4xx keeps its error record.
//   g. GET /user/records: both ids present and not deleted, team members A and B,
//      one datetime; each record's clients_count.
//   h. DELETE /user/records/{id}/0 for each created id: 204 expected.
//   i. GET /user/records: both deleted.
//
// Cleanup rule: afterAll cancels every positive record id the create answered
// with that no cancel was attempted for (a failure before step h), and prints
// `PAIR_CLEANUP {"record_id":..,"status":..}` for each. A cancel that step h
// attempted and that failed is not repeated: it prints `PAIR_LEFT_BEHIND` with
// the id and status, and the owner cancels that booking by hand. Then it prints
// `PAIR_BOOKING_SUMMARY <json>`, built from an allow-list of ids, the slot,
// statuses, error codes, counts and booleans, and writes the same plus the
// sanitised create answer and the error records to
// loadtest-output/pair-booking-run.json (git-ignored). No token, hash, phone,
// name or e-mail is printed or written; the summary is withheld, with one line
// saying so, if it would hold one. The first failing step is named and every later
// step is skipped with one line. Lines are written with a synchronous write.
// Nothing about a second person is sent: no comment, no second name or phone.
// The suite calls no sign-in route (/user/auth, /book_code, /booking/yplaces).

const LIVE =
  process.env.ALTEGIO_E2E === '1' &&
  process.env.ALTEGIO_E2E_USER === '1' &&
  process.env.ALTEGIO_E2E_WRITE === '1' &&
  process.env.ALTEGIO_E2E_PAIR === '1';
const describeLive = LIVE ? describe : describe.skip;

const MAX_UPSTREAM_CALLS = 16;
const REQUEST_TIMEOUT_MS = 15_000;
const LIVE_TIMEOUT_MS = 60_000;
const DEFAULT_API_BASE = 'https://api.alteg.io/api/v1';
const DEFAULT_LOCATION = '726120';
const DEFAULT_SERVICE_ID = '13884511';
/** The hash segment of the cancel route; the user token is enough (settled in 04.1). */
const CANCEL_SEGMENT = '0';
/** First bookable day: this many days after today (UTC). */
const DAYS_AHEAD = 2;
/** How far past the first day the date search reaches. */
const SEARCH_DAYS = 14;
/** How many common dates are tried for a shared slot. */
const MAX_DATES_TRIED = 2;
const MS_PER_DAY = 86_400_000;
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
/** The only routes this suite may call, relative to the API base. */
const ALLOWED_PATHS: readonly RegExp[] = [
  /^\/booking\/user\/data$/,
  /^\/book_staff\/\d+$/,
  /^\/book_dates\/\d+$/,
  /^\/book_times\/\d+\/\d+\/\d{4}-\d{2}-\d{2}$/,
  /^\/book_check\/\d+$/,
  /^\/book_record\/\d+$/,
  /^\/user\/records(?:\/\d+\/[^/]+)?$/,
];
/** Routes no code of this project may call (SEC-02). */
const FORBIDDEN_PATHS: readonly RegExp[] = [
  /\/user\/auth(?:\/|$)/,
  /\/book_code(?:\/|$)/,
  /\/booking\/yplaces(?:\/|$)/,
];
const OUTPUT_DIR = join(process.cwd(), 'loadtest-output');

interface Answer {
  status: number;
  data: unknown;
}

/** One line to the terminal, written synchronously so the end of the run cannot drop it. */
function printLine(text: string): void {
  writeSync(1, `${text}\n`);
}

/** Fails with a message that names the missing condition (never a secret). */
function need(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/** A positive integer from an environment value, or `fallback` when unset. */
function positiveInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return fallback;
  need(/^\d+$/.test(raw), `${name} must be a non-negative integer`);
  return Number(raw);
}

/** "A,B" from an environment value: two different positive ids, else a failure naming the variable. */
function teamMemberPair(name: string): [number, number] | null {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return null;
  const parts = raw.split(',').map((part) => part.trim());
  const valid =
    parts.length === 2 &&
    parts.every((part) => /^[1-9]\d*$/.test(part)) &&
    parts[0] !== parts[1];
  need(valid, `${name} must be two different positive ids, as "A,B"`);
  return [Number(parts[0]), Number(parts[1])];
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

describeLive(
  'live two-appointment probe at an own place (ALTEGIO_E2E=1, ALTEGIO_E2E_USER=1, ALTEGIO_E2E_WRITE=1, ALTEGIO_E2E_PAIR=1)',
  () => {
    let base = DEFAULT_API_BASE;
    let partnerToken = '';
    let userToken = '';
    let recordingFetch: typeof fetch = fetch;
    /** Every upstream request URL, in order (in memory; never printed). */
    const requests: URL[] = [];
    const recordings: Recording[] = [];

    // Kept in the closure only, never printed or written.
    let fullname = '';
    let phone = '';
    let email = '';
    const hashes: string[] = [];
    /** The first failing step, the reason the rest is skipped, and the steps skipped. */
    let firstFailure: string | null = null;
    let skipReason: string | null = null;
    let abortReason: string | null = null;
    const skippedSteps: string[] = [];
    /** The sanitised record of every refused call, by step. */
    const errors: Record<string, ErrorRecord> = {};

    // The run, as the summary reports it.
    const locationId = positiveInt(
      'ALTEGIO_E2E_PAIR_LOCATION',
      Number(DEFAULT_LOCATION)
    );
    const serviceId = positiveInt(
      'ALTEGIO_E2E_PAIR_SERVICE_ID',
      Number(DEFAULT_SERVICE_ID)
    );
    let teamA = 0;
    let teamB = 0;
    let slot = '';
    let createStatus: number | null = null;
    let createdIds: number[] = [];
    let createdAnswer: unknown = null;
    let recordsSeen = 0;
    let bothPresent: boolean | null = null;
    let noneDeletedBefore: boolean | null = null;
    let staffMatch: boolean | null = null;
    let sameDatetime: boolean | null = null;
    let clientsCount: (number | null)[] = [];
    let deletedAfter: boolean[] = [];
    /** Record ids a cancel was attempted for in step h, with the status. */
    const cancelAttempts = new Map<number, number>();
    const cleanedUp: { record_id: number; status: number }[] = [];
    let checkPairStatus: number | null = null;
    let checkSameStatus: number | null = null;
    let checkSameCodes: number[] = [];
    let sameMemberDone = false;
    const statuses: Record<string, number | null> = {
      profile: null,
      staff: null,
      dates_first: null,
      dates_second: null,
      times_first: null,
      times_second: null,
      check_pair: null,
      check_same_member: null,
      create: null,
      records_after_create: null,
      cancel_first: null,
      cancel_second: null,
      records_after_cancel: null,
    };

    beforeAll(() => {
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
      base = process.env.ALTEGIO_API_BASE ?? DEFAULT_API_BASE;
      const pair = teamMemberPair('ALTEGIO_E2E_PAIR_TEAM_MEMBER_IDS');
      if (pair !== null) [teamA, teamB] = pair;

      const counting: typeof fetch = (input, init) => {
        requests.push(
          input instanceof URL
            ? input
            : new URL(typeof input === 'string' ? input : input.url)
        );
        return fetch(input, init);
      };
      recordingFetch = createRecordingFetch(
        counting,
        (recording) => {
          recordings.push(recording);
        },
        [partnerToken, userToken]
      );
    });

    /** Every value that must not appear in a record of a refused call. */
    function redactionValues(): string[] {
      return [
        partnerToken,
        userToken,
        phone,
        phone.replace(/^\+/, ''),
        fullname,
        email,
        ...hashes,
      ].filter((value) => value !== '');
    }

    /** Wraps a step: after a failure or a skip it only names itself; a failure is named once. */
    function step(
      name: string,
      body: () => Promise<void>
    ): () => Promise<void> {
      return async () => {
        if (firstFailure !== null || skipReason !== null) {
          skippedSteps.push(name);
          printLine(
            firstFailure !== null
              ? `PAIR_SKIPPED_STEP ${name}: step ${firstFailure} failed first`
              : `PAIR_SKIPPED_STEP ${name}: ${skipReason ?? ''}`
          );
          return;
        }
        try {
          await body();
        } catch (error) {
          firstFailure = name;
          printLine(`PAIR_FAILED ${name}`);
          throw error;
        }
      };
    }

    /** Skips every later step, with one line naming the reason. */
    function skipRest(reason: string): void {
      skipReason = reason;
      printLine(`PAIR_SKIPPED ${reason}`);
    }

    /**
     * One call. The partner token is always sent; the user token only when
     * `signedIn` is true (the checks present the partner token alone). A non-2xx
     * answer with an `errorKey` leaves its sanitised record under `errors.<errorKey>`.
     * The call cap is enforced here, before the request is made.
     */
    async function api(
      method: 'GET' | 'POST' | 'DELETE',
      path: string,
      options: {
        query?: string;
        body?: unknown;
        errorKey?: string;
        signedIn?: boolean;
      } = {}
    ): Promise<Answer> {
      need(
        requests.length < MAX_UPSTREAM_CALLS,
        `the cap of ${String(MAX_UPSTREAM_CALLS)} upstream calls is reached`
      );
      const hasBody = options.body !== undefined;
      const headers: Record<string, string> = {
        Accept: ALTEGIO_ACCEPT,
        Authorization:
          options.signedIn === false
            ? `Bearer ${partnerToken}`
            : `Bearer ${partnerToken}, User ${userToken}`,
      };
      if (hasBody) headers['Content-Type'] = 'application/json';
      const response = await recordingFetch(
        `${base}${path}${options.query ?? ''}`,
        {
          method,
          headers,
          body: hasBody ? JSON.stringify(options.body) : undefined,
          redirect: 'manual',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }
      );
      const text = await response.text();
      if (!isOk(response.status) && options.errorKey !== undefined) {
        errors[options.errorKey] = describeError(
          response.status,
          text,
          redactionValues()
        );
      }
      try {
        const envelope: unknown = JSON.parse(text);
        return {
          status: response.status,
          data: isRecord(envelope) ? (envelope.data ?? null) : null,
        };
      } catch {
        return { status: response.status, data: null };
      }
    }

    function serviceQuery(extra: string[] = []): string {
      return `?${[...extra, `service_ids[]=${String(serviceId)}`].join('&')}`;
    }

    /** The newest recording of a route, as the headers it captured. */
    function headersOf(route: RecordedRoute): RecordedHeaders | null {
      for (let index = recordings.length - 1; index >= 0; index -= 1) {
        const recording = recordings[index];
        if (recording?.route === route) return recording.headers ?? null;
      }
      return null;
    }

    /** The records of the client, parsed. */
    async function recordsList(): Promise<{
      status: number;
      records: Record<string, unknown>[];
    }> {
      const answer = await api('GET', '/user/records');
      expect(answer.status).toBe(200);
      const parsed = userRecordsDataSchema.safeParse(answer.data);
      need(parsed.success, 'GET /user/records did not parse as a record list');
      const records = (Array.isArray(answer.data) ? answer.data : []).filter(
        isRecord
      );
      return { status: answer.status, records };
    }

    /** The body of a book_check: the appointments at one slot on the given team members. */
    function checkBody(first: number, second: number): unknown {
      return {
        appointments: [
          { id: 1, services: [serviceId], staff_id: first, datetime: slot },
          { id: 2, services: [serviceId], staff_id: second, datetime: slot },
        ],
      };
    }

    /** The error codes of a refused check, from its sanitised record. */
    function codesOf(key: string): number[] {
      const refused = errors[key];
      if (refused === undefined) return [];
      const all = [
        ...(refused.code === null ? [] : [refused.code]),
        ...refused.errors.flatMap((entry) =>
          entry.code === null ? [] : [entry.code]
        ),
      ];
      return [...new Set(all)];
    }

    /** The same-member check, validation only; run once, by step e or by step d after a refusal. */
    async function checkSameMember(): Promise<void> {
      if (sameMemberDone) return;
      sameMemberDone = true;
      const answer = await api('POST', `/book_check/${String(locationId)}`, {
        body: checkBody(teamA, teamA),
        errorKey: 'check_same_member',
        signedIn: false,
      });
      statuses.check_same_member = answer.status;
      checkSameStatus = answer.status;
      checkSameCodes = codesOf('check_same_member');
    }

    /** One cancel of a created record; the status is kept under `which`. */
    async function cancelRecord(
      recordId: number,
      errorKey: string
    ): Promise<number> {
      const answer = await api(
        'DELETE',
        `/user/records/${String(recordId)}/${CANCEL_SEGMENT}`,
        { errorKey }
      );
      cancelAttempts.set(recordId, answer.status);
      return answer.status;
    }

    it(
      'GET /booking/user/data answers 200 with the name and the phone of the client',
      step('profile', async () => {
        const answer = await api('GET', '/booking/user/data');
        statuses.profile = answer.status;
        expect(answer.status).toBe(200);
        expect(bookingUserDataSchema.safeParse(answer.data).success).toBe(true);
        const profile = isRecord(answer.data) ? answer.data : {};
        fullname = fullnameOf(profile);
        phone = normalizePhone(
          typeof profile.phone === 'string' ? profile.phone.trim() : ''
        );
        email = emailOf(profile);
        need(fullname !== '', 'the profile has neither a fullname nor a name');
        need(phone !== '', 'the profile has no phone');
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'two team members who take the service online are chosen at the location',
      step('team_members', async () => {
        const answer = await api('GET', `/book_staff/${String(locationId)}`, {
          query: serviceQuery(),
        });
        statuses.staff = answer.status;
        expect(answer.status).toBe(200);
        const parsed = teamMembersDataSchema.safeParse(answer.data);
        need(parsed.success, 'GET /book_staff did not parse');
        const bookable = (parsed.success ? parsed.data : [])
          .filter((member) => member.bookable === true || member.bookable === 1)
          .map((member) => member.id);
        if (teamA > 0 && teamB > 0) {
          if (!bookable.includes(teamA) || !bookable.includes(teamB)) {
            skipRest('no_two_team_members');
          }
          return;
        }
        if (bookable.length < 2) {
          skipRest('no_two_team_members');
          return;
        }
        teamA = bookable[0] ?? 0;
        teamB = bookable[1] ?? 0;
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'a slot both team members have, at least two days ahead, is found',
      step('slot', async () => {
        const from = daysFromNow(DAYS_AHEAD);
        const datesOf = async (
          teamMemberId: number,
          key: 'dates_first' | 'dates_second'
        ): Promise<string[]> => {
          const answer = await api('GET', `/book_dates/${String(locationId)}`, {
            query: serviceQuery([
              `staff_id=${String(teamMemberId)}`,
              `date_from=${from}`,
              `date_to=${daysFromNow(DAYS_AHEAD + SEARCH_DAYS)}`,
            ]),
          });
          statuses[key] = answer.status;
          expect(answer.status).toBe(200);
          const parsed = datesDataSchema.safeParse(answer.data);
          need(parsed.success, 'GET /book_dates did not parse');
          return (parsed.success ? parsed.data.booking_dates : []).filter(
            (day) => day >= from
          );
        };
        const first = await datesOf(teamA, 'dates_first');
        const second = await datesOf(teamB, 'dates_second');
        const days = commonSlots(first.sort(), second.sort()).slice(
          0,
          MAX_DATES_TRIED
        );

        const slotsOf = async (
          teamMemberId: number,
          day: string,
          key: 'times_first' | 'times_second'
        ): Promise<string[]> => {
          const answer = await api(
            'GET',
            `/book_times/${String(locationId)}/${String(teamMemberId)}/${day}`,
            { query: serviceQuery() }
          );
          statuses[key] = answer.status;
          expect(answer.status).toBe(200);
          const parsed = timeSlotsDataSchema.safeParse(answer.data);
          need(parsed.success, 'GET /book_times did not parse');
          return (parsed.success ? parsed.data : []).map(
            (entry) => entry.datetime
          );
        };
        for (const day of days) {
          const shared = commonSlots(
            await slotsOf(teamA, day, 'times_first'),
            await slotsOf(teamB, day, 'times_second')
          );
          if (shared.length > 0) {
            slot = shared[0] ?? '';
            return;
          }
        }
        skipRest('no_common_slot');
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'POST /book_check accepts the two appointments with two different team members',
      step('check_pair', async () => {
        need(slot !== '', 'no slot was found by the previous step');
        const answer = await api('POST', `/book_check/${String(locationId)}`, {
          body: checkBody(teamA, teamB),
          errorKey: 'check_pair',
          signedIn: false,
        });
        statuses.check_pair = answer.status;
        checkPairStatus = answer.status;
        if (answer.status !== 201) {
          // The refusal is the finding; the diagnostic check still runs once.
          await checkSameMember();
        }
        expect(answer.status).toBe(201);
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'POST /book_check with the same team member twice is refused as overlapping (validation only)',
      step('check_same_member', async () => {
        need(slot !== '', 'no slot was found by an earlier step');
        await checkSameMember();
        // A 201 here is recorded in the summary, not a failure of the probe.
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'POST /book_record creates both bookings in one call and answers 201 with two record ids',
      step('create', async () => {
        need(slot !== '', 'no slot was found by an earlier step');
        need(fullname !== '' && phone !== '', 'no profile was read');
        const body = createPairBody({
          phone,
          fullname,
          email,
          first: { serviceIds: [serviceId], staffId: teamA },
          second: { serviceIds: [serviceId], staffId: teamB },
          datetime: slot,
        });
        const answer = await api('POST', `/book_record/${String(locationId)}`, {
          body,
          errorKey: 'create',
        });
        statuses.create = answer.status;
        createStatus = answer.status;
        const entries = Array.isArray(answer.data)
          ? (answer.data as unknown[]).filter(isRecord)
          : [];
        for (const entry of entries) {
          if (typeof entry.record_hash === 'string') {
            hashes.push(entry.record_hash);
          }
        }
        // Every positive record id the answer holds is cancelled in this run.
        createdIds = entries.flatMap((entry) =>
          typeof entry.record_id === 'number' &&
          Number.isSafeInteger(entry.record_id) &&
          entry.record_id > 0
            ? [entry.record_id]
            : []
        );
        if (isOk(answer.status)) {
          createdAnswer = sanitizeRecording(
            'book_record_create',
            answer.data,
            redactionValues()
          );
        }
        const parsed = bookRecordCreateDataSchema.safeParse(answer.data);
        const ids = createdRecordIds(parsed.success ? parsed.data : null);
        if (answer.status === 412) {
          abortReason = 'anti_fraud_412';
          printLine(`PAIR_ABORTED ${abortReason}`);
        } else if (
          isOk(answer.status) &&
          (ids.first === null || ids.second === null)
        ) {
          abortReason = 'create_without_two_record_ids';
          printLine(`PAIR_ABORTED ${abortReason}`);
        }
        need(
          abortReason === null,
          `book_record aborted the probe: ${abortReason ?? ''}`
        );
        need(
          answer.status === 201,
          `book_record answered ${String(answer.status)}: see PAIR_BOOKING_SUMMARY`
        );
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'GET /user/records shows both records, on the two team members, at one start',
      step('records_after_create', async () => {
        need(createdIds.length === 2, 'two bookings were not created');
        const { status, records } = await recordsList();
        statuses.records_after_create = status;
        const mine = createdIds.map((id) =>
          records.find((record) => record.id === id)
        );
        recordsSeen = mine.filter((record) => record !== undefined).length;
        bothPresent = recordsSeen === 2;
        noneDeletedBefore = mine.every(
          (record) => record?.deleted !== true && record?.deleted !== 1
        );
        const staffIds = mine.map((record) =>
          isRecord(record?.staff) ? record.staff.id : null
        );
        staffMatch = staffIds[0] === teamA && staffIds[1] === teamB;
        sameDatetime =
          typeof mine[0]?.datetime === 'string' &&
          mine[0].datetime === mine[1]?.datetime;
        clientsCount = mine.map((record) =>
          typeof record?.clients_count === 'number'
            ? record.clients_count
            : null
        );
        need(bothPresent, 'both records are not in GET /user/records');
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'DELETE /user/records cancels both bookings',
      step('cancel', async () => {
        need(createdIds.length === 2, 'two bookings were not created');
        const [first, second] = createdIds;
        statuses.cancel_first = await cancelRecord(first ?? 0, 'cancel_first');
        statuses.cancel_second = await cancelRecord(
          second ?? 0,
          'cancel_second'
        );
        expect([statuses.cancel_first, statuses.cancel_second]).toEqual([
          204, 204,
        ]);
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'GET /user/records shows both records cancelled',
      step('records_after_cancel', async () => {
        need(createdIds.length === 2, 'two bookings were not created');
        const { status, records } = await recordsList();
        statuses.records_after_cancel = status;
        deletedAfter = createdIds.map((id) => {
          const deleted = records.find((record) => record.id === id)?.deleted;
          return deleted === true || deleted === 1;
        });
        need(
          deletedAfter.length === 2 && deletedAfter.every(Boolean),
          'both records are not shown as cancelled'
        );
      }),
      LIVE_TIMEOUT_MS
    );

    it(`stays within ${String(MAX_UPSTREAM_CALLS)} upstream calls and calls no route outside its allow-list`, () => {
      expect(requests.length).toBeLessThanOrEqual(MAX_UPSTREAM_CALLS);
      const basePath = new URL(base).pathname.replace(/\/$/, '');
      const outside = requests.filter((url) => {
        const path = url.pathname.startsWith(basePath)
          ? url.pathname.slice(basePath.length)
          : url.pathname;
        return !ALLOWED_PATHS.some((pattern) => pattern.test(path));
      });
      const signIn = requests.filter((url) =>
        FORBIDDEN_PATHS.some((pattern) => pattern.test(url.pathname))
      );
      // Counts only: a record path holds a record id.
      expect({ outside: outside.length, sign_in: signIn.length }).toEqual({
        outside: 0,
        sign_in: 0,
      });
    });

    afterAll(async () => {
      // A created record no cancel was attempted for is cancelled now. A cancel
      // that step h attempted and that failed is reported, not repeated.
      for (const id of createdIds) {
        const attempted = cancelAttempts.get(id);
        if (attempted === undefined) {
          const status = await cancelRecord(id, `cleanup_${String(id)}`).catch(
            () => 0
          );
          cleanedUp.push({ record_id: id, status });
          printLine(
            `PAIR_CLEANUP ${JSON.stringify({ record_id: id, status })}`
          );
        } else if (!isOk(attempted)) {
          printLine(
            `PAIR_LEFT_BEHIND ${JSON.stringify({ record_id: id, status: attempted })}`
          );
        }
      }
      // Printed here, not at the end of the last step, so an aborted run still
      // reports what it saw.
      const summary = {
        location_id: locationId,
        service_id: serviceId,
        team_member_ids: [teamA, teamB],
        slot,
        statuses,
        check_pair_status: checkPairStatus,
        check_same_member_status: checkSameStatus,
        check_same_member_codes: checkSameCodes,
        create_status: createStatus,
        error_codes: Object.fromEntries(
          Object.entries(errors).map(([key, record]) => [
            key,
            codesOf(key).length > 0 ? codesOf(key) : [record.status],
          ])
        ),
        record_ids: createdIds,
        record_ids_present: createdIds.length,
        records_seen: recordsSeen,
        both_present: bothPresent,
        none_deleted_before_cancel: noneDeletedBefore,
        staff_match: staffMatch,
        same_datetime: sameDatetime,
        clients_count: clientsCount,
        cancel_statuses: [...cancelAttempts.values()],
        deleted_after_cancel: deletedAfter,
        cleanup: cleanedUp,
        headers: headersOf('book_record_create')?.security ?? null,
        upstream_calls: requests.length,
        first_failing_step: firstFailure,
        skipped_reason: skipReason,
        skipped_steps: skippedSteps,
        aborted: abortReason,
      };
      const text = JSON.stringify(summary);
      const full = JSON.stringify({
        ...summary,
        create_answer: createdAnswer,
        errors,
      });
      // scrubSecrets ignores values under 8 characters, so a short name and the
      // bare digits of the phone are checked directly as well.
      const secrets = [
        partnerToken,
        userToken,
        phone,
        fullname,
        email,
        ...hashes,
      ];
      const direct = [
        phone.replace(/^\+/, ''),
        fullname,
        email,
        ...hashes,
      ].filter((value) => value.length >= 4);
      const holdsSecret = (candidate: string): boolean =>
        scrubSecrets(candidate, secrets) !== candidate ||
        direct.some((value) => candidate.includes(value));
      if (holdsSecret(text) || holdsSecret(full)) {
        printLine('PAIR_BOOKING_SUMMARY withheld: it would hold a secret');
        return;
      }
      printLine(`PAIR_BOOKING_SUMMARY ${text}`);
      mkdirSync(OUTPUT_DIR, { recursive: true });
      writeFileSync(
        join(OUTPUT_DIR, 'pair-booking-run.json'),
        `${JSON.stringify(
          {
            run_at: new Date().toISOString(),
            ...summary,
            create_answer: createdAnswer,
            errors,
          },
          null,
          2
        )}\n`
      );
    });
  }
);
