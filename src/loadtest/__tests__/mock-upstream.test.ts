import { afterEach, describe, expect, it } from '@jest/globals';
import {
  createUpstreamCore,
  slidingMax,
  slidingMaxHalfOpen,
  smallestGap,
  startMockUpstream,
} from '../mock-upstream.js';

// The measuring mock upstream (OPS-07 precision, D-03): it counts request
// starts from its own millisecond timestamps over closed sliding windows, so
// it does not trust the gate's own accounting.

const open: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((mock) => mock.close()));
});

async function mockWith(
  opts: Partial<Parameters<typeof startMockUpstream>[0]> = {}
): Promise<Awaited<ReturnType<typeof startMockUpstream>>> {
  const mock = await startMockUpstream({ port: 0, ...opts });
  open.push(mock);
  return mock;
}

async function get(base: string, path: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { accept: 'application/json' } });
}

describe('slidingMax', () => {
  it('counts a closed interval: five starts 250 ms apart fit in one second', () => {
    expect(slidingMax([0, 250, 500, 750, 1000], 1000)).toBe(5);
  });

  it('counts a burst that straddles a second boundary', () => {
    expect(slidingMax([0, 999, 1001], 1000)).toBe(2);
    expect(slidingMax([900, 950, 1000, 1050, 1100], 1000)).toBe(5);
  });

  it('does not depend on the input order', () => {
    expect(slidingMax([1000, 0, 750, 250, 500], 1000)).toBe(5);
  });

  it('is 0 for no starts and 1 for a lone start', () => {
    expect(slidingMax([], 1000)).toBe(0);
    expect(slidingMax([42], 60_000)).toBe(1);
  });
});

describe('slidingMaxHalfOpen', () => {
  it('counts a half-open interval: starts 500 ms apart put 2, not 3, in one second', () => {
    expect(slidingMaxHalfOpen([0, 500, 1000], 1000)).toBe(2);
    expect(slidingMax([0, 500, 1000], 1000)).toBe(3);
  });

  it('counts a start 999 ms after the first inside the window', () => {
    expect(slidingMaxHalfOpen([0, 999], 1000)).toBe(2);
  });

  it('counts 90 starts 500 ms apart plus a 91st at exactly 60,000 ms as 90 half-open and 91 closed', () => {
    const times = Array.from({ length: 90 }, (_, index) => index * 500);
    times.push(60_000);
    expect(slidingMaxHalfOpen(times, 60_000)).toBe(90);
    expect(slidingMax(times, 60_000)).toBe(91);
  });

  it('counts the 91st start at 59,999 ms inside the half-open minute', () => {
    const times = Array.from({ length: 90 }, (_, index) => index * 500);
    times.push(59_999);
    expect(slidingMaxHalfOpen(times, 60_000)).toBe(91);
  });

  it('does not depend on the input order and is 0 for no starts', () => {
    expect(slidingMaxHalfOpen([1000, 0, 500], 1000)).toBe(2);
    expect(slidingMaxHalfOpen([], 1000)).toBe(0);
    expect(slidingMaxHalfOpen([42], 60_000)).toBe(1);
  });
});

describe('smallestGap', () => {
  it('is the smallest difference between consecutive starts', () => {
    expect(smallestGap([0, 500, 1000])).toBe(500);
    expect(smallestGap([0, 499])).toBe(499);
    expect(smallestGap([0, 1000, 1499, 5000])).toBe(499);
  });

  it('does not depend on the input order', () => {
    expect(smallestGap([1000, 0, 500])).toBe(500);
  });

  it('is null for fewer than two starts', () => {
    expect(smallestGap([42])).toBeNull();
    expect(smallestGap([])).toBeNull();
  });
});

describe('startTimes', () => {
  it('returns a copy of every start the core received, refused ones included', () => {
    let now = 5_000;
    const core = createUpstreamCore(() => now);
    for (let index = 0; index < 6; index += 1) {
      core.start('GET', '/api/v1/company/722227');
    }
    now = 5_100;
    core.start('GET', '/api/v1/company/722227');
    const times = core.startTimes();
    expect(times).toEqual([5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_100]);
    // 6 starts in one millisecond: the sixth was refused and still counts.
    expect(core.stats().served429).toBeGreaterThan(0);
    times.push(1);
    expect(core.startTimes()).toHaveLength(7);
  });

  it('is returned by the HTTP mock too', async () => {
    let now = 10_000;
    const mock = await mockWith({ now: () => now });
    await get(mock.url, '/company/722227');
    now = 10_500;
    await get(mock.url, '/company/722227');
    expect(mock.startTimes()).toEqual([10_000, 10_500]);
  });
});

describe('startMockUpstream routes', () => {
  it.each([
    ['/company/722227', 200],
    ['/book_services/722227', 200],
    ['/book_staff/722227', 200],
    ['/book_dates/722227', 200],
    ['/book_times/722227/0/2026-10-05', 200],
    ['/book_times/722227/2098145/2026-10-05', 200],
  ])('serves GET %s from the fixtures', async (path, status) => {
    const mock = await mockWith();
    const res = await get(mock.url, path);
    expect(res.status).toBe(status);
    const body = (await res.json()) as { success: boolean; data: unknown };
    expect(body.success).toBe(true);
    expect(body.data).not.toBeNull();
  });

  it('serves the company card of the fixture business', async () => {
    const mock = await mockWith();
    const body = (await (await get(mock.url, '/company/722227')).json()) as {
      data: { id: number };
    };
    expect(body.data.id).toBe(722227);
  });

  it('answers POST /book_check with 201 and an empty body', async () => {
    const mock = await mockWith();
    const res = await fetch(`${mock.url}/book_check/722227`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appointments: [] }),
    });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('');
  });

  it('answers an unknown path with 404', async () => {
    const mock = await mockWith();
    expect((await get(mock.url, '/nothing/here')).status).toBe(404);
  });
});

describe('startMockUpstream measurement', () => {
  it('records every start and serves 429 itself above 5 per 1,000 ms (closed interval)', async () => {
    let now = 10_000;
    const mock = await mockWith({ now: () => now });
    for (let index = 0; index < 5; index += 1) {
      expect((await get(mock.url, '/company/722227')).status).toBe(200);
    }
    // Same millisecond: the sixth start would make six in one second.
    const sixth = await get(mock.url, '/company/722227');
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('x-rate-limit-reset')).not.toBeNull();
    // Exactly 1,000 ms after the first five: the closed interval still holds them.
    now = 11_000;
    expect((await get(mock.url, '/company/722227')).status).toBe(429);
    // One millisecond later they have left the window.
    now = 11_001;
    expect((await get(mock.url, '/company/722227')).status).toBe(200);

    const stats = mock.stats();
    expect(stats.starts).toBe(8);
    expect(stats.served429).toBe(2);
    // The refused starts count too: the sender attempted them.
    expect(stats.max1s).toBe(7);
  });

  it('serves 429 above 200 per 60,000 ms and reports the 60 s maximum', async () => {
    let now = 0;
    const mock = await mockWith({ now: () => now });
    for (let index = 0; index < 200; index += 1) {
      now = index * 300;
      expect((await get(mock.url, '/book_dates/722227')).status).toBe(200);
    }
    now = 60_000;
    expect((await get(mock.url, '/book_dates/722227')).status).toBe(429);
    now = 60_001;
    expect((await get(mock.url, '/book_dates/722227')).status).toBe(200);

    const stats = mock.stats();
    expect(stats.served429).toBe(1);
    expect(stats.max60s).toBe(201);
    // 300 ms spacing keeps every second under the 1 s limit; only the minute tripped.
    expect(stats.max1s).toBeLessThanOrEqual(5);
  });

  it('reports no starts and no 429 before any request', async () => {
    const mock = await mockWith();
    expect(mock.stats()).toEqual({
      max1s: 0,
      max60s: 0,
      served429: 0,
      starts: 0,
      aborted: 0,
    });
  });
});

describe('startMockUpstream stalls and aborts', () => {
  it('holds a stalled route for its stall time', async () => {
    const mock = await mockWith({ stallMs: { company: 200 } });
    const began = Date.now();
    const res = await get(mock.url, '/company/722227');
    expect(res.status).toBe(200);
    expect(Date.now() - began).toBeGreaterThanOrEqual(180);
  });

  it('counts a request the client abandons before the reply as aborted', async () => {
    const mock = await mockWith({ stallMs: { book_dates: 10_000 } });
    const controller = new AbortController();
    const aborted = fetch(`${mock.url}/book_dates/722227`, {
      signal: controller.signal,
    }).catch((error: unknown) => error);
    setTimeout(() => controller.abort(), 100);
    await aborted;

    const deadline = Date.now() + 3000;
    while (mock.stats().aborted < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(mock.stats().aborted).toBeGreaterThanOrEqual(1);
    // The abandoned request is one start and is not started again.
    expect(mock.stats().starts).toBe(1);
  });
});
