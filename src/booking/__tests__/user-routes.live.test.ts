import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from '@jest/globals';
import { ALTEGIO_ACCEPT } from '../http.js';
import { scrubSecrets } from '../../observability/redact.js';
import {
  createRecordingFetch,
  USER_ROUTES,
  type Recording,
} from './helpers/live-recorder.js';

// Opt-in live suite of the two signed-in routes (ME-05, plan 04-01, D-02):
// GET /user/companies/yplaces (the client's own places) and GET /user/records
// (the client's bookings). Both are undocumented, so this suite records their
// contract. It runs only with ALTEGIO_E2E=1 and ALTEGIO_E2E_USER=1, through
//
//   ALTEGIO_E2E=1 ALTEGIO_E2E_USER=1 node --env-file=.env \
//     ./node_modules/jest/bin/jest.js --testPathPatterns=user-routes.live --runInBand
//
// which loads the partner token (ALTEGIO_API_TOKEN) and the user token of a
// test client (ALTEGIO_USER_TOKEN) from the local .env. The required CI job
// sets neither flag, so every test here reports as skipped there.
//
// The suite makes exactly two upstream calls, because the partner budget is
// shared (docs/runbooks/operations.md). The Authorization header names both
// tokens, `Bearer <partner>, User <user>`, and is composed here in test code;
// the production client gains it in plan 04-02. The sign-in routes are never
// called from code: the owner obtains the user token by hand
// (docs/research/signed-in-routes.md). With ALTEGIO_E2E_RECORD=1 the sanitised
// answers are written to fixtures/live/, and the last test fails, naming only
// the file, when a recording holds either token in any encoded form.

const LIVE =
  process.env.ALTEGIO_E2E === '1' && process.env.ALTEGIO_E2E_USER === '1';
const RECORD = process.env.ALTEGIO_E2E_RECORD === '1';
const describeLive = LIVE ? describe : describe.skip;

const MAX_UPSTREAM_CALLS = 2;
const REQUEST_TIMEOUT_MS = 10_000;
const LIVE_TIMEOUT_MS = 30_000;
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
const LIVE_DIR = join(
  process.cwd(),
  'src',
  'booking',
  '__tests__',
  'fixtures',
  'live'
);

describeLive(
  'live signed-in routes (ALTEGIO_E2E=1, ALTEGIO_E2E_USER=1)',
  () => {
    let base = DEFAULT_API_BASE;
    let partnerToken = '';
    let userToken = '';
    let recordingFetch: typeof fetch = fetch;
    /** Every upstream request URL, in order. */
    const requests: URL[] = [];
    const recordings: Recording[] = [];

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
        if (RECORD && recording.status >= 200 && recording.status < 300) {
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

    /** One GET of a signed-in route with both tokens in the Authorization header. */
    function getUserRoute(path: string): Promise<Response> {
      return recordingFetch(`${base}${path}`, {
        method: 'GET',
        headers: {
          Accept: ALTEGIO_ACCEPT,
          Authorization: `Bearer ${partnerToken}, User ${userToken}`,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    }

    /** The envelope data of a 200 answer, which must be a list. */
    async function listOf(path: string): Promise<unknown[]> {
      const response = await getUserRoute(path);
      expect(response.status).toBe(200);
      const envelope = (await response.json()) as { data?: unknown };
      expect(Array.isArray(envelope.data)).toBe(true);
      return envelope.data as unknown[];
    }

    it(
      'GET /user/companies/yplaces answers 200 with a list of places',
      async () => {
        await listOf('/user/companies/yplaces');
        expect(recordings.map((entry) => entry.route)).toContain(
          'user_yplaces'
        );
      },
      LIVE_TIMEOUT_MS
    );

    it(
      'GET /user/records answers 200 with a list of records',
      async () => {
        await listOf('/user/records');
        expect(recordings.map((entry) => entry.route)).toContain(
          'user_records'
        );
      },
      LIVE_TIMEOUT_MS
    );

    it('the recordings on disk hold neither token in any encoded form', () => {
      // Runs with both tokens in the environment, which the required CI job
      // never has; only the file name and a label are reported, never a token.
      const problems: string[] = [];
      for (const route of USER_ROUTES) {
        const file = join(LIVE_DIR, `${route}.json`);
        if (!existsSync(file)) {
          if (RECORD) problems.push(`${route}.json: not written`);
          continue;
        }
        const text = readFileSync(file, 'utf8');
        if (scrubSecrets(text, [partnerToken, userToken]) !== text) {
          problems.push(`${route}.json: token`);
        }
      }
      expect(problems).toEqual([]);
    });

    it(`stays within ${MAX_UPSTREAM_CALLS} upstream calls`, () => {
      expect(requests).toHaveLength(MAX_UPSTREAM_CALLS);
    });
  }
);
