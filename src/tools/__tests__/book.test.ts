import { describe, expect, it } from '@jest/globals';
import { BOOKING_ROUTES, BookingClient } from '../../booking/client.js';
import {
  fakeFetch,
  loadFixture,
  type FakeFetch,
  type FakeReply,
  type FixtureResponse,
} from '../../booking/__tests__/helpers/fake-fetch.js';
import { businessGet } from '../business.js';
import {
  CONFIRMATION_STATEMENT,
  NOTE_NAMES_UNAVAILABLE,
  NOTE_PREPAYMENT,
  NOTE_REPEAT_SELECTION,
  NOTE_UNVERIFIED,
  bookCheck,
} from '../book.js';
import type { ToolInvocation } from '../factory.js';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '../untrusted.js';

// book_check through the real BookingClient with a fake fetch: the verified
// statement, every fallback (plain link or no link), the error branches by
// numeric code, the input guards and the no-personal-data checks.

type BookCheckOut = {
  status: 'verified' | 'unverified';
  link: { url: string; kind: 'preselected' | 'booking_form' };
  business: { location_id: number; name: string | null };
  selection: {
    services: {
      id: number;
      title: string | null;
      price: { min: number; max: number; currency: string | null } | null;
      prepayment: string;
    }[];
    team_member: { id: number; name: string | null } | null;
    date: string;
    time: string;
    utc_offset: string;
    time_zone: string | null;
  };
  notes: string[];
  confirmation: string;
};

const API_BASE = 'https://api.alteg.io/api/v1';
const TOKEN = 'partner-token-0123456789abcdef';
const LOCATION_ID = 722227;
const CHECK_PATH = `/book_check/${LOCATION_ID}`;
const COMPANY_PATH = `/company/${LOCATION_ID}`;
const SERVICES_PATH = `/book_services/${LOCATION_ID}`;
const STAFF_PATH = `/book_staff/${LOCATION_ID}`;
const SLOT = '2026-10-05T14:00:00+03:00';
const ANNA = 2098145;
const FORM_ORIGIN = 'https://n1463903.alteg.io';
const URL_PATTERN = /https?:\/\//;

interface Replies {
  check?: FakeReply;
  company?: FakeReply;
  services?: FakeReply;
  staff?: FakeReply;
}

function setup(
  replies: Replies = {},
  options: { timeoutMs?: number } = {}
): {
  upstream: FakeFetch;
  invoke: (args: Record<string, unknown>) => Promise<ToolInvocation>;
} {
  const upstream = fakeFetch([
    {
      method: 'POST',
      path: CHECK_PATH,
      reply: replies.check ?? loadFixture('book_check', 'created_empty'),
    },
    {
      method: 'GET',
      path: COMPANY_PATH,
      reply: replies.company ?? loadFixture('company', 'default'),
    },
    {
      method: 'GET',
      path: SERVICES_PATH,
      reply: replies.services ?? loadFixture('book_services', 'default'),
    },
    {
      method: 'GET',
      path: STAFF_PATH,
      reply: replies.staff ?? loadFixture('book_staff', 'default'),
    },
  ]);
  const booking = new BookingClient({
    base: API_BASE,
    token: TOKEN,
    fetch: upstream.fetch,
    timeoutMs: options.timeoutMs,
  });
  return { upstream, invoke: (args) => bookCheck.invoke(args, { booking }) };
}

function textOf(invocation: ToolInvocation): string {
  return invocation.result.content.map((part) => part.text).join('\n');
}

function okOutput(invocation: ToolInvocation): BookCheckOut {
  expect(invocation.result.isError).toBeUndefined();
  expect(invocation.outcome).toBe('ok');
  return invocation.result.structuredContent as BookCheckOut;
}

function expectNoLinkError(invocation: ToolInvocation): string {
  expect(invocation.result.isError).toBe(true);
  expect(invocation.result.structuredContent).toBeUndefined();
  expect(invocation.outcome).toBe('tool_error');
  const text = textOf(invocation);
  expect(text).toContain(' Next: ');
  expect(text).not.toMatch(URL_PATTERN);
  return text;
}

function paths(upstream: FakeFetch): string[] {
  return upstream.calls.map(
    (call) => `${call.method} ${call.url.pathname.replace('/api/v1', '')}`
  );
}

function companyWith(patch: Record<string, unknown>): FixtureResponse {
  const fixture = loadFixture('company', 'default');
  const body = structuredClone(fixture.body) as {
    data: Record<string, unknown>;
  };
  Object.assign(body.data, patch);
  return { ...fixture, body };
}

/** The default services plus three more, so ten distinct ids exist. */
function tenServices(): FixtureResponse {
  const fixture = loadFixture('book_services', 'default');
  const body = structuredClone(fixture.body) as {
    data: { services: Record<string, unknown>[] };
  };
  for (const id of [10303537, 10303538, 10303539]) {
    body.data.services.push({
      id,
      title: `Extra ${id}`,
      category_id: 7,
      price_min: 100,
      price_max: 100,
      active: 1,
      prepaid: 'forbidden',
      seance_length: null,
    });
  }
  return { ...fixture, body };
}

function serverError(): FixtureResponse {
  return {
    status: 500,
    headers: { 'content-type': 'application/json' },
    body: { success: false, data: null, meta: { message: 'Server error' } },
  };
}

describe('book_check statement after a 201 (BOOK-01, BOOK-03)', () => {
  it('statement: returns a verified pre-selected link and the selection read from the API', async () => {
    const { invoke } = setup();
    const out = okOutput(
      await invoke({
        location_id: LOCATION_ID,
        service_ids: [10303530],
        team_member_id: ANNA,
        datetime: SLOT,
      })
    );
    expect(out).toEqual({
      status: 'verified',
      link: {
        kind: 'preselected',
        url: 'https://n1463903.alteg.io/company/722227?o=m2098145s10303530d2605101400',
      },
      business: { location_id: LOCATION_ID, name: 'Demo Beauty Studio' },
      selection: {
        services: [
          {
            id: 10303530,
            title: "Women's haircut",
            price: null,
            prepayment: 'not_offered',
          },
        ],
        team_member: { id: ANNA, name: 'Anna Smith' },
        date: '2026-10-05',
        time: '14:00',
        utc_offset: '+03:00',
        time_zone: 'Asia/Nicosia',
      },
      notes: [NOTE_PREPAYMENT],
      confirmation: CONFIRMATION_STATEMENT,
    });
  });

  it('statement: the text carries the link, ids, local time and confirmation, with business text only inside the UNTRUSTED block', async () => {
    const { invoke } = setup();
    const result = await invoke({
      location_id: LOCATION_ID,
      service_ids: [10303531],
      team_member_id: ANNA,
      datetime: SLOT,
    });
    const text = textOf(result);
    expect(text).toContain(
      'https://n1463903.alteg.io/company/722227?o=m2098145s10303531d2605101400'
    );
    expect(text).toContain('Verified: location 722227');
    expect(text).toContain('- service 10303531: price 1500');
    expect(text).toContain(`team member ${ANNA}`);
    expect(text).toContain('2026-10-05 at 14:00 (UTC+03:00');
    expect(text).toContain(NOTE_PREPAYMENT);
    expect(text).toContain(CONFIRMATION_STATEMENT);

    const open = text.indexOf(UNTRUSTED_OPEN);
    const close = text.indexOf(UNTRUSTED_CLOSE);
    expect(open).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(open);
    const ours = text.slice(0, open);
    const block = text.slice(open, close);
    for (const businessText of [
      'Demo Beauty Studio',
      'Manicure',
      'Anna Smith',
      'Asia/Nicosia',
      'EUR',
    ]) {
      expect(ours).not.toContain(businessText);
      expect(block).toContain(businessText);
    }
  });

  it('statement: checks first, then reads the card, the services and the team members once each', async () => {
    const { invoke, upstream } = setup();
    okOutput(
      await invoke({
        location_id: LOCATION_ID,
        service_ids: [10303530],
        team_member_id: ANNA,
        datetime: SLOT,
      })
    );
    expect(upstream.unmatched).toEqual([]);
    const seen = paths(upstream);
    expect(seen[0]).toBe(`POST ${CHECK_PATH}`);
    expect(seen.slice(1).sort()).toEqual(
      [
        `GET ${COMPANY_PATH}`,
        `GET ${SERVICES_PATH}`,
        `GET ${STAFF_PATH}`,
      ].sort()
    );
    // The catalog and the team list are read unfiltered.
    const reads = upstream.calls.filter((call) =>
      [SERVICES_PATH, STAFF_PATH].some((path) =>
        call.url.pathname.endsWith(path)
      )
    );
    for (const call of reads) expect(call.url.search).toBe('');
  });

  it('statement: any team member with two services gives m-1, both services in input order, and reads no team member', async () => {
    const { invoke, upstream } = setup();
    const result = await invoke({
      location_id: LOCATION_ID,
      service_ids: [10303531, 10303530],
      datetime: SLOT,
    });
    const out = okOutput(result);
    expect(out.link).toEqual({
      kind: 'preselected',
      url: `${FORM_ORIGIN}/company/722227?o=m-1s10303531s10303530d2605101400`,
    });
    expect(out.selection.team_member).toBeNull();
    expect(out.selection.services.map((service) => service.id)).toEqual([
      10303531, 10303530,
    ]);
    expect(paths(upstream)).not.toContain(`GET ${STAFF_PATH}`);
    expect(JSON.parse(upstream.calls[0]?.body ?? 'null')).toEqual({
      appointments: [
        { id: 1, services: [10303531, 10303530], staff_id: 0, datetime: SLOT },
      ],
    });
    const text = textOf(result);
    expect(text).toContain('Team member: any team member.');
    // Ordering (edge BOOK-03): the lines follow the input order.
    expect(text.indexOf('- service 10303531')).toBeLessThan(
      text.indexOf('- service 10303530')
    );
  });

  it('statement: two services that share a title are stated separately by id (edge BOOK-03 adjacency)', async () => {
    const { invoke } = setup();
    const result = await invoke({
      location_id: LOCATION_ID,
      service_ids: [10303534, 10303535],
      datetime: SLOT,
    });
    const out = okOutput(result);
    expect(out.selection.services).toEqual([
      {
        id: 10303534,
        title: 'Consultation',
        price: { min: 500, max: 500, currency: 'EUR' },
        prepayment: 'not_offered',
      },
      {
        id: 10303535,
        title: 'Consultation',
        price: { min: 700, max: 700, currency: 'EUR' },
        prepayment: 'not_offered',
      },
    ]);
    const text = textOf(result);
    expect(text).toContain('- service 10303534: price 500');
    expect(text).toContain('- service 10303535: price 700');
    expect(text).toContain('service 10303534: Consultation');
    expect(text).toContain('service 10303535: Consultation');
  });

  it('statement: no price set is price on request and 12.5 stays 12.5 (edge BOOK-03 empty, precision)', async () => {
    const { invoke } = setup();
    const result = await invoke({
      location_id: LOCATION_ID,
      service_ids: [10303530, 10303536],
      datetime: SLOT,
    });
    const out = okOutput(result);
    expect(out.selection.services[0]?.price).toBeNull();
    expect(out.selection.services[1]?.price).toEqual({
      min: 12.5,
      max: 12.5,
      currency: 'EUR',
    });
    const text = textOf(result);
    expect(text).toContain('- service 10303530: price on request');
    expect(text).toContain('- service 10303536: price 12.5,');
  });

  it('statement: states a price range and the prepayment wording', async () => {
    const { invoke } = setup();
    const result = await invoke({
      location_id: LOCATION_ID,
      service_ids: [10303532, 10303533],
      datetime: SLOT,
    });
    const out = okOutput(result);
    expect(out.selection.services.map((service) => service.prepayment)).toEqual(
      ['required', 'optional']
    );
    const text = textOf(result);
    expect(text).toContain(
      '- service 10303532: price 2000 to 4500, prepayment required.'
    );
    expect(text).toContain('prepayment optional');
  });

  it('statement: accepts exactly 10 services and states and links every one in order (edge BOOK-03 boundary)', async () => {
    const ids = [
      10303539, 10303530, 10303531, 10303532, 10303533, 10303534, 10303535,
      10303536, 10303537, 10303538,
    ];
    const { invoke } = setup({ services: tenServices() });
    const result = await invoke({
      location_id: LOCATION_ID,
      service_ids: ids,
      datetime: SLOT,
    });
    const out = okOutput(result);
    expect(out.selection.services.map((service) => service.id)).toEqual(ids);
    expect(out.link.url).toBe(
      `${FORM_ORIGIN}/company/722227?o=m-1${ids.map((id) => `s${id}`).join('')}d2605101400`
    );
    const text = textOf(result);
    for (const id of ids) expect(text).toContain(`- service ${id}:`);
  });

  it("statement: states HH:MM from the digits and passes '+0300' through unchanged (edge BOOK-01 encoding, BOOK-03 precision)", async () => {
    const { invoke, upstream } = setup();
    const datetime = '2026-10-05T23:30:00+0300';
    const out = okOutput(
      await invoke({
        location_id: LOCATION_ID,
        service_ids: [10303530],
        team_member_id: ANNA,
        datetime,
      })
    );
    expect(upstream.calls[0]?.body).toContain(`"datetime":"${datetime}"`);
    expect(out.selection.date).toBe('2026-10-05');
    expect(out.selection.time).toBe('23:30');
    expect(out.selection.utc_offset).toBe('+03:00');
    expect(out.link.url).toBe(
      `${FORM_ORIGIN}/company/722227?o=m2098145s10303530d2605102330`
    );
  });

  it('statement: a 201 with a JSON envelope is verified too', async () => {
    const { invoke } = setup({
      check: loadFixture('book_check', 'created_json'),
    });
    const out = okOutput(
      await invoke({
        location_id: LOCATION_ID,
        service_ids: [10303530],
        datetime: SLOT,
      })
    );
    expect(out.status).toBe('verified');
  });
});

describe('book_check fallbacks (BOOK-05, D-06)', () => {
  it("fallback: a card offset that differs from the slot's gives the plain form link and the repeat note", async () => {
    const { invoke } = setup({ company: companyWith({ timezone: 2 }) });
    const result = await invoke({
      location_id: LOCATION_ID,
      service_ids: [10303530],
      team_member_id: ANNA,
      datetime: SLOT,
    });
    const out = okOutput(result);
    expect(out.status).toBe('verified');
    expect(out.link).toEqual({
      kind: 'booking_form',
      url: `${FORM_ORIGIN}/company/722227`,
    });
    expect(out.notes).toContain(NOTE_REPEAT_SELECTION);
    expect(out.notes).toContain(NOTE_PREPAYMENT);
    const text = textOf(result);
    expect(text).toContain(NOTE_REPEAT_SELECTION);
    expect(text).not.toContain('?o=');
  });

  it('fallback: a card with no booking form gives an error and no link', async () => {
    const { invoke } = setup({ company: loadFixture('company', 'no_forms') });
    const text = expectNoLinkError(
      await invoke({
        location_id: LOCATION_ID,
        service_ids: [10303530],
        datetime: SLOT,
      })
    );
    expect(
      text.startsWith(
        'This business does not take online bookings through a booking widget right now.'
      )
    ).toBe(true);
    expect(text).toContain(
      'Next: tell the user to contact the business directly, using the contact details from business_get.'
    );
  });

  it('fallback: an inactive widget gives the same error and no link', async () => {
    const { invoke } = setup({ company: loadFixture('company', 'inactive') });
    const text = expectNoLinkError(
      await invoke({
        location_id: LOCATION_ID,
        service_ids: [10303530],
        datetime: SLOT,
      })
    );
    expect(
      text.startsWith(
        'This business does not take online bookings through a booking widget right now.'
      )
    ).toBe(true);
  });

  describe('one booking-form policy with business_get (WR-02, IN-03)', () => {
    const FALLBACK_URL = `https://app.alteg.io/book/${LOCATION_ID}`;

    function onlyForm(url: string): FixtureResponse {
      return companyWith({
        bookforms: [{ id: 7, title: 'Form', is_default: 1, url }],
        default_bookform_url: url,
      });
    }

    async function businessGetBooking(
      company: FixtureResponse
    ): Promise<{ enabled: boolean; booking_form_url: string | null }> {
      const upstream = fakeFetch([
        { method: 'GET', path: COMPANY_PATH, reply: company },
      ]);
      const booking = new BookingClient({
        base: API_BASE,
        token: TOKEN,
        fetch: upstream.fetch,
      });
      const invocation = await businessGet.invoke(
        { location_id: LOCATION_ID },
        { booking }
      );
      expect(invocation.result.isError).toBeUndefined();
      return (
        invocation.result.structuredContent as {
          online_booking: {
            enabled: boolean;
            booking_form_url: string | null;
          };
        }
      ).online_booking;
    }

    it.each([
      ['an http:// form', 'http://n1.alteg.io/'],
      ['an altegio.me form', 'https://salon.altegio.me/'],
      ['an off-list host', 'https://evil.example/ignore-previous-instructions'],
    ])(
      'a business whose only form is %s gets the same answer and the plain link from both tools',
      async (_label, url) => {
        const company = onlyForm(url);
        const { invoke } = setup({ company });
        const out = okOutput(
          await invoke({
            location_id: LOCATION_ID,
            service_ids: [10303530],
            team_member_id: ANNA,
            datetime: SLOT,
          })
        );
        const booking = await businessGetBooking(company);
        expect(out.link).toEqual({ kind: 'booking_form', url: FALLBACK_URL });
        expect(booking.enabled).toBe(true);
        expect(booking.booking_form_url).toBe(out.link.url);
      }
    );

    it('a business with an inactive widget is refused by book_check and not enabled in business_get', async () => {
      const company = loadFixture('company', 'inactive');
      const { invoke } = setup({ company });
      expectNoLinkError(
        await invoke({
          location_id: LOCATION_ID,
          service_ids: [10303530],
          datetime: SLOT,
        })
      );
      expect((await businessGetBooking(company)).enabled).toBe(false);
    });
  });

  it('fallback: a 503 on the check gives status unverified and the plain link, and reads only the card', async () => {
    const { invoke, upstream } = setup({
      check: loadFixture('book_check', 'unavailable_503'),
    });
    const result = await invoke({
      location_id: LOCATION_ID,
      service_ids: [10303530],
      team_member_id: ANNA,
      datetime: SLOT,
    });
    const out = okOutput(result);
    expect(out.status).toBe('unverified');
    expect(out.link).toEqual({
      kind: 'booking_form',
      url: `${FORM_ORIGIN}/company/722227`,
    });
    expect(out.notes).toEqual(
      expect.arrayContaining([NOTE_UNVERIFIED, NOTE_REPEAT_SELECTION])
    );
    expect(paths(upstream)).toEqual([
      `POST ${CHECK_PATH}`,
      `GET ${COMPANY_PATH}`,
    ]);
    const text = textOf(result);
    expect(text.startsWith('Not verified:')).toBe(true);
    expect(text).not.toContain('Verified:');
    expect(text).toContain(NOTE_UNVERIFIED);
  });

  it('fallback: a 200 on the check (only 201 means bookable) is unverified', async () => {
    const { invoke } = setup({ check: loadFixture('book_check', 'ok_200') });
    const out = okOutput(
      await invoke({
        location_id: LOCATION_ID,
        service_ids: [10303530],
        datetime: SLOT,
      })
    );
    expect(out.status).toBe('unverified');
    expect(out.link.kind).toBe('booking_form');
  });

  it('fallback: a timeout on the check is unverified', async () => {
    const { invoke } = setup(
      { check: () => new Promise<FixtureResponse>(() => undefined) },
      { timeoutMs: 20 }
    );
    const out = okOutput(
      await invoke({
        location_id: LOCATION_ID,
        service_ids: [10303530],
        datetime: SLOT,
      })
    );
    expect(out.status).toBe('unverified');
  });

  it('fallback: an inconclusive check whose card read fails reports the check failure without a link', async () => {
    const { invoke } = setup({
      check: loadFixture('book_check', 'unavailable_503'),
      company: serverError(),
    });
    const text = expectNoLinkError(
      await invoke({
        location_id: LOCATION_ID,
        service_ids: [10303530],
        datetime: SLOT,
      })
    );
    expect(text.startsWith('The booking service did not answer in time.')).toBe(
      true
    );
  });

  it('fallback: an inconclusive check for a business with no booking form gives the no-widget error', async () => {
    const { invoke } = setup({
      check: loadFixture('book_check', 'unavailable_503'),
      company: loadFixture('company', 'no_forms'),
    });
    const text = expectNoLinkError(
      await invoke({
        location_id: LOCATION_ID,
        service_ids: [10303530],
        datetime: SLOT,
      })
    );
    expect(
      text.startsWith(
        'This business does not take online bookings through a booking widget right now.'
      )
    ).toBe(true);
  });
});

describe('book_check errors without a link (BOOK-01, D-06)', () => {
  it.each(['taken_433', 'no_member_436', 'not_enough_time_437'])(
    '%s says the time is no longer available and names business_list_time_slots',
    async (scenario) => {
      const { invoke, upstream } = setup({
        check: loadFixture('book_check', scenario),
      });
      const text = expectNoLinkError(
        await invoke({
          location_id: LOCATION_ID,
          service_ids: [10303530],
          team_member_id: ANNA,
          datetime: SLOT,
        })
      );
      expect(
        text.startsWith(
          'This time is no longer available for the chosen services and team member.'
        )
      ).toBe(true);
      expect(text).toContain(
        'Next: choose another time with business_list_time_slots'
      );
      expect(paths(upstream)).toEqual([`POST ${CHECK_PATH}`]);
    }
  );

  it.each(['service_438', 'taken_and_service_433_438'])(
    '%s names different services with business_list_services',
    async (scenario) => {
      const { invoke } = setup({
        check: loadFixture('book_check', scenario),
      });
      const text = expectNoLinkError(
        await invoke({
          location_id: LOCATION_ID,
          service_ids: [10303530],
          datetime: SLOT,
        })
      );
      expect(
        text.startsWith(
          'One of the chosen services cannot be booked at this time.'
        )
      ).toBe(true);
      expect(text).toContain(
        'Next: choose different services with business_list_services.'
      );
    }
  );

  it('404 says the business or a service was not found and names business_list_services', async () => {
    const { invoke } = setup({
      check: loadFixture('book_check', 'not_found_404'),
    });
    const text = expectNoLinkError(
      await invoke({
        location_id: LOCATION_ID,
        service_ids: [10303530],
        datetime: SLOT,
      })
    );
    expect(
      text.startsWith(
        'The business or one of the chosen services was not found.'
      )
    ).toBe(true);
    expect(text).toContain(
      'Next: check the location id with business_get and the service ids with business_list_services.'
    );
  });

  it('an unknown 422 code says the selection was not accepted', async () => {
    const { invoke } = setup({
      check: loadFixture('book_check', 'unknown_code_422'),
    });
    const text = expectNoLinkError(
      await invoke({
        location_id: LOCATION_ID,
        service_ids: [10303530],
        datetime: SLOT,
      })
    );
    expect(
      text.startsWith('The booking service did not accept this selection.')
    ).toBe(true);
    expect(text).toContain(
      'Next: choose another time with business_list_time_slots'
    );
  });

  it('a 429 with a 30-second reset gives the busy error and no link', async () => {
    const { invoke, upstream } = setup({
      check: {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'x-rate-limit-reset': '30',
        },
        body: { success: false, data: null, meta: { message: 'Too many' } },
      },
    });
    const text = expectNoLinkError(
      await invoke({
        location_id: LOCATION_ID,
        service_ids: [10303530],
        datetime: SLOT,
      })
    );
    expect(text.startsWith('The booking service is busy right now.')).toBe(
      true
    );
    expect(text).toContain('wait 30 seconds');
    expect(paths(upstream)).toEqual([`POST ${CHECK_PATH}`]);
  });

  describe('a card read failing after a 201 gets the advice that fits the failure (WR-03)', () => {
    const CARD_NOT_PREPARED =
      'The slot check passed, but the booking link could not be prepared.';

    async function failedCardRead(company: FixtureResponse | FakeReply) {
      const { invoke } = setup({ company }, { timeoutMs: 20 });
      return expectNoLinkError(
        await invoke({
          location_id: LOCATION_ID,
          service_ids: [10303530],
          datetime: SLOT,
        })
      );
    }

    it('a 5xx asks to repeat the call, without claiming the slot is free', async () => {
      const text = await failedCardRead(serverError());
      expect(text.startsWith(CARD_NOT_PREPARED)).toBe(true);
      expect(text).toContain('Next: call book_check again in a few seconds.');
      expect(text).not.toContain('The slot is free');
    });

    it('a timeout asks to repeat the call', async () => {
      const text = await failedCardRead(
        () => new Promise<FixtureResponse>(() => undefined)
      );
      expect(text.startsWith(CARD_NOT_PREPARED)).toBe(true);
      expect(text).toContain('Next: call book_check again in a few seconds.');
    });

    it('a 429 with a 30-second reset says to wait 30 seconds, not a few', async () => {
      const text = await failedCardRead({
        status: 429,
        headers: {
          'content-type': 'application/json',
          'x-rate-limit-reset': '30',
        },
        body: { success: false, data: null, meta: { message: 'Too many' } },
      });
      expect(text.startsWith('The booking service is busy right now.')).toBe(
        true
      );
      expect(text).toContain('wait 30 seconds');
      expect(text).not.toContain('a few seconds');
      expect(text).not.toContain('The slot is free');
    });

    it('a 404 says no business was found for this location id', async () => {
      const text = await failedCardRead(loadFixture('company', 'not_found'));
      expect(
        text.startsWith('No business was found for this location id.')
      ).toBe(true);
      expect(text).not.toContain('a few seconds');
    });
  });

  it('a services read failing after a 201 still returns the link, with names marked unavailable', async () => {
    const { invoke } = setup({ services: serverError() });
    const result = await invoke({
      location_id: LOCATION_ID,
      service_ids: [10303531],
      team_member_id: ANNA,
      datetime: SLOT,
    });
    const out = okOutput(result);
    expect(out.status).toBe('verified');
    expect(out.link.kind).toBe('preselected');
    expect(out.selection.services).toEqual([
      { id: 10303531, title: null, price: null, prepayment: 'unknown' },
    ]);
    expect(out.notes).toContain(NOTE_NAMES_UNAVAILABLE);
    const text = textOf(result);
    expect(text).toContain('- service 10303531: price not loaded');
    expect(text).not.toContain('price on request');
  });

  describe('price wording for a selected service (IN-04)', () => {
    function servicesWith(extra: Record<string, unknown>): FixtureResponse {
      const fixture = loadFixture('book_services', 'default');
      const body = structuredClone(fixture.body) as {
        data: { services: Record<string, unknown>[] };
      };
      body.data.services.push({
        id: 10303599,
        category_id: 7,
        price_min: 0,
        price_max: 0,
        active: 1,
        prepaid: null,
        seance_length: null,
        ...extra,
      });
      return { ...fixture, body };
    }

    it('a service in the catalog without a price and with a title that cleans to nothing is price on request', async () => {
      const { invoke } = setup({ services: servicesWith({ title: '' }) });
      const result = await invoke({
        location_id: LOCATION_ID,
        service_ids: [10303599],
        datetime: SLOT,
      });
      const out = okOutput(result);
      expect(out.selection.services[0]?.price).toBeNull();
      expect(out.notes).not.toContain(NOTE_NAMES_UNAVAILABLE);
      const text = textOf(result);
      expect(text).toContain('- service 10303599: price on request');
      expect(text).not.toContain('price not loaded');
    });

    it('a service missing from a catalog that did load is price not loaded', async () => {
      const { invoke } = setup();
      const result = await invoke({
        location_id: LOCATION_ID,
        service_ids: [99999999],
        datetime: SLOT,
      });
      const out = okOutput(result);
      expect(out.notes).toContain(NOTE_NAMES_UNAVAILABLE);
      const text = textOf(result);
      expect(text).toContain('- service 99999999: price not loaded');
      expect(text).not.toContain('price on request');
    });
  });

  it('a team members read failing after a 201 keeps the id and marks the name unavailable', async () => {
    const { invoke } = setup({ staff: serverError() });
    const out = okOutput(
      await invoke({
        location_id: LOCATION_ID,
        service_ids: [10303531],
        team_member_id: ANNA,
        datetime: SLOT,
      })
    );
    expect(out.link.kind).toBe('preselected');
    expect(out.selection.team_member).toEqual({ id: ANNA, name: null });
    expect(out.notes).toContain(NOTE_NAMES_UNAVAILABLE);
  });
});

describe('book_check input (edge BOOK-01, BOOK-03)', () => {
  const eleven = Array.from({ length: 11 }, (_, index) => 10303530 + index);

  it.each<[string, Record<string, unknown>]>([
    ['an empty service_ids list', { service_ids: [], datetime: SLOT }],
    ['11 service ids', { service_ids: eleven, datetime: SLOT }],
    ['a duplicate service id', { service_ids: [1, 1], datetime: SLOT }],
    ['service id 0', { service_ids: [0], datetime: SLOT }],
    ['an omitted datetime', { service_ids: [10303530] }],
    [
      "the datetime '2026-10-05 14:00'",
      { service_ids: [10303530], datetime: '2026-10-05 14:00' },
    ],
    [
      'an hour out of range',
      { service_ids: [10303530], datetime: '2026-10-05T25:00:00+03:00' },
    ],
    [
      'a negative team member id',
      { service_ids: [10303530], team_member_id: -1, datetime: SLOT },
    ],
    [
      'a client name field',
      { service_ids: [10303530], datetime: SLOT, client_name: 'Ann' },
    ],
  ])('rejects %s before any upstream call', async (_case, args) => {
    const { invoke, upstream } = setup();
    const result = await invoke({ location_id: LOCATION_ID, ...args });
    expect(result.outcome).toBe('invalid_params');
    expect(result.result.isError).toBe(true);
    expect(upstream.calls).toHaveLength(0);
  });

  it('has only location_id, service_ids, team_member_id and datetime as input', () => {
    const schema = bookCheck.spec.inputSchema as {
      properties: Record<string, unknown>;
      additionalProperties: unknown;
      required: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual(
      ['datetime', 'location_id', 'service_ids', 'team_member_id'].sort()
    );
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(
      ['datetime', 'location_id', 'service_ids'].sort()
    );
  });
});

describe('book_check surface (D-04, D-07, D-08)', () => {
  it('is named book_check and annotated read-only, non-destructive and open-world', () => {
    expect(bookCheck.name).toBe('book_check');
    expect(bookCheck.spec.annotations).toEqual({
      title: 'Check a slot and get the booking link',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      idempotentHint: true,
    });
  });

  it('declares the validation route and its three reads as upstream calls', () => {
    expect(bookCheck.meta.upstream).toEqual([
      BOOKING_ROUTES.check,
      BOOKING_ROUTES.company,
      BOOKING_ROUTES.services,
      BOOKING_ROUTES.teamMembers,
    ]);
  });

  it('asks for and returns no client personal data, in any text or field', async () => {
    const pii =
      /\b(phone number|mobile number|e-?mail|sms|verification code|one-time code|otp|full name|your name|client'?s name|client id|date of birth|passport)\b/i;
    const texts: string[] = [
      bookCheck.spec.description,
      JSON.stringify(bookCheck.spec.inputSchema),
      JSON.stringify(bookCheck.spec.outputSchema),
      CONFIRMATION_STATEMENT,
      NOTE_REPEAT_SELECTION,
      NOTE_UNVERIFIED,
      NOTE_PREPAYMENT,
      NOTE_NAMES_UNAVAILABLE,
    ];
    for (const scenario of [
      {},
      { company: companyWith({ timezone: 2 }) },
      {
        check: loadFixture('book_check', 'unavailable_503'),
      },
    ] as Replies[]) {
      const result = await setup(scenario).invoke({
        location_id: LOCATION_ID,
        service_ids: [10303530],
        team_member_id: ANNA,
        datetime: SLOT,
      });
      texts.push(
        textOf(result),
        JSON.stringify(result.result.structuredContent)
      );
    }
    for (const text of texts) expect(text).not.toMatch(pii);
    expect(CONFIRMATION_STATEMENT).toContain(
      'no personal details are needed in this conversation'
    );
  });
});
