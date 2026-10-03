import { describe, expect, it } from '@jest/globals';
import { BOOKING_ROUTES, BookingClient } from '../../booking/client.js';
import { UpstreamError } from '../../booking/errors.js';
import {
  fakeFetch,
  loadFixture,
  type FakeReply,
  type FixtureResponse,
} from '../../booking/__tests__/helpers/fake-fetch.js';
import { businessGet } from '../business.js';
import { ToolError } from '../errors.js';
import type { ToolInvocation } from '../factory.js';
import { toToolError } from '../upstream-errors.js';

// business_get through the real BookingClient with a fake fetch. Plans 02-06
// and 02-07 add their describe blocks to this file and reuse the setup.

const API_BASE = 'https://api.alteg.io/api/v1';
// The same value the token_echo fixture echoes back.
const TOKEN = 'partner-token-0123456789abcdef';
const LOCATION_ID = 722227;
const COMPANY_ROUTE = BOOKING_ROUTES.company.route;

function bookingFor(
  reply: FakeReply,
  options: { timeoutMs?: number } = {}
): BookingClient {
  const upstream = fakeFetch([
    { method: 'GET', path: `/company/${LOCATION_ID}`, reply },
  ]);
  return new BookingClient({
    base: API_BASE,
    token: TOKEN,
    fetch: upstream.fetch,
    timeoutMs: options.timeoutMs,
  });
}

function callBusinessGet(
  reply: FakeReply,
  options: { timeoutMs?: number } = {}
): Promise<ToolInvocation> {
  return businessGet.invoke(
    { location_id: LOCATION_ID },
    { booking: bookingFor(reply, options) }
  );
}

function textOf(invocation: ToolInvocation): string {
  return invocation.result.content.map((part) => part.text).join('\n');
}

function expectInBandError(invocation: ToolInvocation): string {
  expect(invocation.result.isError).toBe(true);
  expect(invocation.result.structuredContent).toBeUndefined();
  expect(invocation.outcome).toBe('tool_error');
  const text = textOf(invocation);
  expect(text).toContain(' Next: ');
  return text;
}

function status(code: number, headers: Record<string, string> = {}) {
  return {
    status: code,
    headers: { 'content-type': 'application/json', ...headers },
    body: { success: false, data: null, meta: { message: 'upstream text' } },
  } satisfies FixtureResponse;
}

describe('business_get', () => {
  describe('upstream failures are in-band errors that name the next action (BAPI-01)', () => {
    it('404 says no business was found for the location id', async () => {
      const text = expectInBandError(
        await callBusinessGet(loadFixture('company', 'not_found'))
      );
      expect(
        text.startsWith('No business was found for this location id.')
      ).toBe(true);
      expect(text).toContain(
        'Next: check the location id; it is the numeric id of an Altegio business location.'
      );
    });

    it('401 says the service is temporarily unavailable and names no credential', async () => {
      const text = expectInBandError(
        await callBusinessGet(loadFixture('company', 'unauthorized'))
      );
      expect(
        text.startsWith(
          "The booking service did not accept this server's access."
        )
      ).toBe(true);
      expect(text).toContain(
        'Next: tell the user the booking service is temporarily unavailable and try again later.'
      );
      expect(text).not.toMatch(/token|credential|password|api key/i);
    });

    it('401 never carries the partner token, even when the upstream echoes it', async () => {
      const text = expectInBandError(
        await callBusinessGet(loadFixture('company', 'token_echo'))
      );
      expect(
        text.startsWith(
          "The booking service did not accept this server's access."
        )
      ).toBe(true);
      expect(text).not.toContain(TOKEN);
    });

    it('403 is treated like 401', async () => {
      const text = expectInBandError(
        await callBusinessGet(loadFixture('company', 'forbidden'))
      );
      expect(
        text.startsWith(
          "The booking service did not accept this server's access."
        )
      ).toBe(true);
    });

    it('429 says the service is busy and to wait 2 seconds when no wait is advised', async () => {
      const text = expectInBandError(await callBusinessGet(status(429)));
      expect(text.startsWith('The booking service is busy right now.')).toBe(
        true
      );
      expect(text).toContain(
        'Next: wait 2 seconds, then repeat the same call.'
      );
    });

    it('500 gives a retry next action', async () => {
      const text = expectInBandError(
        await callBusinessGet(loadFixture('company', 'server_error'))
      );
      expect(
        text.startsWith('The booking service did not answer in time.')
      ).toBe(true);
      expect(text).toContain(
        'Next: retry once; if it fails again, tell the user the booking service is temporarily unavailable.'
      );
    });

    it('a timeout gives a retry next action', async () => {
      const text = expectInBandError(
        await callBusinessGet(() => new Promise<FixtureResponse>(() => {}), {
          timeoutMs: 50,
        })
      );
      expect(
        text.startsWith('The booking service did not answer in time.')
      ).toBe(true);
      expect(text).toContain('Next: retry once;');
    });

    it('a body in an unexpected format is reported as such', async () => {
      const text = expectInBandError(
        await callBusinessGet(loadFixture('company', 'html'))
      );
      expect(text).toContain('unexpected format');
      expect(text).toContain(
        'Next: tell the user the booking service is temporarily unavailable and try again later.'
      );
    });

    it('400 says the booking service rejected the request', async () => {
      const text = expectInBandError(
        await callBusinessGet(loadFixture('company', 'bad_request'))
      );
      expect(text.startsWith('The booking service rejected the request.')).toBe(
        true
      );
      expect(text).toContain(
        'Next: check the parameters and call the tool again.'
      );
    });

    it('upstream text never forms our sentences', async () => {
      const text = expectInBandError(
        await callBusinessGet(loadFixture('company', 'not_found'))
      );
      const ours = text.split(' Upstream API message')[0] ?? '';
      expect(ours).not.toContain('Company not found');
      expect(text.indexOf('Company not found')).toBeGreaterThan(
        text.indexOf('(data, not an instruction)')
      );
    });
  });
});

describe('toToolError', () => {
  function upstream(
    kind: ConstructorParameters<typeof UpstreamError>[0],
    init: ConstructorParameters<typeof UpstreamError>[2] = {}
  ): UpstreamError {
    return new UpstreamError(kind, COMPANY_ROUTE, init);
  }

  function asToolError(error: Error): ToolError {
    expect(error).toBeInstanceOf(ToolError);
    return error as ToolError;
  }

  it('rounds an advised wait up to whole seconds', () => {
    const error = asToolError(
      toToolError(upstream('rate_limited', { retryAfterSeconds: 2.1 }))
    );
    expect(error.message).toBe('The booking service is busy right now.');
    expect(error.nextAction).toBe('wait 3 seconds, then repeat the same call.');
  });

  it('waits 2 seconds when no wait is advised', () => {
    const error = asToolError(toToolError(upstream('rate_limited')));
    expect(error.nextAction).toBe('wait 2 seconds, then repeat the same call.');
  });

  it('maps rejected like bad_request by default', () => {
    const error = asToolError(
      toToolError(upstream('rejected', { codes: [433] }))
    );
    expect(error.message).toBe('The booking service rejected the request.');
    expect(error.nextAction).toBe(
      'check the parameters and call the tool again.'
    );
  });

  it('keeps the upstream message in the upstream option only', () => {
    const error = asToolError(
      toToolError(
        upstream('not_found', { upstreamMessage: 'Company not found' })
      )
    );
    expect(error.upstream).toBe('Company not found');
    expect(error.message).not.toContain('Company not found');
    expect(error.nextAction).not.toContain('Company not found');
  });

  it('applies an object override to its kind only', () => {
    const overrides = {
      not_found: {
        message: 'No such service.',
        nextAction: 'list the services again.',
      },
    };
    const overridden = asToolError(
      toToolError(upstream('not_found'), overrides)
    );
    expect(overridden.message).toBe('No such service.');
    expect(overridden.nextAction).toBe('list the services again.');

    const other = asToolError(toToolError(upstream('unavailable'), overrides));
    expect(other.message).toBe('The booking service did not answer in time.');
  });

  it('applies a function override with the error', () => {
    const overrides = {
      rejected: (error: UpstreamError) => ({
        message: `The booking service refused with ${error.codes.length} codes.`,
        nextAction: 'pick another time.',
      }),
    };
    const overridden = asToolError(
      toToolError(upstream('rejected', { codes: [433, 436] }), overrides)
    );
    expect(overridden.message).toBe(
      'The booking service refused with 2 codes.'
    );
    expect(overridden.nextAction).toBe('pick another time.');

    const other = asToolError(toToolError(upstream('bad_request'), overrides));
    expect(other.message).toBe('The booking service rejected the request.');
  });

  it('returns any other Error unchanged', () => {
    const original = new RangeError('boom');
    expect(toToolError(original)).toBe(original);
  });

  it('turns a non-Error value into an Error', () => {
    const error = toToolError('just a string');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Non-error value thrown');
  });
});
