import { timeOf, type MichiThreadState } from 'michi-shared';

export function michiStateLabel(state: MichiThreadState, doneBy?: 'user' | 'agent'): string {
  switch (state) {
    case 'waiting': return 'Waiting on you';
    case 'doing': return 'In progress';
    case 'stalled': return 'Stalled';
    case 'done': return doneBy === 'agent' ? 'Agent says done' : 'Done';
    case 'idea': return 'Chatted only';
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Compact age for row trailers: `now`, `40m`, `3h`, `2d`, `2w`. */
export function formatMichiAge(ts: number | null, now: number = Date.now()): string {
  if (ts == null) return '';
  const elapsed = Math.max(0, now - ts);
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}d`;
  return `${Math.floor(elapsed / WEEK)}w`;
}

/** formatMichiAge as a time in the past: `12m ago`, `just now`; empty when the time is unknown. */
export function formatMichiAgo(ts: number | null | undefined, now: number = Date.now()): string {
  if (ts == null) return '';
  const age = formatMichiAge(ts, now);
  return age === 'now' ? 'just now' : `${age} ago`;
}

/** A digest's age, `just now`, `40m ago`, `3h ago`, counted in days past a day; `—` before it has one. */
export function formatDigestAge(ts: number, now: number = Date.now()): string {
  if (!ts) return '—';
  const elapsed = Math.max(0, now - ts);
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  return `${Math.floor(elapsed / DAY)}d ago`;
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number) => String(n).padStart(2, '0');

/** `Oct 16, 21:40` in local time, 24-hour clock. */
export function formatMichiClock(ts: number): string {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `YYYY-MM-DD` is a local day; anything else is a time. Bad input, `2026-04-31` included, gives null. */
function parseDay(s: string): Date | null {
  const t = timeOf(s);
  return Number.isNaN(t) ? null : new Date(t);
}

/** `Oct 21`; another year's day says its year. */
export function formatDay(s: string, now: Date = new Date()): string {
  const d = parseDay(s);
  if (!d) return s;
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}

/** `Oct 25 → 27`, `Oct 30 → Nov 2`. */
export function formatDateValue(v: { start: string; end?: string }, now: Date = new Date()): string {
  if (!v.end) return formatDay(v.start, now);
  const a = parseDay(v.start);
  const b = parseDay(v.end);
  if (a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return `${formatDay(v.start, now)} → ${b.getDate()}`;
  return `${formatDay(v.start, now)} → ${formatDay(v.end, now)}`;
}
