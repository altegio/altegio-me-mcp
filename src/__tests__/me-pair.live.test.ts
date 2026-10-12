import { mkdirSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { BookingClient } from '../booking/client.js';
import { RequestGate, PRODUCTION_GATE_OPTIONS } from '../booking/gate.js';
import { scrubSecrets } from '../observability/redact.js';
import { DIRECT_USER_TOKEN_HEADER } from '../security/caller-auth.js';
import { productionTools } from '../tools/registry.js';
import {
  closeAllApps,
  postMcp,
  startApp,
  toolCallBody,
  type Harness,
} from './helpers/http-harness.js';

// Opt-in live run of two people side by side through the real app (CASE-02,
// plan 05-02, D-01). It drives the app in process with CALLER_AUTH=optional,
// the production request gate and the direct X-Altegio-User-Token header (the
// shape the platform proxy sends headless) against the real Altegio API, and it
// books and cancels ONE pair of appointments at the owner's business: two
// different, named team members at ONE start, under the signed-in client, each
// change in its two-call shape:
//
//   me_list_bookings -> business_list_services -> business_list_team_members ->
//   business_list_dates and business_list_time_slots for both team members ->
//   me_book with second_appointment (preview, confirm) -> me_list_bookings ->
//   me_cancel_booking for each booking (preview, confirm) -> me_list_bookings
//
// The business sees two bookings under the client's name and may send its
// default reminders. Only the owner runs it, in their own shell, because it
// reads the local env file:
//
//   ALTEGIO_E2E=1 ALTEGIO_E2E_USER=1 ALTEGIO_E2E_WRITE=1 ALTEGIO_E2E_PAIR=1 \
//     node --env-file=.env ./node_modules/jest/bin/jest.js \
//     --testPathPatterns=me-pair.live --runInBand
//
// It needs all four flags and is skipped in the required CI job, where none is
// set. The location is 726120 (ALTEGIO_E2E_PAIR_LOCATION overrides) and the
// slot is at least two days ahead, because that business lets a client cancel
// until 2 hours before the start. The service is ALTEGIO_E2E_PAIR_SERVICE_ID,
// else the first service of the location whose prepayment is not_offered; the
// two team members are ALTEGIO_E2E_PAIR_TEAM_MEMBER_IDS ("A,B", two different
// positive ids), else the first two team members who provide the service.
// 726120 must be an own place of the client, that is, the client must have any
// earlier record there (a cancelled one counts). When me_book answers with a
// fallback, the run fails naming its reason and nothing is booked.
//
// Each step runs once and the first failing step is named; every later step is
// skipped with one line (`ME_PAIR_SKIPPED <step>`), so a failure is not buried
// in a cascade. afterAll cancels every booking that was made and not seen
// cancelled, through me_cancel_booking, and prints
// `ME_PAIR_CLEANUP {"booking_id":..,"outcome":".."}` for each; if that does not
// cancel it, cancel the booking by hand. Then it prints
// `ME_PAIR_SUMMARY <json>` from an allow-list (ids, times, statuses, fallback
// reasons, the call count) and writes the same, plus the text of a refused
// call, to loadtest-output/me-pair-run.json (git-ignored). No token, phone,
// name or confirmation token is printed or put in the summary; the tests at the
// end check the answers and the log lines for both tokens, for a confirmation
// token outside the preview that issued it, and for a phone number. Every call
// goes through the production gate, one at a time, and the run stays within
// MAX_UPSTREAM_CALLS, because developer 2630 is shared with marketplace
// confirmations (docs/runbooks/operations.md).

const LIVE =
  process.env.ALTEGIO_E2E === '1' &&
  process.env.ALTEGIO_E2E_USER === '1' &&
  process.env.ALTEGIO_E2E_WRITE === '1' &&
  process.env.ALTEGIO_E2E_PAIR === '1';
const describeLive = LIVE ? describe : describe.skip;

const MAX_UPSTREAM_CALLS = 40;
/** No request goes out past this many, so a runaway loop cannot reach the shared account. */
const HARD_STOP_CALLS = 50;
const LIVE_TIMEOUT_MS = 60_000;
const DEFAULT_API_BASE = 'https://api.alteg.io/api/v1';
const DEFAULT_LOCATION = '726120';
/** First bookable day: this many days after today (UTC). */
const DAYS_AHEAD = 2;
/** How far past the first day the date search reaches (the tool allows 62 days). */
const SEARCH_DAYS = 14;
/** At most this many common dates are searched for a slot both team members have. */
const MAX_COMMON_DATES = 2;
const MS_PER_DAY = 86_400_000;
/** A plus sign followed by ten or more digits: a phone number. */
const PHONE_PATTERN = /\+\d{10,}/;
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

/** Fails with a message that names the missing condition (never a secret). */
function need(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** One line to the terminal, written synchronously so the end of the run cannot drop it. */
function printLine(text: string): void {
  writeSync(1, `${text}\n`);
}

/** A non-negative integer from an environment value, or `fallback` when unset. */
function nonNegativeInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return fallback;
  need(/^\d+$/.test(raw), `${name} must be a non-negative integer`);
  return Number(raw);
}

/** Two different positive ids from "A,B", or null when the variable is unset. */
function teamMemberIdsFromEnv(): [number, number] | null {
  const raw = (process.env.ALTEGIO_E2E_PAIR_TEAM_MEMBER_IDS ?? '').trim();
  if (raw === '') return null;
  const parts = raw.split(',').map((part) => part.trim());
  need(
    parts.length === 2 && parts.every((part) => /^[1-9]\d*$/.test(part)),
    'ALTEGIO_E2E_PAIR_TEAM_MEMBER_IDS must be two positive ids, "A,B"'
  );
  const [first, second] = parts.map(Number) as [number, number];
  need(first !== second, 'ALTEGIO_E2E_PAIR_TEAM_MEMBER_IDS must differ');
  return [first, second];
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** The instant of a slot or booking datetime, whether its offset reads +03:00 or +0300. */
function instantOf(datetime: string): number {
  return Date.parse(datetime.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

interface ToolAnswer {
  isError: boolean;
  structured: Structured;
  /** The text of the answer; kept for the evidence file of a refused call only. */
  text: string;
}

interface StepRecord {
  step: string;
  tool: string;
  status: string;
}

interface BookingItem {
  booking_id: number;
  status: string;
  datetime: string;
}

interface Fallback {
  reason?: string;
}

describeLive(
  'live pair booking at an own place (ALTEGIO_E2E=1, ALTEGIO_E2E_USER=1, ALTEGIO_E2E_WRITE=1, ALTEGIO_E2E_PAIR=1)',
  () => {
    let harness: Harness;
    let partnerToken = '';
    let userToken = '';
    /** Every upstream request URL, in order. */
    const requests: URL[] = [];
    /** Every tool answer: its text and whether it is a preview, for the leak scan. */
    const answers: { text: string; status: string }[] = [];
    /** Every confirmation token a preview issued; in memory only, never printed. */
    const issuedTokens: string[] = [];

    const locationId = nonNegativeInt(
      'ALTEGIO_E2E_PAIR_LOCATION',
      Number(DEFAULT_LOCATION)
    );
    let serviceId = 0;
    let memberA = 0;
    let memberB = 0;
    let slot = '';
    let firstId = 0;
    let secondId = 0;
    /** Booking ids a cancel was seen to take (status cancelled on a re-read). */
    const cancelSeen = new Set<number>();
    let firstFailure: string | null = null;
    const skippedSteps: string[] = [];
    const steps: StepRecord[] = [];
    const fallbackReasons: string[] = [];
    /** The text of a refused call, by step: for the evidence file only. */
    const refusals: Record<string, string> = {};
    const cleanupOutcomes: { booking_id: number; outcome: string }[] = [];

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
      serviceId = nonNegativeInt('ALTEGIO_E2E_PAIR_SERVICE_ID', 0);
      const given = teamMemberIdsFromEnv();
      if (given !== null) [memberA, memberB] = given;

      const counting: typeof fetch = (input, init) => {
        if (requests.length >= HARD_STOP_CALLS) {
          return Promise.reject(
            new Error(`more than ${String(HARD_STOP_CALLS)} upstream calls`)
          );
        }
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
      const body = JSON.parse(text) as {
        result?: { isError?: boolean; structuredContent?: Structured };
      };
      const structured = body.result?.structuredContent ?? {};
      const status =
        typeof structured.status === 'string' ? structured.status : '';
      const token = structured.confirmation_token;
      if (typeof token === 'string' && token !== '') issuedTokens.push(token);
      answers.push({ text, status });
      return { isError: body.result?.isError === true, structured, text };
    }

    /** Records a step's tool and status; the status of a refused call is `error`. */
    function record(
      step: string,
      tool: string,
      answer: ToolAnswer,
      status: string
    ): string {
      const shown = answer.isError ? 'error' : status;
      steps.push({ step, tool, status: shown });
      if (answer.isError) refusals[step] = answer.text.slice(0, 600);
      return shown;
    }

    /** Wraps a step: after a failure it only names itself; a failure is named once. */
    function run(name: string, body: () => Promise<void>): () => Promise<void> {
      return async () => {
        if (firstFailure !== null) {
          skippedSteps.push(name);
          printLine(
            `ME_PAIR_SKIPPED ${name}: step ${firstFailure} failed first`
          );
          return;
        }
        try {
          await body();
        } catch (error) {
          firstFailure = name;
          printLine(`ME_PAIR_FAILED ${name}`);
          throw error;
        }
      };
    }

    function statusOf(answer: ToolAnswer): string {
      const status = answer.structured.status;
      return typeof status === 'string' ? status : '';
    }

    /** Fails an answer that is a fallback, naming its reason (nothing was changed). */
    function noFallback(answer: ToolAnswer, what: string): void {
      if (statusOf(answer) !== 'fallback') return;
      const fallback = answer.structured.fallback as Fallback | null;
      const reason = fallback?.reason ?? 'unknown';
      fallbackReasons.push(reason);
      throw new Error(
        reason === 'not_confirmed'
          ? `${what} answered fallback not_confirmed: the booking service did not confirm it from here (the anti-fraud path)`
          : `${what} answered fallback ${reason}; nothing was changed`
      );
    }

    function tokenOf(answer: ToolAnswer): string {
      const token = answer.structured.confirmation_token;
      need(
        typeof token === 'string' && token !== '',
        'the preview carried no confirmation_token'
      );
      return typeof token === 'string' ? token : '';
    }

    async function listBookings(): Promise<{
      answer: ToolAnswer;
      items: BookingItem[];
    }> {
      const answer = await call('me_list_bookings', { page_size: 50 });
      const items = Array.isArray(answer.structured.items)
        ? (answer.structured.items as BookingItem[])
        : [];
      return { answer, items };
    }

    async function datesOf(teamMemberId: number): Promise<string[]> {
      const from = daysFromNow(DAYS_AHEAD);
      const answer = await call('business_list_dates', {
        location_id: locationId,
        service_ids: [serviceId],
        team_member_id: teamMemberId,
        date_from: from,
        date_to: daysFromNow(DAYS_AHEAD + SEARCH_DAYS),
      });
      record(
        `dates ${String(teamMemberId)}`,
        'business_list_dates',
        answer,
        'ok'
      );
      expect(answer.isError).toBe(false);
      return (
        Array.isArray(answer.structured.items)
          ? (answer.structured.items as { date: string }[])
          : []
      )
        .map((item) => item.date)
        .filter((day) => day >= from)
        .sort();
    }

    async function slotsOf(
      teamMemberId: number,
      date: string
    ): Promise<string[]> {
      const answer = await call('business_list_time_slots', {
        location_id: locationId,
        service_ids: [serviceId],
        team_member_id: teamMemberId,
        date,
      });
      record(
        `slots ${String(teamMemberId)} ${date}`,
        'business_list_time_slots',
        answer,
        'ok'
      );
      expect(answer.isError).toBe(false);
      return (
        Array.isArray(answer.structured.items)
          ? (answer.structured.items as { datetime: string }[])
          : []
      ).map((item) => item.datetime);
    }

    it(
      'me_list_bookings lists the own bookings',
      run('list_before', async () => {
        const { answer } = await listBookings();
        const shown = record('list_before', 'me_list_bookings', answer, 'ok');
        expect(shown).toBe('ok');
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'a service without online prepayment is chosen at the location',
      run('service', async () => {
        if (serviceId > 0) return;
        const answer = await call('business_list_services', {
          location_id: locationId,
          page_size: 50,
        });
        record('service', 'business_list_services', answer, 'ok');
        expect(answer.isError).toBe(false);
        const items = Array.isArray(answer.structured.items)
          ? (answer.structured.items as { id: number; prepayment: string }[])
          : [];
        const service = items.find(
          (entry) => entry.prepayment === 'not_offered'
        );
        need(
          service !== undefined,
          'no service without online prepayment on the first page; set ALTEGIO_E2E_PAIR_SERVICE_ID'
        );
        serviceId = service?.id ?? 0;
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'two different team members who provide the service are chosen',
      run('team_members', async () => {
        need(serviceId > 0, 'no service was chosen by the previous step');
        if (memberA > 0 && memberB > 0) return;
        const answer = await call('business_list_team_members', {
          location_id: locationId,
          service_ids: [serviceId],
          page_size: 50,
        });
        record('team_members', 'business_list_team_members', answer, 'ok');
        expect(answer.isError).toBe(false);
        const ids = (
          Array.isArray(answer.structured.items)
            ? (answer.structured.items as { id: number }[])
            : []
        ).map((item) => item.id);
        need(
          ids.length >= 2,
          'fewer than two team members provide the service; set ALTEGIO_E2E_PAIR_SERVICE_ID or ALTEGIO_E2E_PAIR_TEAM_MEMBER_IDS'
        );
        memberA = ids[0] ?? 0;
        memberB = ids[1] ?? 0;
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'a start both team members have free, at least two days ahead, is found',
      run('slot', async () => {
        need(memberA > 0 && memberB > 0, 'two team members were not chosen');
        const datesA = await datesOf(memberA);
        const datesB = new Set(await datesOf(memberB));
        const common = datesA
          .filter((day) => datesB.has(day))
          .slice(0, MAX_COMMON_DATES);
        need(
          common.length > 0,
          'no date at least two days ahead has free time for both'
        );
        for (const day of common) {
          const slotsA = await slotsOf(memberA, day);
          const slotsB = new Set(await slotsOf(memberB, day));
          // Compared as exact strings: a slot carries its offset.
          const shared = slotsA.find((datetime) => slotsB.has(datetime));
          if (shared !== undefined) {
            slot = shared;
            return;
          }
        }
        need(
          false,
          'no start is free for both team members on the first common dates'
        );
      }),
      LIVE_TIMEOUT_MS
    );

    const pairArgs = (): Record<string, unknown> => ({
      location_id: locationId,
      service_ids: [serviceId],
      team_member_id: memberA,
      datetime: slot,
      second_appointment: {
        service_ids: [serviceId],
        team_member_id: memberB,
      },
    });

    let pairToken = '';

    it(
      'me_book with second_appointment returns one preview of both and books nothing',
      run('pair_preview', async () => {
        need(slot !== '', 'no slot was found by the previous step');
        const answer = await call('me_book', pairArgs());
        const shown = record(
          'pair_preview',
          'me_book',
          answer,
          statusOf(answer)
        );
        need(
          !answer.isError,
          'me_book refused the pair preview: see the evidence file'
        );
        noFallback(answer, 'me_book pair preview');
        expect(shown).toBe('preview');
        const preview = answer.structured.preview as {
          second_appointment: unknown;
        } | null;
        need(
          preview?.second_appointment != null,
          'the preview did not carry the second appointment'
        );
        pairToken = tokenOf(answer);
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'me_book with the token books both appointments and returns both booking ids',
      run('pair_confirm', async () => {
        need(pairToken !== '', 'no confirmation_token was issued');
        const answer = await call('me_book', {
          ...pairArgs(),
          confirmation_token: pairToken,
        });
        const shown = record(
          'pair_confirm',
          'me_book',
          answer,
          statusOf(answer)
        );
        need(
          !answer.isError,
          'me_book refused the pair confirm: see the evidence file'
        );
        noFallback(answer, 'me_book pair confirm');
        const first = answer.structured.booking_id;
        const second = answer.structured.second_booking_id;
        // Whatever was booked is cancelled by afterAll, also on a partial pair.
        if (typeof first === 'number' && first > 0) firstId = first;
        if (typeof second === 'number' && second > 0) secondId = second;
        expect(shown).toBe('booked');
        need(
          firstId > 0 && secondId > 0 && firstId !== secondId,
          'me_book did not return two different booking ids'
        );
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'me_list_bookings shows both bookings upcoming at the one start',
      run('list_after_book', async () => {
        need(
          firstId > 0 && secondId > 0,
          'no pair was booked by the previous step'
        );
        const { answer, items } = await listBookings();
        record('list_after_book', 'me_list_bookings', answer, 'ok');
        for (const id of [firstId, secondId]) {
          const entry = items.find((item) => item.booking_id === id);
          need(
            entry !== undefined,
            'a booking of the pair is not on the first 50 bookings'
          );
          expect(entry?.status).toBe('upcoming');
          expect(instantOf(entry?.datetime ?? '')).toBe(instantOf(slot));
        }
      }),
      LIVE_TIMEOUT_MS
    );

    /** Previews and confirms the cancellation of one booking of the pair. */
    async function cancel(step: string, bookingId: number): Promise<void> {
      need(bookingId > 0, 'no booking was made by an earlier step');
      const preview = await call('me_cancel_booking', {
        booking_id: bookingId,
      });
      const shownPreview = record(
        `${step}_preview`,
        'me_cancel_booking',
        preview,
        statusOf(preview)
      );
      need(
        !preview.isError,
        'the cancel preview was refused: see the evidence file'
      );
      expect(shownPreview).toBe('preview');
      const confirm = await call('me_cancel_booking', {
        booking_id: bookingId,
        confirmation_token: tokenOf(preview),
      });
      const shown = record(
        `${step}_confirm`,
        'me_cancel_booking',
        confirm,
        statusOf(confirm)
      );
      need(!confirm.isError, 'the cancel was refused: see the evidence file');
      expect(shown).toBe('cancelled');
    }

    it(
      'me_cancel_booking cancels the first booking, previewed first',
      run('cancel_first', () => cancel('cancel_first', firstId)),
      LIVE_TIMEOUT_MS
    );

    it(
      'me_cancel_booking cancels the second booking, previewed first',
      run('cancel_second', () => cancel('cancel_second', secondId)),
      LIVE_TIMEOUT_MS
    );

    it(
      'me_list_bookings shows both bookings cancelled',
      run('list_after_cancel', async () => {
        need(
          firstId > 0 && secondId > 0,
          'no pair was booked by an earlier step'
        );
        const { answer, items } = await listBookings();
        record('list_after_cancel', 'me_list_bookings', answer, 'ok');
        for (const id of [firstId, secondId]) {
          const entry = items.find((item) => item.booking_id === id);
          need(
            entry !== undefined,
            'a booking of the pair is not on the first 50 bookings'
          );
          if (entry?.status === 'cancelled') cancelSeen.add(id);
        }
        need(
          cancelSeen.has(firstId) && cancelSeen.has(secondId),
          'a booking of the pair is not shown as cancelled'
        );
      }),
      LIVE_TIMEOUT_MS
    );

    it('no answer text and no log line holds a token, a stray confirmation token or a phone number', () => {
      // Only a label is reported on failure, never a value.
      const logText = JSON.stringify(harness.logs);
      const everything = [...answers.map((a) => a.text), logText];
      const leaks: string[] = [];
      for (const [label, token] of [
        ['partner token', partnerToken],
        ['user token', userToken],
      ] as const) {
        if (everything.some((text) => text.includes(token))) leaks.push(label);
      }
      // A confirmation token is in the answer of the preview that issued it
      // (the model needs it for the second call) and nowhere else.
      for (const token of issuedTokens) {
        if (logText.includes(token)) leaks.push('confirmation token in a log');
        if (
          answers.some((a) => a.status !== 'preview' && a.text.includes(token))
        ) {
          leaks.push('confirmation token outside a preview');
        }
      }
      if (answers.some((a) => PHONE_PATTERN.test(a.text))) {
        leaks.push('phone number in an answer');
      }
      expect(leaks).toEqual([]);
    });

    it(`stays within ${String(MAX_UPSTREAM_CALLS)} upstream calls`, () => {
      expect(requests.length).toBeLessThanOrEqual(MAX_UPSTREAM_CALLS);
    });

    afterAll(async () => {
      try {
        // A booking that was made and not seen cancelled is cancelled again.
        for (const bookingId of [firstId, secondId]) {
          if (bookingId <= 0 || cancelSeen.has(bookingId)) continue;
          if (harness === undefined) continue;
          let outcome: string;
          try {
            const preview = await call('me_cancel_booking', {
              booking_id: bookingId,
            });
            if (preview.isError) {
              outcome = 'preview_refused';
            } else {
              const confirm = await call('me_cancel_booking', {
                booking_id: bookingId,
                confirmation_token: tokenOf(preview),
              });
              outcome = confirm.isError ? 'confirm_refused' : statusOf(confirm);
            }
          } catch (error) {
            outcome = error instanceof Error ? error.name : 'unknown_error';
          }
          cleanupOutcomes.push({ booking_id: bookingId, outcome });
          printLine(
            `ME_PAIR_CLEANUP ${JSON.stringify({
              booking_id: bookingId,
              outcome,
            })}`
          );
        }
        // Printed here, not at the end of the last step, so an aborted run
        // still reports what it saw.
        const summary = {
          location_id: locationId,
          service_id: serviceId,
          team_member_ids: [memberA, memberB],
          slot,
          first_failure: firstFailure,
          skipped_steps: skippedSteps,
          steps,
          booking_ids: [
            firstId > 0 ? firstId : null,
            secondId > 0 ? secondId : null,
          ],
          cancel_seen: [...cancelSeen],
          fallback_reasons: fallbackReasons,
          cleanup: cleanupOutcomes,
          upstream_calls: requests.length,
        };
        const text = JSON.stringify(summary);
        const secrets = [partnerToken, userToken, ...issuedTokens];
        if (scrubSecrets(text, secrets) !== text || PHONE_PATTERN.test(text)) {
          printLine('ME_PAIR_SUMMARY withheld: it would hold a secret');
          return;
        }
        printLine(`ME_PAIR_SUMMARY ${text}`);
        // The text of a refused call (a tool error names the next action and
        // quotes nothing of the business) goes to the evidence file only, and
        // only after the same scrub.
        const refused = scrubSecrets(JSON.stringify(refusals), secrets);
        mkdirSync(OUTPUT_DIR, { recursive: true });
        writeFileSync(
          join(OUTPUT_DIR, 'me-pair-run.json'),
          `${JSON.stringify(
            {
              run_at: new Date().toISOString(),
              ...summary,
              refusals: PHONE_PATTERN.test(refused)
                ? 'withheld: phone-like number'
                : (JSON.parse(refused) as Record<string, string>),
            },
            null,
            2
          )}\n`
        );
      } finally {
        await closeAllApps();
      }
    });
  }
);
