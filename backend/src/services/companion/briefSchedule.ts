/**
 * When the Companion's morning brief comes (DESIGN §6.6, R2.6, R2.7, B24):
 * one pure rule for the engine, which writes the brief, and for the status,
 * which says when the next one is due, so the two never disagree.
 *
 * A brief comes once a workday (settings.workdays), at settings.brief.time,
 * and only after the first welcome (R2.6: no model turn before it). The day
 * the user first meets the Companion at or after the brief's time has no
 * brief: that day the welcome is the look. A day that already has a brief
 * (the Companion's or Michi's fallback) gets no other.
 */

import type { CompanionSettings } from 'michi-shared';
import { atLocalClock, isCompanionWorkday } from './clock';

/** Days after today searched for the next brief: a whole week, so any set of workdays has one in it. */
const LOOKAHEAD_DAYS = 7;

export interface CompanionBriefDayInput {
  settings: Pick<CompanionSettings, 'brief' | 'workdays'>;
  now: number;
  /** When the first welcome happened (repository.companionWelcomeDoneAt); null before it. */
  welcomeAt: number | null;
  /** The local date of `now` already has a brief (repository.briefForDate). */
  briefToday: boolean;
}

/**
 * Today's brief is still to come (the coordinator's briefPending): the brief
 * is on, today is a workday without a brief yet, and the welcome happened
 * before today's brief time. Whether that time has come is the caller's to
 * check.
 */
export function isCompanionBriefPending(input: CompanionBriefDayInput): boolean {
  const { settings, now, welcomeAt } = input;
  if (!settings.brief.enabled || !isCompanionWorkday(settings, now)) return false;
  if (welcomeAt === null || welcomeAt >= atLocalClock(now, settings.brief.time)) return false;
  return !input.briefToday;
}

export interface CompanionNextBriefInput extends CompanionBriefDayInput {
  settings: Pick<CompanionSettings, 'enabled' | 'paused' | 'brief' | 'workdays'>;
}

/**
 * When the next brief is due (CompanionStatusDto.nextBriefAt); null when none
 * will come: the Companion is off or paused, or the brief is off.
 *
 * - Today's brief is still to come (isCompanionBriefPending): today's brief
 *   time, also once it has passed. A time at or before `now` means today's
 *   brief is due and not written yet: it is being written or retried, or it
 *   waits for the user to come back or for quiet hours to end.
 * - Otherwise: the brief time of the next workday after today.
 * - Before the first welcome there is no brief at all. The first one is the
 *   first workday brief time still ahead of `now`, the earliest a welcome
 *   could still come before: a welcome now makes today's brief when today is
 *   a workday whose brief time has not come yet. A brief time already past
 *   cannot be had any more, since a welcome at or after it is that day's look.
 */
export function nextCompanionBriefAt(input: CompanionNextBriefInput): number | null {
  const { settings, now, welcomeAt } = input;
  if (!settings.enabled || settings.paused || !settings.brief.enabled) return null;
  const today = atLocalClock(now, settings.brief.time);
  if (welcomeAt !== null) {
    if (isCompanionBriefPending(input)) return today;
  } else if (isCompanionWorkday(settings, now) && !input.briefToday && today > now) {
    return today;
  }
  for (let days = 1; days <= LOOKAHEAD_DAYS; days += 1) {
    const at = atLocalClock(now, settings.brief.time, days);
    if (isCompanionWorkday(settings, at) && (welcomeAt === null || welcomeAt < at)) return at;
  }
  return null;
}
