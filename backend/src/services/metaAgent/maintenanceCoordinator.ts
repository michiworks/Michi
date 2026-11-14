import { getDb } from '../db';
import { log } from '../logger';
import { conversationCompletionCounter, readableTurnsFrom } from '../conversationUpdates';
import { getMaintenanceConfig, listMaintenanceBacklog, listQueuedMaintenanceRequests, maintenancePlanWaitsOnEditLeases } from '../pages/maintenanceRepository';
import { homeMaintenancePending } from './firstRun';
import { watchDue } from './watches';
import type { ScheduledJobRecord } from '../scheduledJobs/repository';
import { LOCAL_AGENT_OWNER_ID, workspaceOwnerMatches } from '../agentOwner';
import { CONVERSATION_UPDATES_LIMITS, isSystemWorkspaceSettings } from 'michi-shared';
import { CONSOLIDATION_LIMITS } from '../memory/consolidationPolicy';
import { isMemoryExtractionJob } from '../memory/extractionRepository';
import { isCheckinIdentityJob } from '../companion/checkinIdentity';
import { memoryExtractionHasWork } from '../memory/extractionRun';
import { humanTurnRunning, lastHumanActivityAt } from '../memory/typedText';
import { michiPause } from '../michiPause';
import { isSignInFailure } from './stopReason';

export const MAINTENANCE_CHECK_INTERVAL_MS = 60_000;

/** How long an execution stopped by a sign-in failure waits before it is tried again. */
const SIGN_IN_RETRY_MS = 60 * 60_000;

/**
 * Stopped after repeated failures (the scheduler's auto-pause). A sign-in or
 * credential failure clears up outside Michi, so that stop holds only for
 * SIGN_IN_RETRY_MS after its last failure; the scheduler lifts it for the
 * run, and one more failure stops it again (scheduler.ts).
 */
function heldByAutoPause(record: ScheduledJobRecord, now: number): boolean {
  if (!record.autoPaused) return false;
  return !isSignInFailure(record.lastError) || now < record.updatedAt + SIGN_IN_RETRY_MS;
}

/** The last run failed on sign-in, and the sign-in was renewed after it: no hold or backoff waits for that failure. */
function signInRenewedSince(record: ScheduledJobRecord, renewedAt: number | null): boolean {
  return renewedAt !== null && renewedAt > record.updatedAt && isSignInFailure(record.lastError);
}

/** `paused`: Pause Michi now (michiPause.ts). */
export function maintenanceCoordinatorState(ownerUserId: string, now: number = Date.now()): { paused: boolean; lastCheckedAt: number | null } {
  const row = getDb().prepare('SELECT last_checked_at FROM meta_agent_maintenance_state WHERE owner_user_id=?')
    .get(ownerUserId) as { last_checked_at: number | null } | undefined;
  return { paused: michiPause(ownerUserId, now).paused, lastCheckedAt: row?.last_checked_at ?? null };
}

/**
 * Whether the automatic path reads the new turns past `cursor` now, by memory consolidation's
 * triggers (the 2026-11-09 decision): the user has been idle for idleMs (no turn they typed into
 * runs), or waitingTrigger turns wait, or the oldest waited oldestWaitingMs; and the owner's
 * previous incremental batch, in any workspace, started at least spacingMs ago. A full batch
 * (CONVERSATION_UPDATES_LIMITS.defaultLimit turns) waits for none of these: waiting would not make it larger.
 */
function incrementalBatchDue(workspaceId: string, ownerUserId: string, cursor: number, now: number): boolean {
  const readable = readableTurnsFrom(workspaceId, ownerUserId);
  const waiting = getDb().prepare(`SELECT COUNT(*) AS n, MIN(t.completed_at) AS oldest ${readable.sql} AND t.completion_seq > ?`)
    .get(...readable.params, cursor) as { n: number; oldest: number | null };
  if (waiting.n >= CONVERSATION_UPDATES_LIMITS.defaultLimit) return true;
  const last = getDb().prepare(`SELECT MAX(created_at) AS at FROM page_maintenance_plans
    WHERE owner_user_id=? AND scope_space_id IS NULL AND reconsider_of_plan_id IS NULL`).get(ownerUserId) as { at: number | null };
  if (last.at !== null && now - last.at < CONSOLIDATION_LIMITS.spacingMs) return false;
  if (!humanTurnRunning() && now - (lastHumanActivityAt() ?? 0) >= CONSOLIDATION_LIMITS.idleMs) return true;
  return waiting.n >= CONSOLIDATION_LIMITS.waitingTrigger
    || (waiting.oldest !== null && now - waiting.oldest >= CONSOLIDATION_LIMITS.oldestWaitingMs);
}

/**
 * Database-only discovery; no run, session or model is created by a check. `automatic`: the
 * coordinator's own check, for which new conversation turns wait for incrementalBatchDue and the
 * Spaces Home summary for its cadence (homeSummaryDue), and Pause Michi holds it; a manual start
 * (Run now, Retry) never waits and runs while Michi is paused.
 */
export function maintenanceHasWork(workspaceId: string, ownerUserId: string, now: number, automatic = false): boolean {
  const config = getMaintenanceConfig(workspaceId, ownerUserId);
  if (!config || !config.enabled || config.paused || (automatic && michiPause(ownerUserId, now).paused)) return false;
  const workspace = getDb().prepare('SELECT owner_user_id,settings FROM workspaces WHERE id=? AND deleted_at IS NULL AND purged_at IS NULL AND archived_at IS NULL')
    .get(workspaceId) as { owner_user_id: string | null; settings: string | null } | undefined;
  if (!workspace || !workspaceOwnerMatches(workspace.owner_user_id, ownerUserId) || isSystemWorkspaceSettings(workspace.settings)) return false;
  if (homeMaintenancePending(workspaceId, ownerUserId, now, !automatic)) return true;
  // A due watch runs ahead of conversation work (scheduler.execute), so a plan waiting on edit leases does not hold it.
  if (watchDue(workspaceId, ownerUserId, now)) return true;
  if (listQueuedMaintenanceRequests(workspaceId, ownerUserId).length) return true;
  // A run resumes the first unfinished plan before it reads new turns (scheduler.execute). While
  // that plan only waits for conversations editing its pages, a run could do nothing but defer again.
  const unfinished = listMaintenanceBacklog(workspaceId, ownerUserId).plans.find(plan => plan.state === 'routing' || plan.state === 'processing');
  if (unfinished) return !maintenancePlanWaitsOnEditLeases(unfinished.id, ownerUserId, now).waiting;
  if (conversationCompletionCounter(workspaceId) <= config.completionCursor) return false;
  return !automatic || incrementalBatchDue(workspaceId, ownerUserId, config.completionCursor, now);
}

/**
 * Discovery for one execution identity. A workspace has up to two: its Pages
 * maintenance, and its automatic memory extraction (memory/extractionRun.ts),
 * which shares this coordinator's lease, capacity and backoff, but not its
 * pause: memory follows only Settings › Memory.
 * `automatic`: the coordinator's own check, for which extraction reads a
 * conversation only once it is due (quiet, or enough turns waiting) and Pages
 * work waits as maintenanceHasWork says; a manual start never waits.
 */
export function maintenanceExecutionHasWork(record: Pick<ScheduledJobRecord, 'id' | 'workspaceId' | 'ownerUserId'>, now: number, automatic = false): boolean {
  const ownerUserId = record.ownerUserId ?? LOCAL_AGENT_OWNER_ID;
  // The check-in lane's identity is the lane's to start, never this coordinator's.
  if (isCheckinIdentityJob(record.id)) return false;
  if (isMemoryExtractionJob(record.id)) {
    return memoryExtractionHasWork({ jobId: record.id, workspaceId: record.workspaceId, ownerUserId }, now, automatic);
  }
  return maintenanceHasWork(record.workspaceId, ownerUserId, now, automatic);
}

/** One coordinator shares the existing host lease and execution admission.
 * Workspace records are execution identities, not independently timed jobs.
 * Pending work is durable in plans/cursors/requests; wakeups are only hints.
 */
export class MaintenanceCoordinator {
  private nextCheckAt = 0;
  /**
   * Jobs a person started that found no free slot (scheduler.startNow), or whose manual run went
   * to the Spaces Home summary: their next start is manual too, without the automatic waits.
   * Held in memory: a restart drops them.
   */
  private readonly asked = new Set<string>();
  /** `signInRenewedAt`: when this computer's sign-in was last seen renewed (authStatus.ts). */
  constructor(private readonly signInRenewedAt: () => number | null = () => null) {}
  wake(): void { this.nextCheckAt = 0; }
  ask(jobId: string): void { this.asked.add(jobId); }
  asks(jobId: string): boolean { return this.asked.has(jobId); }

  check(now: number, records: ScheduledJobRecord[], start: (record: ScheduledJobRecord, manual: boolean) => boolean): void {
    if (now < this.nextCheckAt) return;
    this.nextCheckAt = now + MAINTENANCE_CHECK_INTERVAL_MS;
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    const dayStart = day.getTime();
    const owners = new Set(records.map(record => record.ownerUserId ?? LOCAL_AGENT_OWNER_ID));
    for (const owner of owners) {
      // An owner's first row keeps maintenance paused, as it was without one.
      getDb().prepare(`INSERT INTO meta_agent_maintenance_state(owner_user_id,paused,last_checked_at,check_day_start,check_count) VALUES(?,1,?,?,1)
        ON CONFLICT(owner_user_id) DO UPDATE SET last_checked_at=excluded.last_checked_at,
          check_day_start=excluded.check_day_start,
          check_count=CASE WHEN meta_agent_maintenance_state.check_day_start=excluded.check_day_start
            THEN meta_agent_maintenance_state.check_count+1 ELSE 1 END`).run(owner, now, dayStart);
    }
    // Least recently served first; a busy workspace yields after every batch.
    records.sort((a, b) => (a.lastRunAt ?? -1) - (b.lastRunAt ?? -1) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const renewedAt = this.signInRenewedAt();
    for (const record of records) {
      const manual = this.asked.has(record.id);
      if (!record.enabled) { this.asked.delete(record.id); continue; }
      // A sign-in renewed since the run stopped on it skips the hold and the backoff; Pause Michi still holds it (hasWork).
      const renewed = signInRenewedSince(record, renewedAt);
      if (!renewed && heldByAutoPause(record, now)) { this.asked.delete(record.id); continue; }
      const retryMs = Math.min(60 * 60_000, MAINTENANCE_CHECK_INTERVAL_MS * 2 ** Math.min(6, Math.max(0, record.consecutiveFailures - 1)));
      if (!manual && !renewed && record.consecutiveFailures > 0 && record.lastRunAt !== null && now < record.updatedAt + retryMs) continue;
      try {
        if (!maintenanceExecutionHasWork(record, now, !manual)) { this.asked.delete(record.id); continue; }
        if (start(record, manual)) { this.asked.delete(record.id); break; }
      } catch (error) {
        log.warn('scheduler', 'maintenance discovery failed', { workspaceId: record.workspaceId, error: String(error) });
      }
    }
  }
}
