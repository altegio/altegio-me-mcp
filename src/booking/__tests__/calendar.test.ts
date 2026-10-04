import { describe, expect, it } from '@jest/globals';
import { calendarDayNumber, isCalendarDay } from '../calendar.js';

// The one calendar check of the codebase (WR-01, IN-02): a date or slot
// datetime must name a day that exists, not merely have the right digits.

describe('isCalendarDay', () => {
  it.each<[number, number, number, boolean]>([
    [2026, 10, 4, true],
    [2026, 1, 31, true],
    [2026, 12, 31, true],
    [2028, 2, 29, true],
    [2000, 2, 29, true],
    [2026, 2, 29, false],
    [2100, 2, 29, false],
    [2026, 2, 31, false],
    [2026, 4, 31, false],
    [2026, 13, 1, false],
    [2026, 0, 1, false],
    [2026, 1, 0, false],
    [2026, 1, 32, false],
    [0, 4, 31, false],
    [0, 2, 29, true],
    [99, 2, 29, false],
  ])('isCalendarDay(%d, %d, %d) is %p', (year, month, day, expected) => {
    expect(isCalendarDay(year, month, day)).toBe(expected);
  });

  it('rejects fractions and non-finite numbers', () => {
    expect(isCalendarDay(2026, 10.5, 4)).toBe(false);
    expect(isCalendarDay(2026, 10, Number.NaN)).toBe(false);
    expect(isCalendarDay(Number.POSITIVE_INFINITY, 10, 4)).toBe(false);
  });
});

describe('calendarDayNumber', () => {
  it('counts days since the Unix epoch', () => {
    expect(calendarDayNumber('1970-01-01')).toBe(0);
    expect(calendarDayNumber('1970-01-02')).toBe(1);
    expect(calendarDayNumber('2026-10-04')).toBe(20_730);
  });

  it('numbers consecutive days consecutively across a leap day', () => {
    const feb28 = calendarDayNumber('2028-02-28');
    expect(calendarDayNumber('2028-02-29')).toBe((feb28 ?? Number.NaN) + 1);
    expect(calendarDayNumber('2028-03-01')).toBe((feb28 ?? Number.NaN) + 2);
  });

  it.each([
    '2026-02-31',
    '2026-02-29',
    '2026-1-04',
    '2026-10-4',
    '26-10-04',
    '2026-10-04T10:00:00',
    ' 2026-10-04',
    '',
  ])('is null for %p', (value) => {
    expect(calendarDayNumber(value)).toBeNull();
  });
});
