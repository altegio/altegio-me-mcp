import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  ALLOWED_FORM_HOST_SUFFIXES,
  buildBookingLink,
  FALLBACK_BOOKING_ORIGIN,
  formatUtcOffset,
  parseSlotDatetime,
  plainBookingLink,
  SLOT_DATETIME_PATTERN,
  type BookingLink,
  type BookingLinkInput,
} from '../deep-link.js';

// Demo business from docs/research/widget-deep-link.md: location 722227,
// booking form 1463903, 2026-10-05 14:00 in a +03:00 business.
const FORM = 'https://n1463903.alteg.io/';
const LOCATION = 722227;
const MEMBER = 2098145;
const SERVICE = 10303530;
const SECOND_SERVICE = 10303531;
const SLOT = '2026-10-05T14:00:00+03:00';
const APP_LINK = 'https://app.alteg.io/book/722227';

function input(overrides: Partial<BookingLinkInput> = {}): BookingLinkInput {
  return {
    locationId: LOCATION,
    formUrl: FORM,
    teamMemberId: MEMBER,
    serviceIds: [SERVICE],
    slotDatetime: SLOT,
    businessUtcOffsetHours: 3,
    anyTeamMemberAllowed: true,
    ...overrides,
  };
}

// Every link any test in this file produces, with the form URL it was built
// from; the invariant suite at the end checks all of them (T-02-11).
const produced: { formUrl: string | null; result: BookingLink }[] = [];

function link(overrides: Partial<BookingLinkInput> = {}): BookingLink {
  const given = input(overrides);
  const result = buildBookingLink(given);
  produced.push({ formUrl: given.formUrl, result });
  return result;
}

function plain(locationId: number, formUrl: string | null): BookingLink {
  const result = plainBookingLink(locationId, formUrl);
  produced.push({ formUrl, result });
  return result;
}

describe('constants', () => {
  it('allow-lists the three Altegio booking-form host suffixes', () => {
    expect(ALLOWED_FORM_HOST_SUFFIXES).toEqual([
      'alteg.io',
      'altegio.asia',
      'altegio.org',
    ]);
  });

  it('falls back to app.alteg.io over https', () => {
    expect(FALLBACK_BOOKING_ORIGIN).toBe('https://app.alteg.io');
  });

  it('matches the slot datetime shapes book_times emits', () => {
    expect(SLOT_DATETIME_PATTERN.test(SLOT)).toBe(true);
    expect(SLOT_DATETIME_PATTERN.test('2026-10-05T14:00:00.000+0300')).toBe(
      true
    );
    expect(SLOT_DATETIME_PATTERN.test('2026-10-05T14:00:00Z')).toBe(true);
    expect(SLOT_DATETIME_PATTERN.test('2026-10-05 14:00')).toBe(false);
  });
});

describe('buildBookingLink: pre-selected widget link (D-05)', () => {
  it('builds the exact widget link for one service and a named team member', () => {
    expect(link()).toEqual({
      kind: 'preselected',
      url: 'https://n1463903.alteg.io/company/722227?o=m2098145s10303530d2605101400',
      reason: null,
    });
  });

  it('writes any team member as m-1 and concatenates several services', () => {
    const result = link({
      teamMemberId: 0,
      serviceIds: [SERVICE, SECOND_SERVICE],
    });
    expect(result.kind).toBe('preselected');
    expect(result.url).toBe(
      'https://n1463903.alteg.io/company/722227?o=m-1s10303530s10303531d2605101400'
    );
    expect(result.url.endsWith('?o=m-1s10303530s10303531d2605101400')).toBe(
      true
    );
  });

  it('keeps the services in the order given, never the comma form', () => {
    const result = link({ serviceIds: [SECOND_SERVICE, SERVICE] });
    expect(result.url).toBe(
      'https://n1463903.alteg.io/company/722227?o=m2098145s10303531s10303530d2605101400'
    );
    expect(result.url).not.toContain(',');
  });

  it('puts the day before the month in the d token', () => {
    expect(link({ slotDatetime: '2026-12-31T23:30:00+03:00' }).url).toMatch(
      /d2631122330$/
    );
    expect(link({ slotDatetime: '2027-12-01T09:05:00+03:00' }).url).toMatch(
      /d2701120905$/
    );
  });

  it('reads the wall clock from the slot string, never converting to UTC', () => {
    // 23:30 at +03:00 is 20:30 UTC; the widget expects the business wall clock.
    const result = link({ slotDatetime: '2026-12-31T23:30:00+03:00' });
    expect(result.url).toContain('d2631122330');
    expect(result.url).not.toContain('d2631122030');
  });

  it.each([
    ['https://b1463903.alteg.io/', 'https://b1463903.alteg.io'],
    ['https://n5.altegio.asia', 'https://n5.altegio.asia'],
    ['https://n5.altegio.org/', 'https://n5.altegio.org'],
  ])('builds the link on the origin of form %s', (formUrl, origin) => {
    expect(link({ formUrl })).toEqual({
      kind: 'preselected',
      url: `${origin}/company/722227?o=m2098145s10303530d2605101400`,
      reason: null,
    });
  });

  it('never doubles the slash after a form URL that ends with one', () => {
    expect(link().url).not.toContain('//company');
  });

  it.each([
    ['2026-10-05T14:00:00Z', 0],
    ['2026-10-05T14:00:00+0300', 3],
    ['2026-10-05T14:00:00.000+03:00', 3],
  ])('accepts slot %s with business offset %d', (slotDatetime, offset) => {
    expect(link({ slotDatetime, businessUtcOffsetHours: offset })).toEqual({
      kind: 'preselected',
      url: 'https://n1463903.alteg.io/company/722227?o=m2098145s10303530d2605101400',
      reason: null,
    });
  });

  it.each(['https://evil.example/', 'https://n1.alteg.io.evil.com/'])(
    'refuses form host %s and falls back to app.alteg.io',
    (formUrl) => {
      expect(link({ formUrl })).toEqual({
        kind: 'booking_form',
        url: APP_LINK,
        reason: 'host_not_allowed',
      });
    }
  );
});

describe('parseSlotDatetime', () => {
  it('keeps the digit strings exactly as written', () => {
    expect(parseSlotDatetime('2026-10-05T14:00:00.000+03:00')).toEqual({
      year: '2026',
      month: '10',
      day: '05',
      hour: '14',
      minute: '00',
      second: '00',
      offsetMinutes: 180,
    });
  });

  it.each([
    ['2026-10-05T14:00:00Z', 0],
    ['2026-10-05T14:00:00+03:00', 180],
    ['2026-10-05T14:00:00+0300', 180],
    ['2026-10-05T14:00:00-05:30', -330],
    ['2026-10-05T14:00:00+05:45', 345],
    ['2026-10-05T14:00:00+14:00', 840],
  ])('reads the offset of %s as %d minutes', (value, minutes) => {
    expect(parseSlotDatetime(value)?.offsetMinutes).toBe(minutes);
  });

  it.each([
    '2026-13-05T14:00:00+03:00',
    '2026-00-05T14:00:00+03:00',
    '2026-10-32T14:00:00+03:00',
    '2026-10-00T14:00:00+03:00',
    '2026-10-05T24:00:00+03:00',
    '2026-10-05T14:60:00+03:00',
    '2026-10-05T14:00:60+03:00',
    '2026-10-05T14:00:00+15:00',
    '2026-10-05T14:00:00+03:60',
    '2026-10-05 14:00',
    '2026-10-05T14:00:00',
    ' 2026-10-05T14:00:00+03:00',
    '',
  ])('returns null for %p', (value) => {
    expect(parseSlotDatetime(value)).toBeNull();
  });

  describe('a day that does not exist in its month is not a slot (WR-01)', () => {
    it.each([
      '2026-02-31T10:00:00+03:00',
      '2026-02-29T10:00:00+03:00',
      '2026-04-31T10:00:00+03:00',
      '0000-04-31T10:00:00+14:00',
    ])('returns null for %s', (value) => {
      expect(parseSlotDatetime(value)).toBeNull();
    });

    it('accepts 29 February of a leap year', () => {
      expect(parseSlotDatetime('2028-02-29T10:00:00+03:00')).not.toBeNull();
    });

    it('is the calendar check, not the pattern, that rejects an impossible day', () => {
      expect(SLOT_DATETIME_PATTERN.test('2026-02-31T10:00:00+03:00')).toBe(
        true
      );
      expect(parseSlotDatetime('2026-02-31T10:00:00+03:00')).toBeNull();
    });
  });
});

describe('formatUtcOffset', () => {
  it.each([
    [180, '+03:00'],
    [-330, '-05:30'],
    [0, '+00:00'],
    [345, '+05:45'],
    [-600, '-10:00'],
  ])('renders %d minutes as %s', (minutes, text) => {
    expect(formatUtcOffset(minutes)).toBe(text);
  });
});

describe('purity', () => {
  it('never builds a date object (the d token comes from the slot digits)', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/booking/deep-link.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/new Date|Date\./);
  });
});

describe('buildBookingLink: plain booking-form fallback (D-06, BOOK-05)', () => {
  const FORM_LINK = 'https://n1463903.alteg.io/company/722227';

  it('falls back to app.alteg.io when the card has no form URL', () => {
    expect(link({ formUrl: null })).toEqual({
      kind: 'booking_form',
      url: APP_LINK,
      reason: 'no_form_url',
    });
  });

  it('treats a blank form URL as no form URL', () => {
    expect(link({ formUrl: '  ' })).toEqual({
      kind: 'booking_form',
      url: APP_LINK,
      reason: 'no_form_url',
    });
  });

  it.each([
    'https://evil.example/',
    'https://n1.alteg.io.evil.com/',
    'https://alteg.io.evil.com/',
    'https://evilalteg.io/',
    'http://n1463903.alteg.io/',
    'https://user:pw@n1463903.alteg.io/',
    'https://user@n1463903.alteg.io/',
    'https://n1463903.alteg.io:8443/',
    'javascript:alert(1)',
    'not a url',
  ])('refuses form URL %p with host_not_allowed', (formUrl) => {
    expect(link({ formUrl })).toEqual({
      kind: 'booking_form',
      url: APP_LINK,
      reason: 'host_not_allowed',
    });
  });

  it('ignores the path and query of an allowed form URL', () => {
    expect(
      link({ formUrl: 'https://n1463903.alteg.io/some/path?x=1#frag' }).url
    ).toBe(
      'https://n1463903.alteg.io/company/722227?o=m2098145s10303530d2605101400'
    );
  });

  it('returns the form link with no_services for an empty service list', () => {
    expect(link({ serviceIds: [] })).toEqual({
      kind: 'booking_form',
      url: FORM_LINK,
      reason: 'no_services',
    });
  });

  it.each([
    '2026-10-05 14:00',
    '2026-13-05T14:00:00+03:00',
    '2026-10-05T14:00:30+03:00',
    '2026-10-05T14:00:00',
    '',
  ])('returns the form link with bad_datetime for slot %p', (slotDatetime) => {
    expect(link({ slotDatetime })).toEqual({
      kind: 'booking_form',
      url: FORM_LINK,
      reason: 'bad_datetime',
    });
  });

  it.each([
    ['2026-10-05T14:00:00+05:30', 5.5],
    ['2026-10-05T14:00:00+05:45', 5.75],
    ['2026-10-05T14:00:00-03:30', -3.5],
  ])(
    'returns fractional_offset for slot %s (the widget renders 5.5 as +05:50)',
    (slotDatetime, offset) => {
      expect(link({ slotDatetime, businessUtcOffsetHours: offset })).toEqual({
        kind: 'booking_form',
        url: FORM_LINK,
        reason: 'fractional_offset',
      });
    }
  );

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY])(
    'returns offset_unknown when the business offset is %p',
    (offset) => {
      expect(link({ businessUtcOffsetHours: offset })).toEqual({
        kind: 'booking_form',
        url: FORM_LINK,
        reason: 'offset_unknown',
      });
    }
  );

  it.each([
    ['2026-10-05T14:00:00+02:00', 3],
    ['2026-10-05T14:00:00Z', 3],
    ['2026-10-05T14:00:00+03:00', -3],
    ['2026-10-05T14:00:00+06:00', 5.5],
  ])(
    'returns offset_mismatch for slot %s and business offset %d',
    (slotDatetime, offset) => {
      expect(link({ slotDatetime, businessUtcOffsetHours: offset })).toEqual({
        kind: 'booking_form',
        url: FORM_LINK,
        reason: 'offset_mismatch',
      });
    }
  );

  it('returns any_team_member_disabled for m-1 when the business disallows it', () => {
    expect(link({ teamMemberId: 0, anyTeamMemberAllowed: false })).toEqual({
      kind: 'booking_form',
      url: FORM_LINK,
      reason: 'any_team_member_disabled',
    });
  });

  it('keeps a named team member pre-selected when any team member is disallowed', () => {
    expect(link({ anyTeamMemberAllowed: false })).toEqual({
      kind: 'preselected',
      url: 'https://n1463903.alteg.io/company/722227?o=m2098145s10303530d2605101400',
      reason: null,
    });
  });

  describe('guard precedence', () => {
    it('reports no_form_url before a bad datetime', () => {
      expect(link({ formUrl: null, slotDatetime: 'garbage' }).reason).toBe(
        'no_form_url'
      );
    });

    it('reports host_not_allowed before no services', () => {
      expect(
        link({ formUrl: 'https://evil.example/', serviceIds: [] }).reason
      ).toBe('host_not_allowed');
    });

    it('reports no_services before a bad datetime', () => {
      expect(link({ serviceIds: [], slotDatetime: 'garbage' }).reason).toBe(
        'no_services'
      );
    });

    it('reports bad_datetime before an unknown offset', () => {
      expect(
        link({
          slotDatetime: '2026-10-05T14:00:30+03:00',
          businessUtcOffsetHours: null,
        }).reason
      ).toBe('bad_datetime');
    });

    it('reports fractional_offset before an unknown offset', () => {
      expect(
        link({
          slotDatetime: '2026-10-05T14:00:00+05:30',
          businessUtcOffsetHours: null,
        }).reason
      ).toBe('fractional_offset');
    });

    it('reports offset_unknown before any_team_member_disabled', () => {
      expect(
        link({
          businessUtcOffsetHours: null,
          teamMemberId: 0,
          anyTeamMemberAllowed: false,
        }).reason
      ).toBe('offset_unknown');
    });

    it('reports offset_mismatch before any_team_member_disabled', () => {
      expect(
        link({
          businessUtcOffsetHours: 2,
          teamMemberId: 0,
          anyTeamMemberAllowed: false,
        }).reason
      ).toBe('offset_mismatch');
    });
  });

  describe('ids', () => {
    it.each<[string, Partial<BookingLinkInput>]>([
      ['a fractional location id', { locationId: 1.5 }],
      ['a zero location id', { locationId: 0 }],
      ['a NaN location id', { locationId: Number.NaN }],
      ['a negative team member id', { teamMemberId: -1 }],
      ['an unsafe team member id', { teamMemberId: 2 ** 53 }],
      ['a zero service id', { serviceIds: [SERVICE, 0] }],
      ['a fractional service id', { serviceIds: [1e-7] }],
    ])('throws a RangeError for %s', (_label, overrides) => {
      expect(() => buildBookingLink(input(overrides))).toThrow(RangeError);
    });
  });
});

describe('plainBookingLink', () => {
  it('links to the form company page with no reason', () => {
    expect(plain(LOCATION, FORM)).toEqual({
      kind: 'booking_form',
      url: 'https://n1463903.alteg.io/company/722227',
      reason: null,
    });
  });

  it('falls back to app.alteg.io with no_form_url when there is no form URL', () => {
    expect(plain(LOCATION, null)).toEqual({
      kind: 'booking_form',
      url: APP_LINK,
      reason: 'no_form_url',
    });
  });

  it('falls back to app.alteg.io with host_not_allowed for a foreign host', () => {
    expect(plain(LOCATION, 'https://evil.example/')).toEqual({
      kind: 'booking_form',
      url: APP_LINK,
      reason: 'host_not_allowed',
    });
  });

  it('throws a RangeError for a location id that is not a positive integer', () => {
    expect(() => plainBookingLink(-5, FORM)).toThrow(RangeError);
  });
});

// Runs last: Jest executes the tests of a file in order, so `produced` holds
// every link built above.
describe('URL invariants over every link in this file (T-02-11)', () => {
  const O_VALUE = /^\?o=m(?:-1|[1-9]\d*)(?:s[1-9]\d*)+d\d{10}$/;

  function hostOf(formUrl: string | null): string | null {
    if (formUrl === null) return null;
    try {
      return new URL(formUrl).host;
    } catch {
      return null;
    }
  }

  function allowListed(host: string): boolean {
    return ALLOWED_FORM_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`)
    );
  }

  it('covers every case', () => {
    expect(produced.length).toBeGreaterThanOrEqual(50);
  });

  it('every link is an https URL with no user info or port on an Altegio booking host', () => {
    for (const { formUrl, result } of produced) {
      const url = new URL(result.url);
      expect(url.protocol).toBe('https:');
      expect(url.username).toBe('');
      expect(url.password).toBe('');
      expect(url.port).toBe('');
      const onFormHost = url.host === hostOf(formUrl) && allowListed(url.host);
      expect(onFormHost || url.host === 'app.alteg.io').toBe(true);
    }
  });

  it('every link has a fixed path and either no query or a well-formed o value', () => {
    for (const { result } of produced) {
      const url = new URL(result.url);
      expect(url.hash).toBe('');
      if (url.host === 'app.alteg.io') {
        expect(url.pathname).toMatch(/^\/book\/[1-9]\d*$/);
      } else {
        expect(url.pathname).toMatch(/^\/company\/[1-9]\d*$/);
      }
      if (result.kind === 'preselected') {
        expect(result.reason).toBeNull();
        expect(url.search).toMatch(O_VALUE);
      } else {
        expect(url.search).toBe('');
      }
    }
  });
});
