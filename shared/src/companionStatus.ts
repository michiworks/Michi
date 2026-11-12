import type { CompanionCheckinKind, CompanionRunDto, CompanionSnapshotDto } from './companion';

/**
 * The agent's one-line status and its badge count, shared so the panel
 * header, the Topbar button, the backend and the tray menu
 * (CompanionTrayDto, which Electron main shows without loading this package)
 * all say the same thing (DESIGN-v2 §5.1). Moved in W0 from the frontend's
 * state/companion/companionView.ts and companionStore.ts, with the same
 * results for the same input; the W0 review added the §3.8 states, read from
 * the snapshot's activity and status.firstLook. W2-F1a switches the frontend
 * to these and drops its copies (its Chat tab's own "Checking in…" and
 * "Taking a first look…" rows included), W3-H fills CompanionTrayDto with them.
 */

/** How the status reads at a glance; the avatar dot and the tray icon follow it. */
export type CompanionStatusTone = 'ok' | 'working' | 'quiet' | 'off' | 'warn';

export interface CompanionStatusLine {
  text: string;
  tone: CompanionStatusTone;
  /**
   * The line is "Checking in…": the panel shows Stop beside it, which lets
   * the user go first (presence `composing: true` preempts the check-in,
   * DESIGN-v2 §3.8). Never set for the welcome ("Saying hello…", F4) or the
   * first look; the tray shows the line without it.
   */
  stoppable?: true;
}

/**
 * What companionStatusLine reads; a CompanionSnapshotDto is one. `activity`
 * (snapshot.activity) and `status.firstLook` give the DESIGN-v2 §3.8 states;
 * without them the line reads as before v2 ("Working…").
 */
export interface CompanionStatusLineInput extends Pick<CompanionSnapshotDto, 'settings' | 'status'> {
  activity?: readonly Pick<CompanionRunDto, 'kind' | 'outcome'>[];
}

/**
 * The check-in that runs now, from the Activity log: the kind of a run that
 * says `running` and is a turn of the agent's own (every kind but a poll and
 * a follow-up `send`, CompanionCheckinKind); null when none runs.
 */
export function companionCheckinRunning(activity: readonly Pick<CompanionRunDto, 'kind' | 'outcome'>[] | null | undefined): CompanionCheckinKind | null {
  for (const run of activity ?? []) {
    if (run.outcome === 'running' && run.kind !== 'poll' && run.kind !== 'send') return run.kind;
  }
  return null;
}

/**
 * An age in words: "just now" under a minute (and for a time in the
 * future), then "5m ago", "3h ago", "yesterday", "4d ago", "2w ago".
 */
export function companionAgo(at: number, now: number): string {
  const delta = now - at;
  if (delta < 60_000) return 'just now';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(delta / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return 'yesterday';
  const days = Math.floor(delta / 86_400_000);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

/**
 * What the agent is doing now, in one line: Off, Paused; while it works,
 * "Saying hello…" for the welcome (no Stop, F4), "Checking in…" for any
 * other check-in (stoppable), "Taking a first look…" before the welcome
 * (status.firstLook), or "Working…" when nothing tells which (DESIGN-v2
 * §3.8); then Quiet hours until 08:00, Auth expired — refresh your credentials, Budget
 * used — resumes tomorrow, or Watching · checked 2m ago (warn while a source
 * is degraded). A running check-in counts only while status.working agrees
 * (as the MVP Chat tab required), so a stale `running` row alone shows nothing.
 */
export function companionStatusLine(snapshot: CompanionStatusLineInput, now: number): CompanionStatusLine {
  const { settings, status } = snapshot;
  if (!settings.enabled || status.state === 'off') return { text: 'Off', tone: 'off' };
  if (settings.paused || status.state === 'paused') return { text: 'Paused', tone: 'off' };
  const checkin = status.working ? companionCheckinRunning(snapshot.activity) : null;
  if (checkin === 'welcome') return { text: 'Saying hello…', tone: 'working' };
  if (checkin) return { text: 'Checking in…', tone: 'working', stoppable: true };
  if (status.firstLook === true) return { text: 'Taking a first look…', tone: 'working' };
  if (status.working) return { text: 'Working…', tone: 'working' };
  if (status.state === 'quiet_hours') return { text: `Quiet hours until ${settings.quietHours.end}`, tone: 'quiet' };
  if (status.auth.valid === false) return { text: 'Auth expired — refresh your credentials', tone: 'warn' };
  if (status.turnsToday >= settings.dailyTurnBudget) return { text: 'Budget used — resumes tomorrow', tone: 'quiet' };
  const checked = status.lastCheckAt === null ? 'not checked yet' : `checked ${companionAgo(status.lastCheckAt, now)}`;
  return { text: `Watching · ${checked}`, tone: status.state === 'degraded' ? 'warn' : 'ok' };
}

/** The badge: needs_you items the user has not seen yet, plus the agent's messages since they last looked. */
export function companionBadgeCount(snapshot: Pick<CompanionSnapshotDto, 'items' | 'counts'> | null | undefined): number {
  if (!snapshot) return 0;
  const needsYou = snapshot.items.filter((item) => item.bucket === 'needs_you' && item.status === 'new').length;
  return needsYou + snapshot.counts.unreadMessages;
}
