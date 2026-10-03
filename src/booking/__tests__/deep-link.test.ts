import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  ALLOWED_FORM_HOST_SUFFIXES,
  buildBookingLink,
  FALLBACK_BOOKING_ORIGIN,
  formatUtcOffset,
  parseSlotDatetime,
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

function link(overrides: Partial<BookingLinkInput> = {}): BookingLink {
  return buildBookingLink(input(overrides));
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
