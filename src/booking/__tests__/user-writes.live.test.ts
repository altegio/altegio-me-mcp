import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { ALTEGIO_ACCEPT } from '../http.js';
import {
  bookingUserDataSchema,
  bookRecordCreateDataSchema,
  datesDataSchema,
  servicesDataSchema,
  timeSlotsDataSchema,
  userRecordsDataSchema,
} from '../schemas.js';
import { scrubSecrets } from '../../observability/redact.js';
import {
  createRecordingFetch,
  WRITE_SIDE_ROUTES,
  type RecordedHeaders,
  type RecordedRoute,
  type Recording,
} from './helpers/live-recorder.js';
import {
  createBody,
  describeError,
  emailOf,
  fullnameOf,
  normalizePhone,
  type ErrorRecord,
} from './helpers/write-run.js';

// Opt-in live suite of the write-side routes (ME-09, plan 04.1-01, D-02, D-05):
// it creates ONE real booking at the owner's own business, moves it once and
// cancels it, and records the four routes' contract (GET /booking/user/data,
// POST /book_record/{loc}, PUT /book_record/{loc}/{record_id}, DELETE
// /user/records/{record_id}/{hash}) together with the anti-fraud signals of the
// create. Only the owner runs it, in their own shell, because it reads the
// local env file:
//
//   ALTEGIO_E2E=1 ALTEGIO_E2E_USER=1 ALTEGIO_E2E_WRITE=1 ALTEGIO_E2E_RECORD=1 \
//     node --env-file=.env ./node_modules/jest/bin/jest.js \
//     --testPathPatterns=user-writes.live --runInBand
//
// It needs all three flags and is skipped in the required CI job, where none
// is set. It books at location 726120 (ALTEGIO_E2E_WRITE_LOCATION overrides),
// at least two days ahead, because that business lets a client cancel up to 2
// hours before. Steps, one `it` each:
//
//   a. GET /booking/user/data: the client's name and phone, kept in memory only.
//      The profile gives the phone as bare digits; the create route wants a
//      plus and digits (error 431 otherwise), so it is sent as +<digits>. The
//      name is the profile's fullname, else name and surname. The e-mail is
//      the profile's when it is non-empty: some businesses' booking forms
//      require one even for a signed-in client ("The required parameter email
//      was not passed", HTTP 422), and the key is never sent empty.
//   b. The service: ALTEGIO_E2E_WRITE_SERVICE_ID, else the first service of
//      GET /book_services/{loc} without prepayment and membership (it is NOT
//      taken from the client's usual: 726120 may hold no record of theirs).
//   c. GET /book_dates and GET /book_times: two free slots that do not overlap
//      (the second at or after the end of the first, else the next date).
//   d. POST /book_record with exactly { phone, fullname, [email,] appointments }.
//   e. GET /user/records: the new record is there; the creation hash is compared
//      with its `token` and `record_token` in memory, only two booleans are kept.
//   f. PUT /book_record/{loc}/{record_id} with exactly { datetime }.
//   g. DELETE /user/records/{record_id}/{segment}: the hash segment is settled in
//      a fixed order. First a placeholder ('0'); only when that is refused, the
//      field of the records list that equals the creation hash; only when none
//      equals, the creation hash itself. The summary names which was accepted.
//   h. GET /user/records: the record shows deleted.
//
// afterAll cancels a booking that was created and not seen cancelled, with the
// creation hash, and prints `USER_WRITES_CLEANUP {"record_id":..,"status":..}`;
// then it prints `USER_WRITES_SUMMARY <json>`, built from an allow-list of ids,
// times, statuses, booleans and header names, and writes the same to
// loadtest-output/user-writes-run.json (git-ignored). No token, hash, phone or
// name is printed, written to a summary, or part of a failure message. With
// ALTEGIO_E2E_RECORD=1 the sanitised 2xx answers of the four write-side routes
// are written to fixtures/live/, and the token-scan test fails, naming only the
// file, when a recording holds a token, the hash, the phone or the name.
// The first failing step is named and every later step is skipped with one line
// (`USER_WRITES_SKIPPED <step>`), so a failure is not buried in a cascade. A
// refused write (any non-2xx of create, move or cancel) leaves its status, its
// API error code and its `meta.message` / `meta.errors` (a list, or an object
// keyed by field, recorded per field), with the phone, name, hash, tokens,
// e-mails and phone-like numbers removed, under `errors.<step>` of the summary. Lines are written with a synchronous write, so none is lost when
// the run ends.
// The suite calls no sign-in route (/user/auth, /book_code, /booking/yplaces).

const LIVE =
  process.env.ALTEGIO_E2E === '1' &&
  process.env.ALTEGIO_E2E_USER === '1' &&
  process.env.ALTEGIO_E2E_WRITE === '1';
const RECORD = process.env.ALTEGIO_E2E_RECORD === '1';
const describeLive = LIVE ? describe : describe.skip;

const MAX_UPSTREAM_CALLS = 14;
const REQUEST_TIMEOUT_MS = 15_000;
const LIVE_TIMEOUT_MS = 60_000;
const DEFAULT_API_BASE = 'https://api.alteg.io/api/v1';
const DEFAULT_LOCATION = '726120';
/** The first hash segment tried on the cancel route; the user token should make it enough. */
const PLACEHOLDER_HASH_SEGMENT = '0';
/** First bookable day: this many days after today (UTC). */
const DAYS_AHEAD = 2;
/** How far past the first day the date search reaches. */
const SEARCH_DAYS = 14;
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
  /^\/book_services\/\d+$/,
  /^\/book_dates\/\d+$/,
  /^\/book_times\/\d+\/\d+\/\d{4}-\d{2}-\d{2}$/,
  /^\/book_record\/\d+(?:\/\d+)?$/,
  /^\/user\/records(?:\/\d+\/[^/]+)?$/,
];
/** Routes no code of this project may call (SEC-02). */
const FORBIDDEN_PATHS: readonly RegExp[] = [
  /\/user\/auth(?:\/|$)/,
  /\/book_code(?:\/|$)/,
  /\/booking\/yplaces(?:\/|$)/,
];
const LIVE_DIR = join(
  process.cwd(),
  'src',
  'booking',
  '__tests__',
  'fixtures',
  'live'
);
const OUTPUT_DIR = join(process.cwd(), 'loadtest-output');

type HashAnswer =
  | 'placeholder'
  | 'records_token'
  | 'records_record_token'
  | 'creation_hash_only'
  | 'none_accepted'
  | 'not_run';

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

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

describeLive(
  'live writes at an own place (ALTEGIO_E2E=1, ALTEGIO_E2E_USER=1, ALTEGIO_E2E_WRITE=1)',
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
    let creationHash = '';
    let profilePhoneHadPlus: boolean | null = null;
    let fullnameWords = 0;
    /** The first failing step, and the steps skipped after it. */
    let firstFailure: string | null = null;
    const skippedSteps: string[] = [];
    /** The sanitised record of every refused call, by step. */
    const errors: Record<string, ErrorRecord> = {};

    // The run, as the summary reports it.
    const locationId = positiveInt(
      'ALTEGIO_E2E_WRITE_LOCATION',
      Number(DEFAULT_LOCATION)
    );
    let serviceId = 0;
    let teamMemberId = 0;
    let slot1 = '';
    let slot2 = '';
    let recordId = 0;
    let recordIdPresent = false;
    let cancelSeen = false;
    let hashIsToken: boolean | null = null;
    let hashIsRecordToken: boolean | null = null;
    let matchingField: 'token' | 'record_token' | null = null;
    let hashAnswer: HashAnswer = 'not_run';
    const statuses: Record<string, number | null> = {
      profile: null,
      services: null,
      dates: null,
      times: null,
      create: null,
      records_after_create: null,
      move: null,
      cancel_placeholder: null,
      cancel_records_field: null,
      cancel_creation_hash: null,
      records_after_cancel: null,
      cleanup: null,
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
      serviceId = positiveInt('ALTEGIO_E2E_WRITE_SERVICE_ID', 0);
      teamMemberId = positiveInt('ALTEGIO_E2E_WRITE_TEAM_MEMBER_ID', 0);

      const counting: typeof fetch = (input, init) => {
        requests.push(
          input instanceof URL
            ? input
            : new URL(typeof input === 'string' ? input : input.url)
        );
        return fetch(input, init);
      };
      const sink = (recording: Recording): void => {
        recordings.push(recording);
        const writeSide = (WRITE_SIDE_ROUTES as readonly string[]).includes(
          recording.route
        );
        if (RECORD && writeSide && isOk(recording.status)) {
          mkdirSync(LIVE_DIR, { recursive: true });
          writeFileSync(
            join(LIVE_DIR, `${recording.route}.json`),
            `${JSON.stringify(recording, null, 2)}\n`
          );
        }
      };
      recordingFetch = createRecordingFetch(counting, sink, [
        partnerToken,
        userToken,
      ]);
    });

    /** Every value that must not appear in a record of a refused call. */
    function redactionValues(): string[] {
      return [
        partnerToken,
        userToken,
        creationHash,
        phone,
        phone.replace(/^\+/, ''),
        fullname,
        email,
      ].filter((value) => value !== '');
    }

    /** The error code and the field names of a refused create (labels only, no message text). */
    function createDetail(): string {
      const refused = errors.create;
      if (refused === undefined) return '';
      const parts: string[] = [];
      if (refused.code !== null)
        parts.push(`error code ${String(refused.code)}`);
      const names = Object.keys(refused.fields);
      if (names.length > 0) parts.push(`fields ${names.join(', ')}`);
      return parts.length === 0 ? '' : ` (${parts.join('; ')})`;
    }

    /** Wraps a step: after a failure it only names itself; a failure is named once. */
    function step(
      name: string,
      body: () => Promise<void>
    ): () => Promise<void> {
      return async () => {
        if (firstFailure !== null) {
          skippedSteps.push(name);
          printLine(
            `USER_WRITES_SKIPPED ${name}: step ${firstFailure} failed first`
          );
          return;
        }
        try {
          await body();
        } catch (error) {
          firstFailure = name;
          printLine(`USER_WRITES_FAILED ${name}`);
          throw error;
        }
      };
    }

    /**
     * One call with both tokens in the Authorization header; the envelope data
     * is parsed. A non-2xx answer with an `errorKey` leaves its sanitised
     * record under `errors.<errorKey>`.
     */
    async function api(
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      path: string,
      options: { query?: string; body?: unknown; errorKey?: string } = {}
    ): Promise<Answer> {
      const hasBody = options.body !== undefined;
      const headers: Record<string, string> = {
        Accept: ALTEGIO_ACCEPT,
        Authorization: `Bearer ${partnerToken}, User ${userToken}`,
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
      const parts = [...extra, `service_ids[]=${String(serviceId)}`];
      return `?${parts.join('&')}`;
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

    /** One DELETE of the cancel route with a given hash segment. */
    async function cancelWith(
      segment: string,
      errorKey: string
    ): Promise<number> {
      const answer = await api(
        'DELETE',
        `/user/records/${String(recordId)}/${encodeURIComponent(segment)}`,
        { errorKey }
      );
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
        fullnameWords = fullname === '' ? 0 : fullname.split(/\s+/).length;
        const rawPhone =
          typeof profile.phone === 'string' ? profile.phone.trim() : '';
        profilePhoneHadPlus = rawPhone.startsWith('+');
        phone = normalizePhone(rawPhone);
        email = emailOf(profile);
        need(fullname !== '', 'the profile has neither a fullname nor a name');
        need(phone !== '', 'the profile has no phone');
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'a service without prepayment is chosen at the location',
      step('service', async () => {
        if (serviceId > 0) return;
        const answer = await api('GET', `/book_services/${String(locationId)}`);
        statuses.services = answer.status;
        expect(answer.status).toBe(200);
        const parsed = servicesDataSchema.safeParse(answer.data);
        need(parsed.success, 'GET /book_services did not parse');
        const services = parsed.success ? parsed.data.services : [];
        const service = services.find((entry) => {
          const restriction = (entry as Record<string, unknown>)
            .abonement_restriction;
          const free = restriction === undefined || restriction === 0;
          return (
            entry.prepaid === 'forbidden' &&
            free &&
            entry.active !== 0 &&
            entry.active !== false
          );
        });
        need(
          service !== undefined,
          'no service without prepayment and membership at the location'
        );
        serviceId = service?.id ?? 0;
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'two free, non-overlapping slots at least two days ahead are found',
      step('slots', async () => {
        need(serviceId > 0, 'no service was chosen by the previous step');
        const from = daysFromNow(DAYS_AHEAD);
        const dates = await api('GET', `/book_dates/${String(locationId)}`, {
          query: `?${[
            ...(teamMemberId > 0 ? [`staff_id=${String(teamMemberId)}`] : []),
            `date_from=${from}`,
            `date_to=${daysFromNow(DAYS_AHEAD + SEARCH_DAYS)}`,
            `service_ids[]=${String(serviceId)}`,
          ].join('&')}`,
        });
        statuses.dates = dates.status;
        expect(dates.status).toBe(200);
        const parsedDates = datesDataSchema.safeParse(dates.data);
        need(parsedDates.success, 'GET /book_dates did not parse');
        const days = (parsedDates.success ? parsedDates.data.booking_dates : [])
          .filter((day) => day >= from)
          .sort();
        need(days.length > 0, 'no free date at least two days ahead');

        async function slotsOn(day: string) {
          const answer = await api(
            'GET',
            `/book_times/${String(locationId)}/${String(teamMemberId)}/${day}`,
            { query: serviceQuery() }
          );
          statuses.times = answer.status;
          expect(answer.status).toBe(200);
          const parsed = timeSlotsDataSchema.safeParse(answer.data);
          need(parsed.success, 'GET /book_times did not parse');
          return parsed.success ? parsed.data : [];
        }

        const first = await slotsOn(days[0] ?? '');
        need(first.length > 0, 'no free slot on the first free date');
        const one = first[0];
        slot1 = one?.datetime ?? '';
        const endOfFirst =
          Date.parse(slot1) +
          (Number(one?.sum_length ?? one?.seance_length ?? 0) || 0) * 1000;
        const later = first.find(
          (slot) => Date.parse(slot.datetime) >= endOfFirst
        );
        if (later !== undefined) {
          slot2 = later.datetime;
        } else {
          need(days.length > 1, 'only one free date, with no second slot');
          const next = await slotsOn(days[1] ?? '');
          need(next.length > 0, 'no free slot on the second free date');
          slot2 = next[0]?.datetime ?? '';
        }
        need(slot1 !== '' && slot2 !== '', 'two slots were not found');
        need(slot1 !== slot2, 'the two slots are the same');
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'POST /book_record creates one booking and answers 201 with a record id',
      step('create', async () => {
        need(slot1 !== '', 'no slot was found by the previous step');
        need(fullname !== '' && phone !== '', 'no profile was read');
        const answer = await api('POST', `/book_record/${String(locationId)}`, {
          errorKey: 'create',
          body: createBody({
            phone,
            fullname,
            email,
            serviceId,
            staffId: teamMemberId,
            datetime: slot1,
          }),
        });
        statuses.create = answer.status;
        const parsed = bookRecordCreateDataSchema.safeParse(answer.data);
        const entry =
          parsed.success && parsed.data.length > 0 ? parsed.data[0] : undefined;
        const id = entry?.record_id;
        recordIdPresent = typeof id === 'number' && id > 0;
        if (recordIdPresent) recordId = id ?? 0;
        const hash = entry?.record_hash;
        creationHash = typeof hash === 'string' ? hash : '';
        need(
          answer.status === 201 && recordIdPresent,
          `book_record answered ${String(answer.status)}${createDetail()} without a record id: see USER_WRITES_SUMMARY`
        );
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'GET /user/records shows the new record; the creation hash is compared in memory',
      step('records_after_create', async () => {
        need(recordId > 0, 'no booking was created by the previous step');
        const { status, records } = await recordsList();
        statuses.records_after_create = status;
        const entry = records.find((record) => record.id === recordId);
        need(entry !== undefined, 'the new record is not in GET /user/records');
        const known = creationHash !== '';
        hashIsToken = known && entry?.token === creationHash;
        hashIsRecordToken = known && entry?.record_token === creationHash;
        matchingField = hashIsToken
          ? 'token'
          : hashIsRecordToken
            ? 'record_token'
            : null;
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'PUT /book_record moves the booking to the second slot',
      step('move', async () => {
        need(recordId > 0, 'no booking was created by an earlier step');
        const answer = await api(
          'PUT',
          `/book_record/${String(locationId)}/${String(recordId)}`,
          { errorKey: 'move', body: { datetime: slot2 } }
        );
        statuses.move = answer.status;
        expect(answer.status).toBe(200);
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'DELETE /user/records cancels the booking: placeholder first, then the records field, then the creation hash',
      step('cancel', async () => {
        need(recordId > 0, 'no booking was created by an earlier step');
        statuses.cancel_placeholder = await cancelWith(
          PLACEHOLDER_HASH_SEGMENT,
          'cancel_placeholder'
        );
        if (isOk(statuses.cancel_placeholder)) {
          hashAnswer = 'placeholder';
        } else if (matchingField !== null) {
          // The field equals the creation hash, so one attempt covers both.
          statuses.cancel_records_field = await cancelWith(
            creationHash,
            'cancel_records_field'
          );
          if (isOk(statuses.cancel_records_field)) {
            hashAnswer =
              matchingField === 'token'
                ? 'records_token'
                : 'records_record_token';
          } else {
            hashAnswer = 'none_accepted';
          }
        } else {
          need(
            creationHash !== '',
            'the create answer held no hash to fall back to'
          );
          statuses.cancel_creation_hash = await cancelWith(
            creationHash,
            'cancel_creation_hash'
          );
          hashAnswer = isOk(statuses.cancel_creation_hash)
            ? 'creation_hash_only'
            : 'none_accepted';
        }
        expect(hashAnswer).not.toBe('none_accepted');
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'GET /user/records shows the record cancelled',
      step('records_after_cancel', async () => {
        need(recordId > 0, 'no booking was created by an earlier step');
        const { status, records } = await recordsList();
        statuses.records_after_cancel = status;
        const entry = records.find((record) => record.id === recordId);
        need(entry !== undefined, 'the record is not in GET /user/records');
        const deleted = entry?.deleted;
        cancelSeen = deleted === true || deleted === 1;
        need(cancelSeen, 'the record is not shown as cancelled');
      }),
      LIVE_TIMEOUT_MS
    );

    it('the recordings on disk hold no token, hash, phone or name', () => {
      // Only the file name and a label are reported, never a value.
      const secrets = [
        partnerToken,
        userToken,
        creationHash,
        phone,
        fullname,
        email,
      ];
      const problems: string[] = [];
      for (const route of WRITE_SIDE_ROUTES) {
        const file = join(LIVE_DIR, `${route}.json`);
        if (!existsSync(file)) continue;
        const text = readFileSync(file, 'utf8');
        if (scrubSecrets(text, secrets) !== text) {
          problems.push(`${route}.json: secret`);
        }
      }
      expect(problems).toEqual([]);
    });

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
      // Counts only: a path of the cancel route holds a hash segment.
      expect({ outside: outside.length, sign_in: signIn.length }).toEqual({
        outside: 0,
        sign_in: 0,
      });
    });

    afterAll(async () => {
      // A booking that was created and not seen cancelled is cancelled again.
      if (recordId > 0 && !cancelSeen && creationHash !== '') {
        try {
          statuses.cleanup = await cancelWith(creationHash, 'cleanup');
        } catch {
          statuses.cleanup = 0;
        }
        printLine(
          `USER_WRITES_CLEANUP ${JSON.stringify({
            record_id: recordId,
            status: statuses.cleanup,
          })}`
        );
      }
      // Printed here, not at the end of the last step, so an aborted run
      // still reports what it saw.
      const summary = {
        location_id: locationId,
        service_id: serviceId,
        team_member_id: teamMemberId,
        slot_1: slot1,
        slot_2: slot2,
        first_failure: firstFailure,
        skipped_steps: skippedSteps,
        statuses,
        errors,
        record_id_present: recordIdPresent,
        cancel_seen: cancelSeen,
        phone_sent: {
          profile_phone_had_plus: profilePhoneHadPlus,
          digits: phone === '' ? 0 : phone.length - 1,
        },
        fullname_words: fullnameWords,
        email_sent: email !== '',
        headers: Object.fromEntries(
          WRITE_SIDE_ROUTES.filter((route) => route !== 'booking_user_data')
            .map((route) => [route, headersOf(route)] as const)
            .filter(([, headers]) => headers !== null)
        ),
        hash_answer: hashAnswer,
        hash_is_token: hashIsToken,
        hash_is_record_token: hashIsRecordToken,
        upstream_calls: requests.length,
      };
      const text = JSON.stringify(summary);
      // scrubSecrets ignores values under 8 characters, so a short name and the
      // bare digits of the phone are checked directly as well.
      const secrets = [
        partnerToken,
        userToken,
        creationHash,
        phone,
        fullname,
        email,
      ];
      const direct = [
        phone.replace(/^\+/, ''),
        fullname,
        email,
        creationHash,
      ].filter((value) => value.length >= 4);
      if (
        scrubSecrets(text, secrets) !== text ||
        direct.some((value) => text.includes(value))
      ) {
        printLine('USER_WRITES_SUMMARY withheld: it would hold a secret');
        return;
      }
      printLine(`USER_WRITES_SUMMARY ${text}`);
      mkdirSync(OUTPUT_DIR, { recursive: true });
      writeFileSync(
        join(OUTPUT_DIR, 'user-writes-run.json'),
        `${JSON.stringify({ run_at: new Date().toISOString(), ...summary }, null, 2)}\n`
      );
    });
  }
);
