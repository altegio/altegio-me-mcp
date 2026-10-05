import { describe, expect, it } from '@jest/globals';
import {
  SECRET_TTL_MS,
  createFileSecretSource,
  createStaticSecretSource,
  type SecretSource,
} from '../../config/secret-source.js';
import { BookingClient } from '../client.js';
import { UpstreamError } from '../errors.js';
import { BookingHttp, type UpstreamCallSpec } from '../http.js';
import { createFakeClock } from './helpers/fake-clock.js';
import {
  fakeFetch,
  loadFixture,
  type FakeFetch,
  type FakeRoute,
} from './helpers/fake-fetch.js';

// OPS-04: the partner token reaches BookingHttp through a SecretSource, so a
// rotation by the platform needs no restart. Time comes from the fake clock
// and file reads from an injected readFile: no timers, no real file, no real
// waiting. The upstream is a fake fetch that accepts only the tokens a test
// names.

const BASE = 'https://api.alteg.io/api/v1';
const LOCATION = 722227;
const PATH = '/secrets/altegio-api/token';
const TOKEN_A = 'partner-token-AAAA-0123456789abcdef';
const TOKEN_B = 'partner-token-BBBB-fedcba9876543210';
const REDACTED = '[redacted]';

const CALL: UpstreamCallSpec = {
  method: 'GET',
  route: '/company/{location_id}',
  path: `/company/${String(LOCATION)}`,
};

// Lets a started background re-read finish: it resolves on microtasks only.
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

interface Harness {
  clock: ReturnType<typeof createFakeClock>;
  /** What the "file" holds. */
  file: { payload: string };
  reads: () => number;
  source: SecretSource;
  upstream: FakeFetch;
  http: BookingHttp;
  /** The Authorization header of every upstream call, in order. */
  sent: () => string[];
  /** Runs once at the start of every re-read after the initial one. */
  onReread: { run: () => void };
}

// `accepts` lists the tokens the fake upstream lets through; any other token
// gets `rejectStatus`. `rejectBody` is the envelope of that rejection.
async function harness(
  options: {
    accepts?: readonly string[];
    rejectStatus?: number;
    rejectBody?: unknown;
  } = {}
): Promise<Harness> {
  const accepts = options.accepts ?? [TOKEN_A, TOKEN_B];
  const clock = createFakeClock();
  const file = { payload: `${TOKEN_A}\n` };
  const onReread = { run: (): void => undefined };
  let reads = 0;
  const source = await createFileSecretSource({
    path: PATH,
    setting: 'ALTEGIO_API_TOKEN_FILE',
    now: clock.now,
    readFile: (path: string): Promise<string> => {
      expect(path).toBe(PATH);
      reads += 1;
      if (reads > 1) onReread.run();
      return Promise.resolve(file.payload);
    },
  });
  const routes: FakeRoute[] = [
    {
      method: 'GET',
      path: CALL.path,
      reply: (call) =>
        accepts.some(
          (token) => call.headers.get('authorization') === `Bearer ${token}`
        )
          ? loadFixture('company', 'default')
          : {
              status: options.rejectStatus ?? 401,
              body: options.rejectBody ?? { success: false, meta: {} },
            },
    },
  ];
  const upstream = fakeFetch(routes);
  const http = new BookingHttp({
    base: BASE,
    tokenSource: source,
    fetch: upstream.fetch,
    now: clock.now,
  });
  return {
    clock,
    file,
    reads: () => reads,
    source,
    upstream,
    http,
    sent: () =>
      upstream.calls.map((call) => call.headers.get('authorization') ?? ''),
    onReread,
  };
}

async function failure(promise: Promise<unknown>): Promise<UpstreamError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UpstreamError) return error;
    throw error;
  }
  throw new Error('expected the call to fail with an UpstreamError');
}

describe('BookingHttp token from a SecretSource: the lazy re-read (OPS-04)', () => {
  it('sends the current token, and the rotated one on the request after the re-read', async () => {
    const h = await harness();
    await h.http.send(CALL);
    expect(h.sent()).toEqual([`Bearer ${TOKEN_A}`]);

    h.file.payload = `${TOKEN_B}\n`;
    await h.clock.sleep(SECRET_TTL_MS + 1000);
    // The first request after the TTL starts the re-read and still carries the
    // cached token: the re-read serves the calls after it, never blocks one.
    await h.http.send(CALL);
    await flush();
    await h.http.send(CALL);
    expect(h.sent()).toEqual([
      `Bearer ${TOKEN_A}`,
      `Bearer ${TOKEN_A}`,
      `Bearer ${TOKEN_B}`,
    ]);
  });

  it('never puts the token in the URL', async () => {
    const h = await harness();
    await h.http.send(CALL);
    const url = h.upstream.calls[0]?.url.toString() ?? '';
    expect(url).not.toContain(TOKEN_A);
  });
});

describe('BookingHttp: an upstream 401 or 403 forces one re-read (OPS-04, T-03-20)', () => {
  it.each([401, 403])(
    'on %i with the cache holding A and the file holding B, re-reads once and retries once with B',
    async (status) => {
      const h = await harness({ accepts: [TOKEN_B], rejectStatus: status });
      h.file.payload = `${TOKEN_B}\n`;

      const reply = await h.http.send(CALL);

      expect(reply.status).toBe(200);
      expect(h.sent()).toEqual([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`]);
      expect(h.reads()).toBe(2);
    }
  );

  it('works through BookingClient too: the tool succeeds after the rotation', async () => {
    const h = await harness({ accepts: [TOKEN_B] });
    h.file.payload = `${TOKEN_B}\n`;
    const client = new BookingClient({
      base: BASE,
      tokenSource: h.source,
      fetch: h.upstream.fetch,
      now: h.clock.now,
    });

    const card = await client.company(LOCATION);

    expect(card.locationId).toBe(LOCATION);
    expect(h.sent()).toEqual([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`]);
  });

  it('reports unauthorized after exactly one upstream call when the token did not change', async () => {
    const h = await harness({ accepts: [] });

    const error = await failure(h.http.send(CALL));

    expect(error.kind).toBe('unauthorized');
    expect(error.status).toBe(401);
    expect(h.upstream.calls).toHaveLength(1);
    expect(h.reads()).toBe(2);
  });

  it('reports unauthorized after two upstream calls when B is refused too', async () => {
    const h = await harness({ accepts: [] });
    h.file.payload = `${TOKEN_B}\n`;

    const error = await failure(h.http.send(CALL));

    expect(error.kind).toBe('unauthorized');
    expect(h.sent()).toEqual([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`]);
  });

  it('does not force another re-read for a second 401 within 60 s', async () => {
    const h = await harness({ accepts: [] });
    await failure(h.http.send(CALL));
    expect(h.reads()).toBe(2);

    await h.clock.sleep(SECRET_TTL_MS - 1000);
    await failure(h.http.send(CALL));
    await failure(h.http.send(CALL));

    expect(h.reads()).toBe(2);
    expect(h.upstream.calls).toHaveLength(3);
  });

  it('forces a re-read again once 60 s have passed since the last forced one', async () => {
    const h = await harness({ accepts: [] });
    await failure(h.http.send(CALL));

    await h.clock.sleep(SECRET_TTL_MS);
    await failure(h.http.send(CALL));

    expect(h.reads()).toBeGreaterThan(2);
  });

  it('retries for a request that failed with the old token after another request already refreshed it', async () => {
    const h = await harness({ accepts: [TOKEN_B] });
    h.file.payload = `${TOKEN_B}\n`;

    // Both start with A and both get 401. One forced re-read serves both: the
    // second either joins it or, refused its own (one per 60 s), sees that the
    // token changed and retries.
    const results = await Promise.all([h.http.send(CALL), h.http.send(CALL)]);

    expect(results.map((reply) => reply.status)).toEqual([200, 200]);
    expect(
      h.sent().filter((value) => value === `Bearer ${TOKEN_B}`)
    ).toHaveLength(2);
  });

  it('does not retry when the tool call was dropped while the token was re-read', async () => {
    const h = await harness({ accepts: [TOKEN_B] });
    h.file.payload = `${TOKEN_B}\n`;
    const controller = new AbortController();
    h.onReread.run = (): void => {
      controller.abort(new Error('client went away'));
    };

    const error = await failure(
      h.http.send({ ...CALL, signal: controller.signal })
    );

    expect(error.kind).toBe('unavailable');
    expect(h.upstream.calls).toHaveLength(1);
  });

  it('does not re-read or retry for a status that is not 401 or 403', async () => {
    const h = await harness({ accepts: [], rejectStatus: 404 });

    const error = await failure(h.http.send(CALL));

    expect(error.kind).toBe('not_found');
    expect(h.upstream.calls).toHaveLength(1);
    expect(h.reads()).toBe(1);
  });
});

describe('BookingHttp: scrubbing the current and the previous token (SEC-03, T-03-21)', () => {
  it('redacts a rotated-out token that an upstream error message quotes', async () => {
    const h = await harness({
      accepts: [],
      rejectStatus: 400,
      rejectBody: {
        success: false,
        meta: {
          message: `Bad request for ${TOKEN_A}, current key ${TOKEN_B}, ok`,
        },
      },
    });
    h.file.payload = `${TOKEN_B}\n`;
    await h.clock.sleep(SECRET_TTL_MS + 1000);
    h.source.current();
    await flush();
    expect(h.source.known()).toEqual([TOKEN_B, TOKEN_A]);

    const error = await failure(h.http.send(CALL));

    const message = error.upstreamMessage ?? '';
    expect(message).not.toContain(TOKEN_A);
    expect(message).not.toContain(TOKEN_B);
    expect(message).toContain(REDACTED);
    expect(message).toContain('Bad request for');
  });

  it('redacts the token of a static source too', async () => {
    const upstream = fakeFetch([
      {
        method: 'GET',
        path: CALL.path,
        reply: {
          status: 400,
          body: { meta: { message: `echo ${TOKEN_A}` } },
        },
      },
    ]);
    const http = new BookingHttp({
      base: BASE,
      tokenSource: createStaticSecretSource(TOKEN_A),
      fetch: upstream.fetch,
    });

    const error = await failure(http.send(CALL));

    expect(error.upstreamMessage).toBe(`echo ${REDACTED}`);
  });
});

describe('BookingHttp: a plain token string (tests and local runs)', () => {
  it('still accepts token and sends it as the Bearer credential', async () => {
    const upstream = fakeFetch([
      {
        method: 'GET',
        path: CALL.path,
        reply: loadFixture('company', 'default'),
      },
    ]);
    const http = new BookingHttp({
      base: BASE,
      token: TOKEN_A,
      fetch: upstream.fetch,
    });

    await http.send(CALL);

    expect(upstream.calls[0]?.headers.get('authorization')).toBe(
      `Bearer ${TOKEN_A}`
    );
  });

  it('does not retry a 401 for a plain token', async () => {
    const upstream = fakeFetch([
      { method: 'GET', path: CALL.path, reply: { status: 401, body: '' } },
    ]);
    const http = new BookingHttp({
      base: BASE,
      token: TOKEN_A,
      fetch: upstream.fetch,
    });

    const error = await failure(http.send(CALL));

    expect(error.kind).toBe('unauthorized');
    expect(upstream.calls).toHaveLength(1);
  });

  it('refuses to be built with both a token and a token source, or with neither', () => {
    expect(
      () =>
        new BookingHttp({
          base: BASE,
          token: TOKEN_A,
          tokenSource: createStaticSecretSource(TOKEN_A),
        })
    ).toThrow(/exactly one/);
    expect(() => new BookingHttp({ base: BASE })).toThrow(/exactly one/);
  });
});
