import { companionAgo } from 'michi-shared';
import type { CompanionItemDto, CompanionReminderDto } from 'michi-shared';

/** How the panel words and groups what the snapshot holds. Pure: the components and tests share it. */

// The status line and "2m ago" moved to shared (companionStatus.ts) in W0, so the panel, the
// Topbar button and the tray say the same; re-exported here for the views that read them.
export { companionAgo, companionStatusLine, type CompanionStatusLine, type CompanionStatusTone as CompanionTone } from 'michi-shared';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Local `HH:MM` (24h), the way settings and the Companion's own summaries write times. */
export function companionClock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Local calendar days from `now`'s day to `at`'s (0 = the same day, 1 = tomorrow, -1 = yesterday). */
function localDaysFrom(now: number, at: number): number {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const to = new Date(at);
  to.setHours(0, 0, 0, 0);
  // A DST change makes a day 23 or 25 hours long.
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

/** A fact that holds a time (epoch ms), or null. */
function factTime(item: Pick<CompanionItemDto, 'facts'>, key: string): number | null {
  const value = item.facts[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The moment a feed row shows: when the object itself last moved, as the
 * collector read it from the source, not when Michi first saw the object
 * (a baseline item is minutes old to Michi, and may be days old). A CR's
 * last touch on reviews.example.com (sources/cr.ts `lastTouchedAt`), an email
 * thread's latest delivery (sources/email.ts `lastDeliveryAt`), when a Michi
 * conversation began to wait or finished; a meeting or a calendar conflict
 * shows when it starts (`clock`). Anything else, or a fact the source could
 * not read: when the item last changed (`changedAt`).
 */
function companionItemMoment(item: Pick<CompanionItemDto, 'source' | 'subtype' | 'facts' | 'changedAt'>): { kind: 'ago' | 'clock'; at: number } {
  let at: number | null = null;
  switch (item.source) {
    case 'cr': at = factTime(item, 'lastTouchedAt'); break;
    case 'email': at = factTime(item, 'lastDeliveryAt'); break;
    case 'michi': at = factTime(item, 'waitingSince') ?? factTime(item, 'finishedAt'); break;
    case 'calendar': {
      const start = factTime(item, item.subtype === 'calendar_conflict' ? 'overlapStart' : 'start');
      if (start !== null) return { kind: 'clock', at: start };
      break;
    }
    default: break;
  }
  return { kind: 'ago', at: at ?? item.changedAt };
}

/** The row's time in words: "5m ago", or for a meeting "10:30" ("Tue 10:30" on another day). */
export function companionItemTime(item: Pick<CompanionItemDto, 'source' | 'subtype' | 'facts' | 'changedAt'>, now: number): string {
  const moment = companionItemMoment(item);
  if (moment.kind === 'ago') return companionAgo(moment.at, now);
  const clock = companionClock(moment.at);
  return localDaysFrom(now, moment.at) === 0 ? clock : `${WEEKDAYS[new Date(moment.at).getDay()].slice(0, 3)} ${clock}`;
}

/**
 * What Settings › Pipelines watches: the user's favorite pipelines (when
 * included; the collector reads them, so their number is not known here)
 * plus the ones named in the list. Never "0 watched" while favorites are
 * watched.
 */
export function companionPipelineWatchLine(includeFavorites: boolean, named: number): string {
  const listed = `${named} ${named === 1 ? 'pipeline' : 'pipelines'} listed here`;
  if (includeFavorites) return named > 0 ? `Watching your favorites and ${listed}` : 'Watching your favorite pipelines';
  return named > 0 ? `Watching the ${listed}` : 'Not watching any pipelines: list some, or include your favorites';
}

/** Snooze choices from `now` (local time): an hour from now, and 09:00 tomorrow. */
export function companionSnoozeTimes(now: number): { hour: number; tomorrow: number } {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return { hour: now + 60 * 60_000, tomorrow: tomorrow.getTime() };
}

/** When a reminder or watch goes off, in a few words. */
export function companionReminderWhen(reminder: CompanionReminderDto, itemTitle: string | null, now: number): string {
  if (reminder.kind === 'watch') {
    const until = reminder.until ? `until ${reminder.until}` : 'watching';
    return itemTitle ? `${until} · ${itemTitle}` : until;
  }
  if (reminder.dailyAt) return `Workdays at ${reminder.dailyAt}`;
  if (reminder.at !== null) {
    const at = new Date(reminder.at);
    const today = new Date(now);
    const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (at.toDateString() === today.toDateString()) return `Today ${time}`;
    today.setDate(today.getDate() + 1);
    if (at.toDateString() === today.toDateString()) return `Tomorrow ${time}`;
    return `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
  }
  return '';
}
