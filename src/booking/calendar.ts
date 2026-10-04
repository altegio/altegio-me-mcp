// The one calendar check of the codebase (WR-01, IN-02). Pure: no clock, no
// I/O. A date or slot datetime must name a day that exists, not merely have
// the right digits: 2026-02-31 matches every date pattern and is not a day.

const MS_PER_DAY = 86_400_000;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Milliseconds since the Unix epoch of a calendar day, or null when it does not exist. */
function dayMilliseconds(
  year: number,
  month: number,
  day: number
): number | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }
  // Date.UTC reads the years 0 to 99 as 1900 to 1999, so the year is set
  // separately to keep leap years of the proleptic Gregorian calendar right.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  const exists =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  return exists ? date.getTime() : null;
}

/** True when `day` of `month` (1 to 12) exists in `year`. */
export function isCalendarDay(
  year: number,
  month: number,
  day: number
): boolean {
  return dayMilliseconds(year, month, day) !== null;
}

/**
 * Days since the Unix epoch of a strict YYYY-MM-DD date that names a real
 * day, otherwise null.
 */
export function calendarDayNumber(value: string): number | null {
  const match = DATE_PATTERN.exec(value);
  const [, year, month, day] = match ?? [];
  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }
  const ms = dayMilliseconds(Number(year), Number(month), Number(day));
  return ms === null ? null : ms / MS_PER_DAY;
}
