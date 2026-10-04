// RED-phase stub: the calendar check is implemented in the next commit.

export function isCalendarDay(
  year: number,
  month: number,
  day: number
): boolean {
  return Number.isNaN(year + month + day);
}

export function calendarDayNumber(value: string): number | null {
  return value === '' ? 0 : null;
}
