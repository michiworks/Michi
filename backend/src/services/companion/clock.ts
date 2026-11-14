/**
 * Local wall-clock arithmetic for the Companion: the brief's
 * time and date, "today" for the turn budget, and the times its tools take
 * and its notes give (DESIGN-v2 §3.9 conv-2: a local `YYYY-MM-DD HH:MM` or
 * `+90m`, converted here; the run time as ISO 8601 with the offset).
 * Everything is this computer's local time zone, the one the user reads
 * `HH:MM` settings in.
 */

import type { CompanionSettings } from 'michi-shared';
import type { CompanionClock } from './types';

export const systemCompanionClock: CompanionClock = Object.freeze({ now: () => Date.now() });

/** Minutes after midnight of an `HH:MM` clock (isCompanionClock). */
export function clockMinutes(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number);
  return hours * 60 + minutes;
}

/** The local date of `now` as `YYYY-MM-DD`. */
export function localDateKey(now: number): string {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The local time of `now` as `HH:MM` (24-hour). */
export function localClockText(now: number): string {
  const date = new Date(now);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** The local weekday of `now` (0 = Sunday), as CompanionSettings.workdays counts it. */
export function localWeekday(now: number): number {
  return new Date(now).getDay();
}

/** True when `now` falls on one of the settings' workdays (local time). */
export function isCompanionWorkday(settings: Pick<CompanionSettings, 'workdays'>, now: number): boolean {
  return settings.workdays.includes(localWeekday(now));
}

/** Epoch ms of the local midnight that starts the day of `now`. */
export function localDayStart(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Epoch ms of `clock` (`HH:MM`) on the local day of `now`, `days` days later. */
export function atLocalClock(now: number, clock: string, days = 0): number {
  const date = new Date(now);
  const minutes = clockMinutes(clock);
  date.setDate(date.getDate() + days);
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return date.getTime();
}

/** This computer's UTC offset at `now` as `+09:00` / `-05:00` / `+00:00` (ISO 8601). */
export function localUtcOffsetText(now: number): string {
  const offset = -new Date(now).getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const minutes = Math.abs(offset);
  return `${sign}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * `now` as an ISO 8601 local time to the minute, with this computer's
 * offset: `2026-11-05T09:12+09:00` (conv-2). The [CURRENT RUN TIME] every
 * note and [COMPANION CONTEXT] carries, so the model knows the zone a local
 * time it writes is read in; epoch ms stay out of the prompts (B25).
 */
export function localIsoMinuteText(now: number): string {
  return `${localDateKey(now)}T${localClockText(now)}${localUtcOffsetText(now)}`;
}

/** What parseCompanionTime makes of a time a tool was given: epoch ms, or why it is no time. */
export type CompanionTimeParse = { ok: true; at: number } | { ok: false; problem: string };

/** The forms parseCompanionTime takes, for tool descriptions and refusals. */
export const COMPANION_TIME_FORMS = 'a local time "YYYY-MM-DD HH:MM" or a time from now such as "+90m", "+3h" or "+2d"';

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;
const RELATIVE_TIME = /^([+-])\s*(?:(\d{1,4})\s*d(?:ays?)?)?\s*(?:(\d{1,5})\s*h(?:ours?)?)?\s*(?:(\d{1,6})\s*m(?:in(?:utes?)?)?)?$/i;
const EPOCH_DIGITS = /^\d{12,16}$/;
const MAX_RELATIVE_MS = 400 * 24 * 60 * 60 * 1000;

/**
 * A time a tool argument gives (conv-2), in this computer's zone:
 * - a local wall-clock time `YYYY-MM-DD HH:MM` (or with `T`), refused when
 *   that minute does not exist locally (a DST gap) or the date is not real;
 * - a time from `now`: `+90m`, `+3h`, `+1h30m`, `+2d` (or `-2h`, before now);
 * - epoch ms, as a number or as digits, kept for callers from before.
 * Whether the time may be in the past or how far ahead it may be is the
 * caller's rule.
 */
export function parseCompanionTime(value: unknown, now: number): CompanionTimeParse {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? { ok: true, at: value } : { ok: false, problem: `must be ${COMPANION_TIME_FORMS}` };
  }
  if (typeof value !== 'string') return { ok: false, problem: `must be ${COMPANION_TIME_FORMS}` };
  const text = value.trim();
  if (EPOCH_DIGITS.test(text)) return { ok: true, at: Number(text) };
  const local = LOCAL_TIME.exec(text);
  if (local) {
    const [year, month, day, hours, minutes] = local.slice(1).map(Number);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59) {
      return { ok: false, problem: `${text} is not a date and time (YYYY-MM-DD HH:MM, 24-hour)` };
    }
    const date = new Date(year, month - 1, day, hours, minutes, 0, 0);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
      || date.getHours() !== hours || date.getMinutes() !== minutes) {
      return { ok: false, problem: `${text} does not exist in this computer's time zone (UTC${localUtcOffsetText(now)})` };
    }
    return { ok: true, at: date.getTime() };
  }
  const relative = RELATIVE_TIME.exec(text);
  if (relative && (relative[2] || relative[3] || relative[4])) {
    const [days, hours, minutes] = [relative[2], relative[3], relative[4]].map((part) => Number(part ?? 0));
    const span = ((days * 24 + hours) * 60 + minutes) * 60_000;
    if (span <= 0 || span > MAX_RELATIVE_MS) return { ok: false, problem: `${text} is not a usable time from now` };
    return { ok: true, at: relative[1] === '-' ? now - span : now + span };
  }
  return { ok: false, problem: `must be ${COMPANION_TIME_FORMS}, not ${JSON.stringify(text.slice(0, 40))}` };
}

/** `2026-11-06 09:00 (Friday)`: how a tool echoes a time back, so the model can check it against the user's words. */
export function localTimeEchoText(at: number): string {
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][localWeekday(at)];
  return `${localDateKey(at)} ${localClockText(at)} (${weekday})`;
}
