import { describe, expect, it } from '@jest/globals';
import { BookingClient } from '../client.js';
import { UpstreamError } from '../errors.js';
import {
  createInstallationGate,
  INSTALLATION_CACHE_TTL_MS,
  INSTALLATION_UNKNOWN_TTL_MS,
} from '../installation.js';
import { fakeFetch, type FakeReply } from './helpers/fake-fetch.js';

// The assistant-booking gate (ADR 0006, D3 amended 2026-10-27): the Hub read
// on the app host, its 404 as "not installed", the verdicts per status, the
// per-location cache both ways, and a Hub that cannot answer leaving the
// business open.

const API_BASE = 'https://api.alteg.io/api/v1';
const APP_BASE = 'https://app.example.test';
const PARTNER_TOKEN = 'partner-token-0123456789abcdef';
const LOCATION = 722227;
const APPLICATION = 2642;
const PATH = `/marketplace/salon/${LOCATION}/application/${APPLICATION}`;

function statusReply(status: 'pending' | 'freezed' | 'active'): FakeReply {
  return {
    status: 200,
    body: {
      success: true,
      data: {
        connection_status: {
          marketplace_application_id: APPLICATION,
          salon_id: LOCATION,
          status,
        },
        logs: [],
        payments: [],
      },
      meta: [],
    },
  };
}

const NOT_INSTALLED: FakeReply = {
  status: 404,
  body: { success: false, meta: { message: 'An error occurred' } },
};

function client(reply: FakeReply, options: { appBase?: string } = {}) {
  const upstream = fakeFetch([{ method: 'GET', path: PATH, reply }]);
  const booking = new BookingClient({
    base: API_BASE,
    appBase: options.appBase,
    token: PARTNER_TOKEN,
    fetch: upstream.fetch,
  });
  return { upstream, booking };
}

describe('BookingClient.installationStatus', () => {
  it('reads the status on the app host with the server token and no user token', async () => {
    const { upstream, booking } = client(statusReply('active'), {
      appBase: APP_BASE,
    });
    await expect(
      booking.installationStatus(LOCATION, APPLICATION, {
        signal: new AbortController().signal,
      })
    ).resolves.toBe('active');
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0];
    expect(call?.url.origin).toBe(APP_BASE);
    expect(call?.url.pathname).toBe(PATH);
    expect(call?.headers.get('authorization')).toBe(`Bearer ${PARTNER_TOKEN}`);
    expect(call?.headers.get('accept')).toBe('application/vnd.api.v2+json');
  });

  it('defaults the app host to https://app.alteg.io', async () => {
    const { upstream, booking } = client(statusReply('pending'));
    await expect(
      booking.installationStatus(LOCATION, APPLICATION)
    ).resolves.toBe('pending');
    expect(upstream.calls[0]?.url.origin).toBe('https://app.alteg.io');
  });

  it('reads a 404 as none, the answer for a removed application and a never-installed one alike', async () => {
    const { booking } = client(NOT_INSTALLED);
    await expect(
      booking.installationStatus(LOCATION, APPLICATION)
    ).resolves.toBe('none');
  });

  it('throws every other failure as an UpstreamError', async () => {
    const { booking } = client({ status: 503, body: '' });
    await expect(
      booking.installationStatus(LOCATION, APPLICATION)
    ).rejects.toMatchObject({ kind: 'unavailable' });
    const drift = client({
      status: 200,
      body: { success: true, data: { connection_status: { status: 'odd' } } },
    });
    await expect(
      drift.booking.installationStatus(LOCATION, APPLICATION)
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it('rejects a non-positive location or application id before any call', async () => {
    const { upstream, booking } = client(statusReply('active'));
    await expect(booking.installationStatus(0, APPLICATION)).rejects.toThrow(
      TypeError
    );
    await expect(booking.installationStatus(LOCATION, -1)).rejects.toThrow(
      TypeError
    );
    expect(upstream.calls).toHaveLength(0);
  });
});

describe('createInstallationGate', () => {
  function gate(
    answers: Array<'pending' | 'freezed' | 'active' | 'none' | Error>,
    options: { ttlMs?: number; unknownTtlMs?: number; maxEntries?: number } = {}
  ) {
    let clock = 1_000;
    const asked: number[] = [];
    const unavailable: number[] = [];
    const booking = {
      installationStatus: (locationId: number) => {
        asked.push(locationId);
        const next = answers.shift();
        if (next === undefined) {
          return Promise.reject(new Error('no answer scripted'));
        }
        return next instanceof Error
          ? Promise.reject(next)
          : Promise.resolve(next);
      },
    };
    const made = createInstallationGate({
      booking,
      applicationId: APPLICATION,
      now: () => clock,
      onUnavailable: (locationId) => {
        unavailable.push(locationId);
      },
      ...options,
    });
    return {
      made,
      asked,
      unavailable,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it.each([
    ['active', 'accepts'],
    ['pending', 'accepts'],
    ['freezed', 'declines'],
    ['none', 'declines'],
  ] as const)('reads %s as %s', async (status, verdict) => {
    const { made } = gate([status]);
    await expect(made.verdict(LOCATION)).resolves.toBe(verdict);
  });

  it('asks the Hub once per location within the cache life, both ways', async () => {
    const { made, asked, advance } = gate(['active', 'none', 'none', 'active']);
    await expect(made.verdict(LOCATION)).resolves.toBe('accepts');
    await expect(made.verdict(LOCATION)).resolves.toBe('accepts');
    await expect(made.verdict(731000)).resolves.toBe('declines');
    await expect(made.verdict(731000)).resolves.toBe('declines');
    expect(asked).toEqual([LOCATION, 731000]);
    advance(INSTALLATION_CACHE_TTL_MS + 1);
    await expect(made.verdict(LOCATION)).resolves.toBe('declines');
    await expect(made.verdict(731000)).resolves.toBe('accepts');
    expect(asked).toEqual([LOCATION, 731000, LOCATION, 731000]);
  });

  it('shares one Hub call between callers that ask at the same time', async () => {
    const { made, asked } = gate(['active']);
    const verdicts = await Promise.all([
      made.verdict(LOCATION),
      made.verdict(LOCATION),
      made.verdict(LOCATION),
    ]);
    expect(verdicts).toEqual(['accepts', 'accepts', 'accepts']);
    expect(asked).toEqual([LOCATION]);
  });

  it('answers unknown when the Hub cannot say, reports it once, and asks again sooner', async () => {
    const { made, asked, unavailable, advance } = gate([
      new Error('upstream down'),
      'active',
    ]);
    await expect(made.verdict(LOCATION)).resolves.toBe('unknown');
    await expect(made.verdict(LOCATION)).resolves.toBe('unknown');
    expect(unavailable).toEqual([LOCATION]);
    advance(INSTALLATION_UNKNOWN_TTL_MS + 1);
    await expect(made.verdict(LOCATION)).resolves.toBe('accepts');
    expect(asked).toEqual([LOCATION, LOCATION]);
  });

  it('drops the oldest entry when the cache is full', async () => {
    const { made, asked } = gate(['active', 'active', 'active', 'none'], {
      maxEntries: 2,
    });
    await made.verdict(1);
    await made.verdict(2);
    await made.verdict(3);
    // 1 was evicted, so it is asked again and now declines.
    await expect(made.verdict(1)).resolves.toBe('declines');
    expect(asked).toEqual([1, 2, 3, 1]);
  });

  it('refuses an application id that is not a positive integer', () => {
    expect(() =>
      createInstallationGate({
        booking: {
          installationStatus: () => Promise.resolve('active' as const),
        },
        applicationId: 0,
      })
    ).toThrow(/positive integer/);
  });
});
