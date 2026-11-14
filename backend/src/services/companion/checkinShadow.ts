/**
 * P6a's shadow (unification D11): on each scheduler tick the check-in lane
 * looks with the coordinator's planner (checkinPlanner.ts) and records when it
 * would have started a check-in, while the coordinator still starts them.
 *
 * It keeps its own planner state and its own cursors, read from the database
 * once and moved only by its own check-ins, so what the coordinator covers
 * between two ticks does not hide an opportunity from it, and it writes
 * nothing the coordinator reads: no cursor, no delegation, no brief. A check-in
 * it would start holds its lane until the coordinator's twin (the same kind,
 * started within a tick or so) ends, and then covers what the twin's outcome
 * would have: the lane runs the same model on the same material. With no twin
 * it counts as having run. A row is a kind and a time, never a title or text,
 * kept 30 days.
 *
 * reconcileCheckinShadow compares those rows with the check-ins the
 * coordinator started (companion_runs with a turn), for the local report
 * (scripts/checkin-shadow-report.ts): after seven days with five briefs the
 * two should agree, each start within a tick or so of the other's.
 */

import type { DatabaseSync } from 'node:sqlite';
import { LOCAL_AGENT_OWNER_ID } from '../agentOwner';
import { getDb } from '../db';
import {
  CheckinPlanState, dbCheckinCursors, lookForCheckin, settleCheckin,
  type CheckinCursors, type CheckinGates, type CheckinPlan,
} from './checkinPlanner';
import { localDateKey } from './clock';
import { listOpenDelegations, type CompanionMetaKey } from './repository';
import { getCompanionSettings } from './settings';
import type { CompanionMichiSource } from './sources/michi';
import type { CompanionDelegationRecord } from './types';

const SHADOW_KEPT_MS = 30 * 24 * 60 * 60_000;
/** Two scheduler ticks: a start this close to the other engine's of the same kind is the same check-in. */
export const CHECKIN_SHADOW_TOLERANCE_MS = 60_000;

/** The longest a check-in holds the lane: its 240 s, and a tick. */
const SHADOW_TURN_CAP_MS = 5 * 60_000;

export type CheckinShadowKind = CheckinPlan['kind'];
const KINDS: readonly CheckinShadowKind[] = ['worker_report', 'wake', 'brief', 'heartbeat'];
type SettleOutcome = Parameters<typeof settleCheckin>[0]['outcome'];
const SETTLE_OUTCOMES: ReadonlySet<string> = new Set<SettleOutcome>(['spoke', 'quiet', 'error', 'skipped', 'preempted', 'superseded']);

export function recordCheckinShadowStart(kind: CheckinShadowKind, at: number, database: DatabaseSync = getDb()): void {
  database.prepare('INSERT INTO companion_checkin_shadow (owner_user_id, kind, planned_at) VALUES (?, ?, ?)').run(LOCAL_AGENT_OWNER_ID, kind, Math.floor(at));
  database.prepare('DELETE FROM companion_checkin_shadow WHERE owner_user_id = ? AND planned_at < ?').run(LOCAL_AGENT_OWNER_ID, Math.floor(at - SHADOW_KEPT_MS));
}

const PRIMED: readonly CompanionMetaKey[] = ['companion:wake_cursor', 'companion:brief_cursor', 'companion:last_wake_at', 'companion:last_heartbeat_at'];

/**
 * The shadow's cursors: the database's when first seen, its own check-ins'
 * after. Each look primes them first (prime), so none is read for the first
 * time after the coordinator moved it.
 */
class ShadowCursors implements CheckinCursors {
  private readonly values = new Map<CompanionMetaKey, number | null>();
  private readonly briefs = new Map<string, boolean>();
  private readonly reported = new Map<string, string | null>();

  prime(now: number): void {
    for (const key of PRIMED) this.meta(key);
    this.briefToday(localDateKey(now));
    const open = listOpenDelegations();
    for (const delegation of open) this.lastReported(delegation);
    const ids = new Set(open.map((delegation) => delegation.nodeId));
    for (const nodeId of this.reported.keys()) if (!ids.has(nodeId)) this.reported.delete(nodeId);
  }

  meta(key: CompanionMetaKey): number | null {
    if (!this.values.has(key)) this.values.set(key, dbCheckinCursors.meta(key));
    return this.values.get(key)!;
  }

  set(key: CompanionMetaKey, value: number): void {
    this.values.set(key, value);
  }

  briefToday(date: string): boolean {
    if (!this.briefs.has(date)) {
      // Only today's matters: a day it has moved past is forgotten.
      this.briefs.clear();
      this.briefs.set(date, dbCheckinCursors.briefToday(date));
    }
    return this.briefs.get(date)!;
  }

  briefDone(date: string): void {
    this.briefs.clear();
    this.briefs.set(date, true);
  }

  lastReported(delegation: CompanionDelegationRecord): string | null {
    if (!this.reported.has(delegation.nodeId)) this.reported.set(delegation.nodeId, dbCheckinCursors.lastReported(delegation));
    return this.reported.get(delegation.nodeId)!;
  }

  markReported(nodeId: string, messageId: string): void {
    this.reported.set(nodeId, messageId);
  }
}

/** The coordinator's check-in nearest `at` of this kind (its twin), or null; `running` until it ends. */
function coordinatorTwin(kind: CheckinShadowKind, at: number): { outcome: string; finishedAt: number | null } | null {
  const row = getDb().prepare(`SELECT outcome, finished_at AS finishedAt FROM companion_runs WHERE owner_user_id = ? AND kind = ? AND turn_id IS NOT NULL
    AND started_at BETWEEN ? AND ? ORDER BY ABS(started_at - ?) LIMIT 1`)
    .get(LOCAL_AGENT_OWNER_ID, kind, Math.floor(at - CHECKIN_SHADOW_TOLERANCE_MS), Math.ceil(at + CHECKIN_SHADOW_TOLERANCE_MS), Math.floor(at)) as
      { outcome: string; finishedAt: number | null } | undefined;
  return row ?? null;
}

export class CheckinShadow {
  private readonly state = new CheckinPlanState();
  private readonly cursors = new ShadowCursors();
  private pending: { plan: CheckinPlan; at: number } | null = null;

  constructor(private readonly deps: {
    /** What the lane would see of the user and the conversation; never the coordinator's own check-in (in P6b there is none). */
    gates(now: number): CheckinGates;
    michi: Pick<CompanionMichiSource, 'workerStates'> | null;
  }) {}

  /**
   * Reads the cursors it has not seen yet (ShadowCursors.prime). The
   * coordinator calls it ahead of its own turns, so even a check-in it starts
   * before the lane's first look does not move a cursor the shadow has yet
   * to read. Reads only.
   */
  prime(now: number): void {
    this.cursors.prime(now);
  }

  /** One tick: the kind the lane would start now, recorded; null while its check-in runs or when nothing would start. */
  look(now: number): CheckinShadowKind | null {
    this.cursors.prime(now);
    if (this.pending && !this.settle(now)) return null;
    const look = lookForCheckin({
      now, settings: getCompanionSettings(now), gates: this.deps.gates(now), state: this.state, michi: this.deps.michi, act: false, cursors: this.cursors,
    });
    if (look.wakeCursorWhileAway !== null) this.cursors.set('companion:wake_cursor', look.wakeCursorWhileAway);
    const first = look.candidates[0];
    if (!first) return null;
    recordCheckinShadowStart(first.plan.kind, now);
    this.pending = { plan: first.plan, at: now };
    return first.plan.kind;
  }

  /** The lane's check-in ended with its twin, or ran alone: what it covered moves the shadow's cursors. False while it runs. */
  private settle(now: number): boolean {
    const { plan, at } = this.pending!;
    const twin = coordinatorTwin(plan.kind, at);
    // A twin that never ends (its process went) holds the lane no longer than a check-in can run.
    if (twin?.outcome === 'running' && now - at <= SHADOW_TURN_CAP_MS) return false;
    if (!twin && now - at <= CHECKIN_SHADOW_TOLERANCE_MS) return false;
    const outcome: SettleOutcome = !twin ? 'spoke' : SETTLE_OUTCOMES.has(twin.outcome) ? twin.outcome as SettleOutcome : 'error';
    // When the twin ended, as the lane's own check-in would have: its retry and the wake's spacing count from there.
    const endedAt = twin?.finishedAt != null && twin.finishedAt <= now ? twin.finishedAt : now;
    settleCheckin({
      plan, outcome, now: endedAt, state: this.state,
      briefPublished: () => true,
      effects: {
        advance: (key, cursor) => this.cursors.set(key, Math.max(this.cursors.meta(key) ?? 0, cursor)),
        setMeta: (key, value) => this.cursors.set(key, value),
        markReported: (nodeId, messageId) => this.cursors.markReported(nodeId, messageId),
        reportByNotice: (reports) => { for (const report of reports) this.cursors.markReported(report.delegation.nodeId, report.messageId); },
        briefSettled: (brief) => this.cursors.briefDone(brief.date),
      },
    });
    this.pending = null;
    return true;
  }
}

export interface CheckinShadowStart { kind: CheckinShadowKind; at: number }

export interface CheckinShadowDay {
  date: string;
  counts: Record<CheckinShadowKind, { shadow: number; coordinator: number }>;
  /** The day's first brief start of each side; null when it had none. */
  brief: { shadow: number | null; coordinator: number | null };
}

export interface CheckinShadowReport {
  from: number;
  to: number;
  toleranceMs: number;
  days: CheckinShadowDay[];
  /** Starts of the same kind on both sides within toleranceMs of each other. */
  matched: number;
  shadowOnly: CheckinShadowStart[];
  coordinatorOnly: CheckinShadowStart[];
}

/**
 * The shadow's starts beside the coordinator's between `from` and `to`, by
 * local day and kind. Each shadow start pairs with the nearest unpaired
 * coordinator start of its kind within `toleranceMs` (two 30 s ticks by
 * default: the scheduler's and the coordinator's). Read only.
 * @internal Only backend/scripts/checkin-shadow-report.ts (and tests) call it; production code does not.
 */
export function reconcileCheckinShadow(database: DatabaseSync, from: number, to: number, toleranceMs = CHECKIN_SHADOW_TOLERANCE_MS): CheckinShadowReport {
  const placeholders = KINDS.map(() => '?').join(',');
  const shadowRows = database.prepare(`SELECT kind, planned_at AS at FROM companion_checkin_shadow
    WHERE owner_user_id = ? AND planned_at >= ? AND planned_at < ? AND kind IN (${placeholders}) ORDER BY planned_at`)
    .all(LOCAL_AGENT_OWNER_ID, from, to, ...KINDS) as unknown as CheckinShadowStart[];
  // A check-in the coordinator started has its chat turn; a skipped or refused one never had.
  const coordinatorRows = database.prepare(`SELECT kind, started_at AS at FROM companion_runs
    WHERE owner_user_id = ? AND started_at >= ? AND started_at < ? AND kind IN (${placeholders}) AND turn_id IS NOT NULL ORDER BY started_at`)
    .all(LOCAL_AGENT_OWNER_ID, from, to, ...KINDS) as unknown as CheckinShadowStart[];

  // Plain objects: the rows node:sqlite returns have no prototype.
  const shadow = shadowRows.map((row) => ({ kind: row.kind, at: row.at }));
  const coordinator = coordinatorRows.map((row) => ({ kind: row.kind, at: row.at }));
  const paired = new Set<number>();
  const shadowOnly: CheckinShadowStart[] = [];
  let matched = 0;
  for (const start of shadow) {
    let best = -1;
    for (let index = 0; index < coordinator.length; index += 1) {
      const other = coordinator[index]!;
      if (paired.has(index) || other.kind !== start.kind || Math.abs(other.at - start.at) > toleranceMs) continue;
      if (best === -1 || Math.abs(other.at - start.at) < Math.abs(coordinator[best]!.at - start.at)) best = index;
    }
    if (best === -1) shadowOnly.push(start);
    else {
      paired.add(best);
      matched += 1;
    }
  }
  const coordinatorOnly = coordinator.filter((_start, index) => !paired.has(index));

  const days = new Map<string, CheckinShadowDay>();
  const day = (at: number) => {
    const date = localDateKey(at);
    let entry = days.get(date);
    if (!entry) {
      entry = { date, counts: { worker_report: { shadow: 0, coordinator: 0 }, wake: { shadow: 0, coordinator: 0 }, brief: { shadow: 0, coordinator: 0 },
        heartbeat: { shadow: 0, coordinator: 0 } },
        brief: { shadow: null, coordinator: null } };
      days.set(date, entry);
    }
    return entry;
  };
  for (const start of shadow) {
    const entry = day(start.at);
    entry.counts[start.kind].shadow += 1;
    if (start.kind === 'brief') entry.brief.shadow ??= start.at;
  }
  for (const start of coordinator) {
    const entry = day(start.at);
    entry.counts[start.kind].coordinator += 1;
    if (start.kind === 'brief') entry.brief.coordinator ??= start.at;
  }
  return { from, to, toleranceMs, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), matched, shadowOnly, coordinatorOnly };
}
