import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A fetch replacement backed by JSON fixtures. Each fixture file under
// src/booking/__tests__/fixtures/ maps scenario names to a response. Fixtures
// load through process.cwd(): Jest runs as CommonJS, so import.meta.url is
// not available here.

export interface FixtureResponse {
  status: number;
  headers?: Record<string, string>;
  /** Serialised with JSON.stringify unless it is a string. */
  body: unknown;
}

export type FakeReply =
  | FixtureResponse
  | ((call: RecordedCall) => FixtureResponse | Promise<FixtureResponse>);

export interface FakeRoute {
  method: 'GET' | 'POST';
  /** Path after the API base path, for example '/company/722227'. */
  path: string;
  reply: FakeReply;
}

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Headers;
  body: string | null;
}

export interface FakeFetch {
  fetch: typeof fetch;
  calls: RecordedCall[];
  unmatched: RecordedCall[];
}

const FIXTURE_DIR = join(
  process.cwd(),
  'src',
  'booking',
  '__tests__',
  'fixtures'
);

export function loadFixture(route: string, scenario: string): FixtureResponse {
  const file = join(FIXTURE_DIR, `${route}.json`);
  const scenarios = JSON.parse(readFileSync(file, 'utf8')) as Record<
    string,
    FixtureResponse
  >;
  const fixture = scenarios[scenario];
  if (fixture === undefined) {
    throw new Error(`fixture ${route}.json has no scenario ${scenario}`);
  }
  return fixture;
}

function toResponse(fixture: FixtureResponse): Response {
  const body =
    typeof fixture.body === 'string'
      ? fixture.body
      : JSON.stringify(fixture.body);
  return new Response(body, {
    status: fixture.status,
    headers: fixture.headers,
  });
}

// Rejects with the signal's reason when it aborts, as the real fetch does.
function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal | null | undefined
): Promise<T> {
  if (signal === null || signal === undefined) return work;
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

/**
 * Matches method plus the URL path after `basePath` against `routes`. A request
 * with no route is recorded in `unmatched` and answered with status 599.
 */
export function fakeFetch(
  routes: readonly FakeRoute[],
  options: { basePath?: string } = {}
): FakeFetch {
  const basePath = options.basePath ?? '/api/v1';
  const calls: RecordedCall[] = [];
  const unmatched: RecordedCall[] = [];

  const fake = (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call: RecordedCall = {
      method: (init.method ?? 'GET').toUpperCase(),
      url,
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : null,
    };
    calls.push(call);

    const path = url.pathname.startsWith(basePath)
      ? url.pathname.slice(basePath.length)
      : url.pathname;
    const route = routes.find(
      (entry) => entry.method === call.method && entry.path === path
    );
    if (route === undefined) {
      unmatched.push(call);
      return Promise.resolve(toResponse({ status: 599, body: '' }));
    }
    const reply = route.reply;
    const work = Promise.resolve(
      typeof reply === 'function' ? reply(call) : reply
    ).then(toResponse);
    return abortable(work, init.signal);
  };

  return { fetch: fake, calls, unmatched };
}
