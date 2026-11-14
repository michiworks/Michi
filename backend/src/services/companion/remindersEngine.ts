/**
 * Reminders and watches the user asked for (DESIGN R2.9, companion_reminders),
 * fired by the coordinator's tick: Michi keeps these promises, not the
 * model's memory.
 *
 * - A one-off reminder fires once its time has come (late, if Michi was not
 *   running or the Companion was paused then).
 * - A daily one fires once each workday, after its time; one made after
 *   today's time first fires tomorrow.
 * - A watch fires when its item reaches the state it waits for (watchReached):
 *   a CR seen approved (or merged) or merged, a pipeline seen recovered, an
 *   email read (it left the unread list), a Michi conversation answered (it
 *   changed or stopped waiting after the watch was set). An item that merely
 *   went away (its pipeline left the watch list or the favorites, its CR
 *   another account's list) says nothing of approval, merge or recovery.
 *
 * Firing makes (or renews) a `reminder_due` item, needs you / now, which is
 * a Needs you notice (notices.ts) like any other item, and marks the reminder fired
 * (a daily one stays active). Deterministic: no model is involved.
 */

import type { CompanionItemDto, CompanionSettings } from 'michi-shared';
import { atLocalClock, isCompanionWorkday, localClockText, localDateKey } from './clock';
import {
  companionTransaction,
  getItem,
  getSnapshot,
  listReminders,
  markReminderFired,
  upsertItem,
  type CompanionReminderRecord,
  type CompanionWatchUntil,
} from './repository';
const pipelineSeenUnblocked = (_pipeline: Record<string, unknown>): boolean => false;
import type { CompanionSnapshotRecord, ItemDraft } from './types';

export interface CompanionReminderFiring {
  reminderId: string;
  /** The reminder_due item it made or renewed. */
  itemId: string;
  kind: CompanionReminderRecord['kind'];
}

/** What the watch saw happen, before the item's own title ("Approved: CR-123 is approved"). */
const WATCH_DONE: Record<CompanionWatchUntil, string> = {
  approved: 'Approved',
  merged: 'Merged',
  recovered: 'Recovered',
  read: 'Read',
  answered: 'Answered',
};

/** The item went away after `since`. */
const resolvedSince = (item: CompanionItemDto, since: number) => item.status === 'resolved' && (item.resolvedAt ?? 0) > since;

/**
 * Whether a watch set at `since` has seen its item reach `until`.
 *
 * approved, merged and recovered wait for a state Michi saw, as the item
 * shows what its object was last seen as: a CR approved or merged (one that
 * is approved but still has a merge blocker, an unresolved critical comment
 * or a failed required analyzer, stays cr_needs_attention with its facts
 * saying approved, and that counts), merged, a pipeline recovered. The item
 * going away is no such state: its object may only have left what its
 * source watches (a pipeline taken off the watch list or the favorites, a CR
 * of the account the user switched from). The one way a pipeline's item goes
 * away recovered is while the pipeline is still watched and seen with
 * nothing blocking it (`seen`: its stored observation, null once its source
 * let it go): an approval that went through has no recovery item of its own.
 *
 * read and answered are about the item going away: an email that left the
 * unread list is read, a Michi conversation that stopped waiting (or
 * changed) after the watch was set is answered.
 */
export function watchReached(until: CompanionWatchUntil, item: CompanionItemDto, since: number, seen: CompanionSnapshotRecord | null = null): boolean {
  switch (until) {
    case 'approved':
      return item.subtype === 'cr_approved' || item.subtype === 'cr_merged' || (item.source === 'cr' && item.facts.approved === true);
    case 'merged':
      return item.subtype === 'cr_merged';
    case 'recovered':
      return item.subtype === 'pipeline_recovered'
        || (item.source === 'pipeline' && resolvedSince(item, since) && seen !== null && pipelineSeenUnblocked(seen.state));
    case 'read':
      return resolvedSince(item, since);
    case 'answered':
      return resolvedSince(item, since) || item.changedAt > since;
    default:
      return false;
  }
}

/** What a watch on `item` needs besides the item: for a recovery, the pipeline as last stored (watchReached). */
function seenFor(until: CompanionWatchUntil | null, item: CompanionItemDto | null): CompanionSnapshotRecord | null {
  return until === 'recovered' && item?.source === 'pipeline' && item.status === 'resolved' ? getSnapshot(item.source, item.itemKey) : null;
}

/** Whether an active reminder fires at `now` (`seen`: see watchReached). */
export function reminderIsDue(reminder: CompanionReminderRecord, item: CompanionItemDto | null, settings: Pick<CompanionSettings, 'workdays'>, now: number, seen: CompanionSnapshotRecord | null = null): boolean {
  if (reminder.status !== 'active') return false;
  if (reminder.kind === 'watch') return item !== null && reminder.until !== null && watchReached(reminder.until, item, reminder.createdAt, seen);
  if (reminder.at !== null) return reminder.at <= now;
  if (reminder.dailyAt) {
    if (!isCompanionWorkday(settings, now)) return false;
    const at = atLocalClock(now, reminder.dailyAt);
    return now >= at && reminder.createdAt < at && reminder.lastFiredDate !== localDateKey(now);
  }
  return false;
}

function whenText(at: number, now: number): string {
  return localDateKey(at) === localDateKey(now) ? localClockText(at) : `${localDateKey(at)} ${localClockText(at)}`;
}

/** The reminder_due item a firing makes: one item per reminder, a new version each time it fires. */
export function reminderDraft(reminder: CompanionReminderRecord, item: CompanionItemDto | null, now: number): ItemDraft {
  const daily = reminder.kind === 'time' && reminder.dailyAt !== null;
  const version = reminder.kind === 'watch' ? `watch:${reminder.until ?? ''}`
    : daily ? `daily:${localDateKey(now)}` : `at:${reminder.at ?? reminder.createdAt}`;
  const summary = reminder.kind === 'watch'
    ? `${WATCH_DONE[reminder.until ?? 'answered']}: ${item?.title ?? 'the item you watched'}`
    : daily ? `Your reminder for every workday at ${reminder.dailyAt}`
      : `Your reminder for ${whenText(reminder.at ?? now, now)}`;
  return {
    source: 'system',
    subtype: 'reminder_due',
    itemKey: `reminder:${reminder.id}`,
    version,
    bucket: 'needs_you',
    severity: 'now',
    title: reminder.text,
    summary,
    target: item?.target ?? { kind: 'companion', tab: 'today' },
    facts: {
      reminderId: reminder.id,
      reminderKind: reminder.kind,
      itemId: reminder.itemId,
      until: reminder.until,
      dailyAt: reminder.dailyAt,
      at: reminder.at,
    },
    observedAt: now,
  };
}

/** Fires every active reminder and watch that is due. Returns what fired, in reminder order. */
export function fireDueReminders(settings: Pick<CompanionSettings, 'workdays'>, now: number): CompanionReminderFiring[] {
  const fired: CompanionReminderFiring[] = [];
  for (const reminder of listReminders(['active'])) {
    const item = reminder.itemId ? getItem(reminder.itemId) : null;
    if (!reminderIsDue(reminder, item, settings, now, reminder.kind === 'watch' ? seenFor(reminder.until, item) : null)) continue;
    const itemId = companionTransaction(() => {
      if (!markReminderFired(reminder.id, now)) return null;
      return upsertItem(reminderDraft(reminder, item, now), now).item.id;
    });
    if (itemId) fired.push({ reminderId: reminder.id, itemId, kind: reminder.kind });
  }
  return fired;
}
