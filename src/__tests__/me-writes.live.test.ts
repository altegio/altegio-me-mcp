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

// Opt-in live run of the three write tools (ROADMAP criteria 1 and 5, ME-06,
// ME-07, ME-09, plan 04.1-04, D-05). It drives the real app in process with
// CALLER_AUTH=optional, the production request gate and the direct
// X-Altegio-User-Token header (the shape the platform proxy sends headless)
// against the real Altegio API, and it books, moves and cancels ONE real
// booking at the owner's business, each change in its two-call shape:
//
//   me_list_bookings -> business_list_dates -> business_list_time_slots ->
//   me_book (preview, confirm) -> me_list_bookings ->
//   me_reschedule_booking (preview, confirm) ->
//   me_cancel_booking (preview, confirm) -> me_list_bookings
//
// The business sees the booking and may send its default reminders. Only the
// owner runs it, in their own shell, because it reads the local env file:
//
//   ALTEGIO_E2E=1 ALTEGIO_E2E_USER=1 ALTEGIO_E2E_WRITE=1 \
//     node --env-file=.env ./node_modules/jest/bin/jest.js \
//     --testPathPatterns=me-writes.live --runInBand
//
// It needs all three flags and is skipped in the required CI job, where none
// is set. The location is 726120 (ALTEGIO_E2E_WRITE_LOCATION overrides) and
// the slots are at least two days ahead, because that business lets a client
// cancel until 2 hours before the start. The service is
// ALTEGIO_E2E_WRITE_SERVICE_ID, else the first service of the location whose
// prepayment is not_offered; ALTEGIO_E2E_WRITE_TEAM_MEMBER_ID picks a team
// member (default 0, any). 726120 must be an own place of the client, that is,
// the client must have any earlier record there (a cancelled one counts).
// When me_book answers with a fallback, the run fails naming its reason and
// nothing is booked.
//
// Each step runs once and the first failing step is named; every later step is
// skipped with one line (`ME_WRITES_SKIPPED <step>`), so a failure is not
// buried in a cascade. afterAll cancels a booking that was made and not seen
// cancelled, through me_cancel_booking, and prints
// `ME_WRITES_CLEANUP {"booking_id":..,"outcome":".."}`; if that does not
// cancel it, cancel the booking by hand. Then it prints
// `ME_WRITES_SUMMARY <json>` from an allow-list (ids, times, statuses, fallback
// reasons, the call count) and writes the same, plus the text of a refused
// call, to loadtest-output/me-writes-run.json (git-ignored). No token, phone,
// name or confirmation token is printed or put in the summary; the tests at the
// end check the answers and the log lines for both tokens, for a
// confirmation token outside the preview that issued it, and for a phone
// number. Every call goes through the production gate, one at a time, and the
// run stays within MAX_UPSTREAM_CALLS, because developer 2630 is shared with
// marketplace confirmations (docs/runbooks/operations.md).

const LIVE =
  process.env.ALTEGIO_E2E === '1' &&
  process.env.ALTEGIO_E2E_USER === '1' &&
  process.env.ALTEGIO_E2E_WRITE === '1';
const describeLive = LIVE ? describe : describe.skip;

const MAX_UPSTREAM_CALLS = 30;
const LIVE_TIMEOUT_MS = 60_000;
const DEFAULT_API_BASE = 'https://api.alteg.io/api/v1';
const DEFAULT_LOCATION = '726120';
/** First bookable day: this many days after today (UTC). */
const DAYS_AHEAD = 2;
/** How far past the first day the date search reaches (the tool allows 62 days). */
const SEARCH_DAYS = 14;
const MS_PER_DAY = 86_400_000;
/** The length assumed for a slot that states none, in minutes. */
const DEFAULT_SLOT_MINUTES = 60;
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
  'live writes at an own place (ALTEGIO_E2E=1, ALTEGIO_E2E_USER=1, ALTEGIO_E2E_WRITE=1)',
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
      'ALTEGIO_E2E_WRITE_LOCATION',
      Number(DEFAULT_LOCATION)
    );
    let serviceId = 0;
    let teamMemberId = 0;
    let slot1 = '';
    let slot2 = '';
    let bookingId = 0;
    let cancelSeen = false;
    let firstFailure: string | null = null;
    const skippedSteps: string[] = [];
    const steps: StepRecord[] = [];
    const fallbackReasons: string[] = [];
    /** The text of a refused call, by step: for the evidence file only. */
    const refusals: Record<string, string> = {};
    let cleanupOutcome: string | null = null;

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
      serviceId = nonNegativeInt('ALTEGIO_E2E_WRITE_SERVICE_ID', 0);
      teamMemberId = nonNegativeInt('ALTEGIO_E2E_WRITE_TEAM_MEMBER_ID', 0);

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
            `ME_WRITES_SKIPPED ${name}: step ${firstFailure} failed first`
          );
          return;
        }
        try {
          await body();
        } catch (error) {
          firstFailure = name;
          printLine(`ME_WRITES_FAILED ${name}`);
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

    async function slotsOn(
      date: string
    ): Promise<{ datetime: string; duration_minutes: number | null }[]> {
      const answer = await call('business_list_time_slots', {
        location_id: locationId,
        service_ids: [serviceId],
        team_member_id: teamMemberId,
        date,
      });
      record(`slots ${date}`, 'business_list_time_slots', answer, 'ok');
      expect(answer.isError).toBe(false);
      return Array.isArray(answer.structured.items)
        ? (answer.structured.items as {
            datetime: string;
            duration_minutes: number | null;
          }[])
        : [];
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
          'no service without online prepayment on the first page; set ALTEGIO_E2E_WRITE_SERVICE_ID'
        );
        serviceId = service?.id ?? 0;
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'two free, non-overlapping slots at least two days ahead are found',
      run('slots', async () => {
        need(serviceId > 0, 'no service was chosen by the previous step');
        const from = daysFromNow(DAYS_AHEAD);
        const dates = await call('business_list_dates', {
          location_id: locationId,
          service_ids: [serviceId],
          team_member_id: teamMemberId,
          date_from: from,
          date_to: daysFromNow(DAYS_AHEAD + SEARCH_DAYS),
        });
        record('dates', 'business_list_dates', dates, 'ok');
        expect(dates.isError).toBe(false);
        const days = (
          Array.isArray(dates.structured.items)
            ? (dates.structured.items as { date: string }[])
            : []
        )
          .map((item) => item.date)
          .filter((day) => day >= from)
          .sort();
        need(days.length > 0, 'no free date at least two days ahead');

        const first = await slotsOn(days[0] ?? '');
        need(first.length > 0, 'no free slot on the first free date');
        const one = first[0];
        slot1 = one?.datetime ?? '';
        const endOfFirst =
          instantOf(slot1) +
          (one?.duration_minutes ?? DEFAULT_SLOT_MINUTES) * 60_000;
        const later = first.find(
          (slot) => instantOf(slot.datetime) >= endOfFirst
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

    const bookArgs = (): Record<string, unknown> => ({
      location_id: locationId,
      service_ids: [serviceId],
      team_member_id: teamMemberId,
      datetime: slot1,
    });

    let bookToken = '';

    it(
      'me_book without a token returns a preview and books nothing',
      run('book_preview', async () => {
        need(slot1 !== '', 'no slot was found by the previous step');
        const answer = await call('me_book', bookArgs());
        const shown = record(
          'book_preview',
          'me_book',
          answer,
          statusOf(answer)
        );
        need(
          !answer.isError,
          'me_book refused the preview: see the evidence file'
        );
        noFallback(answer, 'me_book preview');
        expect(shown).toBe('preview');
        bookToken = tokenOf(answer);
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'me_book with the token books the slot and returns the booking id',
      run('book_confirm', async () => {
        need(bookToken !== '', 'no confirmation_token was issued');
        const answer = await call('me_book', {
          ...bookArgs(),
          confirmation_token: bookToken,
        });
        const shown = record(
          'book_confirm',
          'me_book',
          answer,
          statusOf(answer)
        );
        need(
          !answer.isError,
          'me_book refused the confirm: see the evidence file'
        );
        noFallback(answer, 'me_book confirm');
        const id = answer.structured.booking_id;
        need(
          typeof id === 'number' && id > 0,
          'me_book booked without a booking_id'
        );
        bookingId = typeof id === 'number' ? id : 0;
        expect(shown).toBe('booked');
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'me_list_bookings shows the new booking upcoming at the first slot',
      run('list_after_book', async () => {
        need(bookingId > 0, 'no booking was made by the previous step');
        const { answer, items } = await listBookings();
        record('list_after_book', 'me_list_bookings', answer, 'ok');
        const entry = items.find((item) => item.booking_id === bookingId);
        need(
          entry !== undefined,
          'the new booking is not on the first 50 bookings'
        );
        expect(entry?.status).toBe('upcoming');
        expect(instantOf(entry?.datetime ?? '')).toBe(instantOf(slot1));
      }),
      LIVE_TIMEOUT_MS
    );

    let moveToken = '';

    it(
      'me_reschedule_booking previews the move to the second slot',
      run('move_preview', async () => {
        need(bookingId > 0, 'no booking was made by an earlier step');
        const answer = await call('me_reschedule_booking', {
          booking_id: bookingId,
          datetime: slot2,
        });
        const shown = record(
          'move_preview',
          'me_reschedule_booking',
          answer,
          statusOf(answer)
        );
        need(
          !answer.isError,
          'the move preview was refused: see the evidence file'
        );
        expect(shown).toBe('preview');
        moveToken = tokenOf(answer);
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'me_reschedule_booking with the token moves the booking',
      run('move_confirm', async () => {
        need(moveToken !== '', 'no confirmation_token was issued for the move');
        const answer = await call('me_reschedule_booking', {
          booking_id: bookingId,
          datetime: slot2,
          confirmation_token: moveToken,
        });
        const shown = record(
          'move_confirm',
          'me_reschedule_booking',
          answer,
          statusOf(answer)
        );
        need(!answer.isError, 'the move was refused: see the evidence file');
        expect(shown).toBe('moved');
        const booking = answer.structured.booking as BookingItem | null;
        if (booking !== null) {
          expect(instantOf(booking.datetime)).toBe(instantOf(slot2));
        }
      }),
      LIVE_TIMEOUT_MS
    );

    let cancelToken = '';

    it(
      'me_cancel_booking previews the cancellation',
      run('cancel_preview', async () => {
        need(bookingId > 0, 'no booking was made by an earlier step');
        const answer = await call('me_cancel_booking', {
          booking_id: bookingId,
        });
        const shown = record(
          'cancel_preview',
          'me_cancel_booking',
          answer,
          statusOf(answer)
        );
        need(
          !answer.isError,
          'the cancel preview was refused: see the evidence file'
        );
        expect(shown).toBe('preview');
        cancelToken = tokenOf(answer);
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'me_cancel_booking with the token cancels the booking',
      run('cancel_confirm', async () => {
        need(
          cancelToken !== '',
          'no confirmation_token was issued for the cancel'
        );
        const answer = await call('me_cancel_booking', {
          booking_id: bookingId,
          confirmation_token: cancelToken,
        });
        const shown = record(
          'cancel_confirm',
          'me_cancel_booking',
          answer,
          statusOf(answer)
        );
        need(!answer.isError, 'the cancel was refused: see the evidence file');
        expect(shown).toBe('cancelled');
      }),
      LIVE_TIMEOUT_MS
    );

    it(
      'me_list_bookings shows the booking cancelled',
      run('list_after_cancel', async () => {
        need(bookingId > 0, 'no booking was made by an earlier step');
        const { answer, items } = await listBookings();
        record('list_after_cancel', 'me_list_bookings', answer, 'ok');
        const entry = items.find((item) => item.booking_id === bookingId);
        need(
          entry !== undefined,
          'the booking is not on the first 50 bookings'
        );
        cancelSeen = entry?.status === 'cancelled';
        need(cancelSeen, 'the booking is not shown as cancelled');
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
        if (bookingId > 0 && !cancelSeen && harness !== undefined) {
          try {
            const preview = await call('me_cancel_booking', {
              booking_id: bookingId,
            });
            if (preview.isError) {
              cleanupOutcome = 'preview_refused';
            } else {
              const confirm = await call('me_cancel_booking', {
                booking_id: bookingId,
                confirmation_token: tokenOf(preview),
              });
              cleanupOutcome = confirm.isError
                ? 'confirm_refused'
                : statusOf(confirm);
            }
          } catch (error) {
            cleanupOutcome =
              error instanceof Error ? error.name : 'unknown_error';
          }
          printLine(
            `ME_WRITES_CLEANUP ${JSON.stringify({
              booking_id: bookingId,
              outcome: cleanupOutcome,
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
          steps,
          booking_id: bookingId > 0 ? bookingId : null,
          cancel_seen: cancelSeen,
          fallback_reasons: fallbackReasons,
          cleanup: cleanupOutcome,
          upstream_calls: requests.length,
        };
        const text = JSON.stringify(summary);
        const secrets = [partnerToken, userToken, ...issuedTokens];
        if (scrubSecrets(text, secrets) !== text || PHONE_PATTERN.test(text)) {
          printLine('ME_WRITES_SUMMARY withheld: it would hold a secret');
          return;
        }
        printLine(`ME_WRITES_SUMMARY ${text}`);
        // The text of a refused call (a tool error names the next action and
        // quotes nothing of the business) goes to the evidence file only, and
        // only after the same scrub.
        const refused = scrubSecrets(JSON.stringify(refusals), secrets);
        mkdirSync(OUTPUT_DIR, { recursive: true });
        writeFileSync(
          join(OUTPUT_DIR, 'me-writes-run.json'),
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
