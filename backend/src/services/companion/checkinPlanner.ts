/**
 * Which check-in to start, and what a finished one covered (unification D11,
 * P6): the one rule for the coordinator, which starts check-ins today, and for
 * the scheduler's check-in lane, which shadows it now (checkinShadow.ts) and
 * takes over in P6b. Both use this code, each with its own CheckinPlanState
 * and CheckinCursors, so a look that only plans changes nothing the other
 * engine reads.
 *
 * A look reads the database, its state and its cursors. It writes nothing
 * unless its engine asks it to act (`act`): only then does it close the
 * delegations that are over and report a reply the user already read. Moving
 * the wake's cursor while the user is away is the engine's too (CheckinLook).
 *
 * By priority (a turn of a kind waits out that kind's retry after a failure):
 *   worker_report  a conversation the agent delegated ended a turn with a reply
 *                  the user has not seen;
 *   wake           interrupting items, or items that need the user, appeared:
 *                  after a minute of batching and at least ten minutes after
 *                  the last wake, not in away mode;
 *   brief          once on each of its days at its time (briefSchedule.ts), not
 *                  away: then when the user is back;
 *   heartbeat      the work heartbeat (D18, Q24): an hour after the last one
 *                  (or the welcome), whatever changed, away too; the model
 *                  decides what it can move, and ends with nothing_to_do when
 *                  nothing.
 * None while Michi is paused, before the first welcome, while a check-in runs
 * or the conversation is busy or the user types to it.
 */

import { COMPANION_LIMITS, isOpenCompanionItem, type CompanionItemDto, type CompanionItemSubtype, type CompanionSettings } from 'michi-shared';
import { isCompanionBriefPending } from './briefSchedule';
import { atLocalClock, localDateKey } from './clock';
import {
  briefForDate,
  closeDelegation,
  companionHiddenItemTest,
  companionWelcomeDoneAt,
  getCompanionMetaNumber,
  getItem,
  isCompanionWelcomeDone,
  isSubtypeDemoted,
  latestEventSeq,
  listEventsAfter,
  listOpenDelegations,
  markDelegationReported,
  type CompanionMetaKey,
} from './repository';
import type { CompanionMichiSource, CompanionWorkerState } from './sources/michi';
import type { CompanionDelegationRecord, CompanionEventRecord, CompanionTurnKind, CompanionWorkerReport } from './types';

const MINUTE_MS = 60_000;

/** Interrupting items are batched this long before a wake (§6.6). */
export const COMPANION_WAKE_BATCH_MS = MINUTE_MS;
/** At least this long between two wakes (§6.6). */
export const COMPANION_WAKE_SPACING_MS = 10 * MINUTE_MS;
/** After a turn of a kind failed, cut short or was refused, that kind waits this long. */
export const CHECKIN_ERROR_RETRY_MS = 10 * MINUTE_MS;
/** The work heartbeat's interval (Q24: hourly, about 24 turns a day). */
export const COMPANION_HEARTBEAT_MS = 60 * MINUTE_MS;
const PREEMPT_RETRY_MS = 2 * MINUTE_MS;
const SKIP_RETRY_MS = MINUTE_MS;
/** A brief turn cut short this many times gives way to the fallback. */
const BRIEF_MAX_ATTEMPTS = 3;
/** A worker report that failed this many times goes out as a "Worker finished" notice instead. */
const WORKER_REPORT_MAX_ERRORS = 2;
/** A delegation with nothing sent or reported for a day closes; so does any after three days (DESIGN-v2 §4). */
const DELEGATION_IDLE_CLOSE_MS = COMPANION_LIMITS.delegationIdleMs;
const DELEGATION_MAX_AGE_MS = COMPANION_LIMITS.delegationMaxAgeMs;
/** Events one look reads at most (the newest ones after its cursor). */
const EVENT_WINDOW = 200;

/** Never the wake's: Michi's own health items, and a conversation waiting on the user, which attention already announces (D3). */
const NO_WAKE: ReadonlySet<CompanionItemSubtype> = new Set<CompanionItemSubtype>(['system_auth', 'system_source_error', 'michi_waiting']);

export type CheckinPlan =
  | { kind: 'worker_report'; reports: CompanionWorkerReport[] }
  | { kind: 'wake'; changes: CompanionEventRecord[]; cursor: number }
  | { kind: 'brief'; changes: CompanionEventRecord[]; cursor: number; date: string }
  | { kind: 'heartbeat' };

export interface CheckinCandidate {
  plan: CheckinPlan;
  trigger: 'delegation' | 'now-items' | 'schedule';
}

/** What an engine knows of the user and its lane when it looks. */
export interface CheckinGates {
  away: boolean;
  /** A check-in runs (or one a previous process left, or the welcome): one at a time. */
  laneBusy: boolean;
  /** The conversation is not busy and the user is not typing to it. */
  conversationFree: boolean;
}

export interface CheckinLook {
  /** By priority: the engine starts the first it can. Empty: nothing to start now. */
  candidates: CheckinCandidate[];
  /** Away: what came in goes to the brief, so the acting engine moves the wake's cursor to this. */
  wakeCursorWhileAway: number | null;
}

/**
 * Where a look reads what earlier check-ins covered: the wake's cursor and
 * time, the brief's cursor, whether the day has its brief, the reply a
 * delegation reported last. The acting engine's are the database's
 * (dbCheckinCursors); the shadow keeps its own (checkinShadow.ts).
 */
export interface CheckinCursors {
  meta(key: CompanionMetaKey): number | null;
  briefToday(date: string): boolean;
  lastReported(delegation: CompanionDelegationRecord): string | null;
}

export const dbCheckinCursors: CheckinCursors = {
  meta: (key) => getCompanionMetaNumber(key),
  briefToday: (date) => briefForDate(date) !== null,
  lastReported: (delegation) => delegation.lastReportedMessageId,
};

/** What one engine keeps between looks: the wake's batching start, each kind's retry time, brief tries, report failures. */
export class CheckinPlanState {
  wakePendingSince: number | null = null;
  readonly retryAfter = new Map<CompanionTurnKind, number>();
  readonly briefAttempts = new Map<string, number>();
  readonly workerErrors = new Map<string, number>();

  mayTry(kind: CompanionTurnKind, now: number): boolean {
    return (this.retryAfter.get(kind) ?? 0) <= now;
  }
}

/** The newest events after a cursor (at most EVENT_WINDOW), and the seq a look at them moves the cursor to. */
export function checkinEventsAfter(key: CompanionMetaKey, cursors: CheckinCursors = dbCheckinCursors): { events: CompanionEventRecord[]; cursor: number } {
  const cursor = cursors.meta(key) ?? 0;
  const latest = latestEventSeq();
  const events = latest > cursor ? listEventsAfter(Math.max(cursor, latest - EVENT_WINDOW), EVENT_WINDOW) : [];
  return { events, cursor: events.length > 0 ? events[events.length - 1]!.seq : cursor };
}

/**
 * Of these events, each item's latest one that still describes it (the item
 * is open at that version and in sight: not of a source the user turned off,
 * B15) and that `keep` accepts; never baseline sightings or resolutions.
 * Oldest first.
 */
function currentEvents(events: readonly CompanionEventRecord[], now: number, keep: (event: CompanionEventRecord, item: CompanionItemDto) => boolean): CompanionEventRecord[] {
  const hidden = companionHiddenItemTest();
  const items = new Map<string, CompanionItemDto | null>();
  const latest = new Map<string, CompanionEventRecord>();
  for (const event of events) {
    if (event.kind === 'baseline' || event.kind === 'resolved') continue;
    if (!items.has(event.itemId)) items.set(event.itemId, getItem(event.itemId));
    const item = items.get(event.itemId);
    if (!item || item.version !== event.version || !isOpenCompanionItem(item, now) || hidden(item) || !keep(event, item)) continue;
    latest.set(item.id, event);
  }
  return [...latest.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * The brief's changes: every event since its cursor (what was done and
 * resolved too), but baseline sightings and the events of items out of sight
 * (B15: a source the user turned off; its items are not resolved, so the brief
 * must not hear of them as done either). Oldest first.
 */
function briefChanges(events: readonly CompanionEventRecord[]): CompanionEventRecord[] {
  const hidden = companionHiddenItemTest();
  const items = new Map<string, CompanionItemDto | null>();
  return events.filter((event) => {
    if (event.kind === 'baseline') return false;
    if (!items.has(event.itemId)) items.set(event.itemId, getItem(event.itemId));
    const item = items.get(event.itemId);
    return !item || !hidden(item);
  });
}

/**
 * The wake's changes: interrupting items (rated now) and items that need the
 * user (the heartbeat's new needs-you, D3), of a subtype that wakes and that
 * the user's feedback did not quiet. Digest changes (an item entering stalled)
 * wait for the brief.
 */
function wakeMaterial(now: number, cursors: CheckinCursors): { changes: CompanionEventRecord[]; cursor: number } {
  const { events, cursor } = checkinEventsAfter('companion:wake_cursor', cursors);
  const changes = currentEvents(events, now, (event, item) => !NO_WAKE.has(item.subtype) && !isSubtypeDemoted(item.subtype)
    && ((event.severity === 'now' && item.severity === 'now') || item.bucket === 'needs_you'));
  return { changes, cursor };
}

function workerStatus(worker: CompanionWorkerState): string {
  if (worker.turnStatus === 'error') return worker.error === 'backend_restarted' ? 'interrupted: Michi stopped while it ran' : 'failed';
  if (worker.stopReason === 'max_tokens' || worker.stopReason === 'max_turn_requests') return 'stopped early';
  if (worker.stopReason === 'refusal') return 'declined to continue';
  return /[?？]\s*$/.test(worker.reply) ? 'completed, waiting for your answer' : 'completed';
}

/**
 * Delegated conversations that ended a turn with a reply the user has not
 * seen: the turn that answered the brief or the agent's last follow-up (the
 * latest turn: a follow-up only goes into an idle conversation). Acting, it
 * closes what is over on the way (R2.8, DESIGN-v2 §4): the conversation went
 * or was stopped, the user wrote in it (the agent's own follow-ups do not
 * count), three days passed since it started, or a day passed since the last
 * follow-up or report with nothing new; a reply the user read already counts
 * as reported, and the delegation stays followed. Not acting, it leaves them.
 */
function workerReports(michi: Pick<CompanionMichiSource, 'workerStates'> | null, now: number, act: boolean, cursors: CheckinCursors): CompanionWorkerReport[] {
  const open = listOpenDelegations();
  if (open.length === 0 || !michi) return [];
  const states = michi.workerStates(open.map((delegation) => delegation.nodeId));
  const reports: CompanionWorkerReport[] = [];
  for (const delegation of open) {
    const worker = states.get(delegation.nodeId);
    const age = now - delegation.createdAt;
    if (!worker || !worker.exists || worker.turnStatus === 'cancelled') {
      if (act) closeDelegation(delegation.nodeId, now, 'gone');
      continue;
    }
    if (worker.userTookOver) {
      if (act) closeDelegation(delegation.nodeId, now, 'took_over');
      continue;
    }
    if (age >= DELEGATION_MAX_AGE_MS) {
      if (act) closeDelegation(delegation.nodeId, now, 'age');
      continue;
    }
    const ended = worker.turnStatus === 'completed' || worker.turnStatus === 'error';
    // A reply a held-back notice left to Today (D18) is Today's now, not a report's.
    const fresh = ended && worker.messageId !== null && worker.messageId !== cursors.lastReported(delegation)
      && worker.messageId !== delegation.leftToTodayMessageId;
    if (fresh && worker.viewedAt !== null && worker.endedAt !== null && worker.viewedAt >= worker.endedAt) {
      // The user read the reply already: nothing to report; the agent keeps following.
      if (act) markDelegationReported(delegation.nodeId, worker.messageId!, now);
      continue;
    }
    if (!fresh) {
      const since = Math.max(delegation.createdAt, delegation.lastSentAt ?? 0, delegation.lastReportedAt ?? 0);
      if (act && now - since >= DELEGATION_IDLE_CLOSE_MS) closeDelegation(delegation.nodeId, now, 'idle');
      continue;
    }
    reports.push({
      delegation,
      messageId: worker.messageId!,
      status: workerStatus(worker),
      excerpt: worker.reply.slice(0, COMPANION_LIMITS.maxReportChars),
    });
  }
  return reports;
}

/**
 * Today's brief is still to come: on, one of its days, none yet, and the
 * welcome was before its time (that day the welcome is the look). The one
 * rule of briefSchedule.ts, which status.nextBriefAt follows too (B24).
 */
function briefPending(settings: CompanionSettings, now: number, cursors: CheckinCursors): boolean {
  return isCompanionBriefPending({ settings, now, welcomeAt: companionWelcomeDoneAt(), briefToday: cursors.briefToday(localDateKey(now)) });
}

/**
 * One look: updates the wake's batching in `state` and says which check-ins
 * could start now, by priority. `act`: this engine starts what it finds, so
 * the look may settle delegations on its way.
 */
export function lookForCheckin(input: {
  now: number;
  settings: CompanionSettings;
  gates: CheckinGates;
  state: CheckinPlanState;
  michi: Pick<CompanionMichiSource, 'workerStates'> | null;
  act: boolean;
  cursors?: CheckinCursors;
}): CheckinLook {
  const { now, settings, gates, state } = input;
  const cursors = input.cursors ?? dbCheckinCursors;
  const none: CheckinLook = { candidates: [], wakeCursorWhileAway: null };
  if (!isCompanionWelcomeDone() || settings.paused) return none;

  // The wake's minute of batching starts when an item for it is first seen, whatever else holds the turn back.
  // What came in while away goes to the brief and "Since you left" instead.
  const wake = wakeMaterial(now, cursors);
  let wakeCursorWhileAway: number | null = null;
  if (gates.away) {
    wakeCursorWhileAway = wake.cursor;
    state.wakePendingSince = null;
  } else if (wake.changes.length === 0) {
    state.wakePendingSince = null;
  } else {
    state.wakePendingSince ??= now;
  }
  if (gates.laneBusy || !gates.conversationFree) return { candidates: [], wakeCursorWhileAway };

  const candidates: CheckinCandidate[] = [];
  const reports = workerReports(input.michi, now, input.act, cursors);
  if (reports.length > 0 && state.mayTry('worker_report', now)) candidates.push({ plan: { kind: 'worker_report', reports }, trigger: 'delegation' });

  if (!gates.away && wake.changes.length > 0 && state.wakePendingSince !== null) {
    const lastWake = cursors.meta('companion:last_wake_at');
    if (now - state.wakePendingSince >= COMPANION_WAKE_BATCH_MS && (lastWake === null || now - lastWake >= COMPANION_WAKE_SPACING_MS)
      && state.mayTry('wake', now)) {
      candidates.push({ plan: { kind: 'wake', changes: wake.changes, cursor: wake.cursor }, trigger: 'now-items' });
    }
  }

  if (briefPending(settings, now, cursors) && now >= atLocalClock(now, settings.brief.time) && !gates.away && state.mayTry('brief', now)) {
    const changes = checkinEventsAfter('companion:brief_cursor', cursors);
    candidates.push({ plan: { kind: 'brief', changes: briefChanges(changes.events), cursor: changes.cursor, date: localDateKey(now) }, trigger: 'schedule' });
  }

  const lastHeartbeat = cursors.meta('companion:last_heartbeat_at') ?? companionWelcomeDoneAt();
  if (lastHeartbeat !== null && now - lastHeartbeat >= COMPANION_HEARTBEAT_MS && state.mayTry('heartbeat', now)) {
    candidates.push({ plan: { kind: 'heartbeat' }, trigger: 'schedule' });
  }
  return { candidates, wakeCursorWhileAway };
}

/** How long a kind waits after a turn of it ended with `outcome` without running. */
export function checkinRetryMs(outcome: 'spoke' | 'quiet' | 'error' | 'skipped' | 'preempted' | 'superseded'): number {
  return outcome === 'preempted' || outcome === 'superseded' ? PREEMPT_RETRY_MS : outcome === 'skipped' ? SKIP_RETRY_MS : CHECKIN_ERROR_RETRY_MS;
}

/** What settling a finished check-in asks of the engine that ran it. */
export interface CheckinSettleEffects {
  advance(key: CompanionMetaKey, cursor: number): void;
  setMeta(key: CompanionMetaKey, value: number): void;
  markReported(nodeId: string, messageId: string): void;
  /** The reports that failed twice: Michi's "Worker finished" notices instead. */
  reportByNotice(reports: readonly CompanionWorkerReport[]): void;
  /** Today's brief is settled: `published` when the agent wrote it, else Michi's fallback is due. */
  briefSettled(plan: Extract<CheckinPlan, { kind: 'brief' }>, published: boolean): void;
}

/**
 * What a finished check-in covered (the coordinator's afterTurn for these
 * kinds): each kind's retry, the wake's cursor and time, the reports and their
 * failures, the day's brief. One the user's message superseded ran too (the
 * model saw its material; the user is in the conversation now), but a worker's
 * report it did not post is still owed. True when it ran.
 */
export function settleCheckin(input: {
  plan: CheckinPlan;
  outcome: 'spoke' | 'quiet' | 'error' | 'skipped' | 'preempted' | 'superseded';
  now: number;
  state: CheckinPlanState;
  briefPublished: (date: string) => boolean;
  effects: CheckinSettleEffects;
}): boolean {
  const { plan, outcome, now, state, effects } = input;
  const ran = outcome === 'spoke' || outcome === 'quiet' || (outcome === 'superseded' && plan.kind !== 'worker_report');
  if (ran) state.retryAfter.delete(plan.kind);
  else state.retryAfter.set(plan.kind, now + checkinRetryMs(outcome));
  switch (plan.kind) {
    case 'worker_report':
      if (ran) {
        // Reported, and still followed (DESIGN-v2 §4): its next reply comes back too.
        for (const report of plan.reports) {
          effects.markReported(report.delegation.nodeId, report.messageId);
          state.workerErrors.delete(report.messageId);
        }
      } else if (outcome === 'error') {
        const given = plan.reports.filter((report) => {
          const errors = (state.workerErrors.get(report.messageId) ?? 0) + 1;
          state.workerErrors.set(report.messageId, errors);
          return errors >= WORKER_REPORT_MAX_ERRORS;
        });
        for (const report of given) state.workerErrors.delete(report.messageId);
        if (given.length > 0) effects.reportByNotice(given);
      }
      break;
    case 'wake':
      if (ran) {
        effects.advance('companion:wake_cursor', plan.cursor);
        effects.setMeta('companion:last_wake_at', Math.floor(now));
        state.wakePendingSince = null;
      }
      break;
    case 'brief': {
      const attempts = outcome === 'preempted' || outcome === 'skipped' ? (state.briefAttempts.get(plan.date) ?? 0) + 1 : 0;
      if (attempts > 0) state.briefAttempts.set(plan.date, attempts);
      if (ran || outcome === 'error' || attempts >= BRIEF_MAX_ATTEMPTS) effects.briefSettled(plan, input.briefPublished(plan.date));
      break;
    }
    case 'heartbeat':
      // The next one an hour from this one's end; one that did not run waits out its kind's retry.
      if (ran) effects.setMeta('companion:last_heartbeat_at', Math.floor(now));
      break;
  }
  return ran;
}
