/**
 * `YYYY-MM-DD` calendar days as day counts since 1970-01-01, the same in
 * every time zone: counted in UTC, so a day is never off by one where the
 * zone is more than 12 hours from UTC or on a daylight-saving change.
 */

const DAY_MS = 86_400_000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function utcMidnight(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0);
  // setUTCFullYear, unlike Date.UTC, keeps years 0-99 as they are.
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

/** The day count of a real `YYYY-MM-DD` day; null for anything else, `2026-04-31` included. */
export function dayIndex(value: unknown): number | null {
  const m = typeof value === 'string' ? ISO_DAY.exec(value) : null;
  if (!m) return null;
  const date = utcMidnight(+m[1], +m[2] - 1, +m[3]);
  return date.getUTCMonth() === +m[2] - 1 && date.getUTCDate() === +m[3] ? date.getTime() / DAY_MS : null;
}

export const isCalendarDay = (value: unknown): value is string => dayIndex(value) !== null;

/** The `YYYY-MM-DD` day of a day count. */
export function dayAt(index: number): string {
  const date = new Date(index * DAY_MS);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** The day count of the local calendar day `now` falls on. */
export function localDayIndex(now: number): number {
  const date = new Date(now);
  return utcMidnight(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / DAY_MS;
}
