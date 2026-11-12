import { isSystemWorkspaceSettings, type MemoryExtractionStatus, type MemoryExtractionState, type ScheduledJobSchedule } from 'michi-shared';
import { maintenanceRuntimeAvailability } from '../../agents/maintenancePolicy';
import { LOCAL_AGENT_OWNER_ID, workspaceOwnerMatches } from '../agentOwner';
import { conversationCompletionCounter } from '../conversationUpdates';
import { getDb, runInTransaction } from '../db';
import { log } from '../logger';
import { resolveMetaAgentRuntime } from '../metaAgent/settings';
import { startOfLocalDay } from '../metaAgent/todayUsage';
import { learnsInWorkspace } from './assistantConversation';
import { EXTRACTION_EXCLUSIONS } from './extractionPolicy';
import {
  clearExtractionCursorJob, ensureExtractionEnabledAt, extractionSourceCount, extractionTokensOn, getExtractionCursor, getExtractionState,
  insertExtractionCursor, insertExtractionTombstone, isExtractionRunLive, listAutoModeOwners, listExtractionCursorsWithoutJob, listExtractionJobStates,
  listRecentExtractionRuns, liveExtractionRunCount, memoryBodyHash, pendingExtractedMemoryCount, pendingMaybeGlobalMemoryIds,
  restartExtractionAt, setExtractionCursorJob, setExtractionPaused, setExtractionWorkspacePaused,
} from './extractionRepository';
import {
  extractionHold, extractionLocalOnly, extractionPending, extractionWorkspace, globalMaintenancePaused, MEMORY_EXTRACTION_LIMITS,
} from './extractionRun';
import { listOwnersWithStoredMode, markMovedFromExplicit } from './memoryRepository';
import {
  getMemorySettings, memoryEvents, MemoryError, onMemoryRemoved, setMemorySettings, type MemorySettingsChangedEvent,
} from './memoryService';
import { installUserProfileHooks } from './userProfile';

/**
 * Wiring of automatic memory extraction: enrollment of a workspace's
 * completion-feed consumer, the tombstone hook on removed memories, the C5
 * status and the pause/resume/cancel controls. The scheduler owns execution
 * (scheduler.ts, maintenanceCoordinator.ts); this module only creates the
 * execution identities it runs and asks it to cancel or wake them. Its
 * minute check finds the conversations due (extractionRun.ts).
 */

/** The scheduler surface this module uses. */
export interface MemoryExtractionScheduler {
  createMaintenanceExecution(raw: unknown, ownerUserId: string): { id: string };
  deleteJob(id: string): void;
  updateJob(id: string, raw: unknown): unknown;
  cancelActiveRun(jobId: string): boolean;
  wakeJobs(jobIds: readonly string[]): void;
}

const UNSUPPORTED_REASON = 'Automatic memory runs only on a local Michi backend with background jobs; explicit memory still works.';

const EXECUTION_PROMPT = 'Extract memories from completed conversation turns with one memory_extract call.';

/** meta key: owners of the retired explicit-only mode were moved to auto (once per database). */
const RETIRED_EXPLICIT_MODE_META_KEY = 'memory_explicit_mode_migrated_v1';

let attachedScheduler: MemoryExtractionScheduler | null = null;

/** The running scheduler, for waking and cancelling extraction runs from settings changes and the profile's rebuild requests. */
export function attachMemoryExtractionScheduler(scheduler: MemoryExtractionScheduler): () => void {
  attachedScheduler = scheduler;
  return () => {
    if (attachedScheduler === scheduler) attachedScheduler = null;
  };
}

/** Wakes the attached scheduler's coordinator (a rebuild the user asked for); nothing without one. */
export function wakeMemoryExtraction(): void {
  attachedScheduler?.wakeJobs([]);
}

// ── enrollment ───────────────────────────────────────────────────────────────

function enrollableWorkspaces(ownerUserId: string): Array<{ id: string; createdAt: number; system: boolean }> {
  const rows = getDb().prepare(`SELECT id, owner_user_id, settings, created_at FROM workspaces
    WHERE deleted_at IS NULL AND purged_at IS NULL AND archived_at IS NULL ORDER BY created_at, id`).all() as
    Array<{ id: string; owner_user_id: string | null; settings: string | null; created_at: number }>;
  return rows.filter((row) => workspaceOwnerMatches(row.owner_user_id, ownerUserId) && learnsInWorkspace(row.settings))
    .map((row) => ({ id: row.id, createdAt: row.created_at, system: isSystemWorkspaceSettings(row.settings) }));
}

/**
 * Creates the missing per-workspace cursors of an owner in auto mode (the
 * default). The first enrollment, or turning auto mode on, starts every
 * existing workspace at its current completion position (no backfill); a
 * workspace created after that starts at 0. The assistant's workspace starts
 * at its current position whenever it was made: V is read from the moment
 * memory first learns from it, as a conversation that comes back to learn.
 * Pausing keeps the cursors, so resuming continues where extraction stopped;
 * turning memory off and on again skips what happened meanwhile
 * (onSettingsChanged). Database only.
 */
export function enrollMemoryExtraction(ownerUserId: string, now: number): void {
  if (!extractionLocalOnly() || getMemorySettings(ownerUserId).mode !== 'auto') return;
  const enabledAt = getExtractionState(ownerUserId).enabledAt ?? ensureExtractionEnabledAt(ownerUserId, now);
  for (const workspace of enrollableWorkspaces(ownerUserId)) {
    if (getExtractionCursor(workspace.id, ownerUserId)) continue;
    insertExtractionCursor({ workspaceId: workspace.id, ownerUserId,
      cursor: workspace.createdAt > enabledAt && !workspace.system ? 0 : conversationCompletionCounter(workspace.id), now });
  }
}

/**
 * Called from each scheduler tick: enrolls new workspaces of owners in auto
 * mode (the local user too while it has no memory setting: memory is on by
 * default) and gives every consumer its execution identity in the shared
 * ledger.
 */
export function sweepMemoryExtraction(scheduler: MemoryExtractionScheduler, now: number): void {
  if (!extractionLocalOnly()) return;
  const failed = (error: unknown, workspaceId?: string) => log.warn('scheduler', 'automatic memory enrollment failed', {
    ...(workspaceId ? { workspaceId } : {}), error: error instanceof Error ? error.message : String(error),
  });
  for (const ownerUserId of listAutoModeOwners(LOCAL_AGENT_OWNER_ID)) {
    try {
      enrollMemoryExtraction(ownerUserId, now);
    } catch (error) {
      failed(error);
      continue;
    }
    // One workspace's identity that cannot be made holds up no other's. The scheduler takes the assistant's workspace for
    // these internal executions only (server.ts maintenanceWorkspaceExists), never for a job.
    for (const cursor of listExtractionCursorsWithoutJob(ownerUserId)) {
      try {
        if (!extractionWorkspace(cursor.workspaceId, ownerUserId)) continue;
        if (cursor.jobId) clearExtractionCursorJob(cursor.workspaceId, ownerUserId, now);
        const job = scheduler.createMaintenanceExecution({
          workspaceId: cursor.workspaceId, name: 'Automatic memory', prompt: EXECUTION_PROMPT,
          schedule: { kind: 'every', everySeconds: 60 } satisfies ScheduledJobSchedule,
          runtimeId: null, providerId: null, modelId: null, reasoning: null,
          permissionMode: 'trust', sessionMode: 'fresh', notify: false, enabled: true,
          timeoutSeconds: MEMORY_EXTRACTION_LIMITS.timeoutSeconds, conversationUpdates: false,
        }, ownerUserId);
        if (!setExtractionCursorJob(cursor.workspaceId, ownerUserId, job.id, now)) scheduler.deleteJob(job.id);
      } catch (error) {
        failed(error, cursor.workspaceId);
      }
    }
  }
}

// ── hooks ────────────────────────────────────────────────────────────────────

/** A deleted or rejected memory leaves its source turn and body hash, never its text. */
function writeTombstone({ record, reason }: { record: { ownerUserId: string; scope: { kind: 'user' } | { kind: 'workspace'; workspaceId: string }; body: string; source: { turnId?: string } | null }; reason: 'deleted' | 'rejected' }): void {
  insertExtractionTombstone({
    ownerUserId: record.ownerUserId, workspaceId: record.scope.kind === 'workspace' ? record.scope.workspaceId : null,
    sourceTurnId: record.source?.turnId ?? null, bodyHash: memoryBodyHash(record.body), reason, now: Date.now(),
  });
}

/** Conversations from while memory was off (or explicit-only, before it was retired) are never read (user decision, 2026-11-03). */
function restartAtCurrentPosition(ownerUserId: string, now: number): void {
  if (extractionLocalOnly()) restartExtractionAt(ownerUserId, (workspaceId) => conversationCompletionCounter(workspaceId), now);
}

function onSettingsChanged(event: MemorySettingsChangedEvent): void {
  if (event.mode === 'auto') {
    const now = Date.now();
    if (event.previousMode !== 'auto') restartAtCurrentPosition(event.ownerUserId, now);
    enrollMemoryExtraction(event.ownerUserId, now);
    attachedScheduler?.wakeJobs([]);
  } else if (event.previousMode === 'auto' && attachedScheduler) {
    cancelMemoryExtraction(event.ownerUserId, attachedScheduler);
  }
}

/**
 * Registers the tombstone hook, the profile's (a removed memory takes the
 * profile lines citing it: userProfile.ts) and the mode listener once;
 * returns an uninstall for tests.
 */
export function installMemoryExtractionHooks(): () => void {
  const removeHook = onMemoryRemoved(writeTombstone);
  const removeProfileHook = installUserProfileHooks();
  memoryEvents.on('settingsChanged', onSettingsChanged);
  return () => { removeHook(); removeProfileHook(); memoryEvents.off('settingsChanged', onSettingsChanged); };
}

/**
 * Once per database, at startup: owners who chose the retired explicit-only
 * mode are stored as auto, like everyone else (memory is on until turned
 * off). As when auto mode is switched on, nothing they said before is read:
 * their extraction consumers move to the current completion position. The
 * mode in effect does not change ('explicit' already reads as auto), so no
 * settingsChanged event is sent. Returns the owners moved, or null when this
 * already ran.
 */
export function migrateRetiredExplicitMode(now = Date.now()): string[] | null {
  return runInTransaction(() => {
    const db = getDb();
    if (db.prepare('SELECT 1 FROM meta WHERE key = ?').get(RETIRED_EXPLICIT_MODE_META_KEY)) return null;
    const owners = listOwnersWithStoredMode('explicit');
    for (const ownerUserId of owners) {
      setMemorySettings(ownerUserId, { mode: 'auto' });
      restartAtCurrentPosition(ownerUserId, now);
      // Settings › Memory tells them once that memory now learns on its own.
      markMovedFromExplicit(ownerUserId, now);
    }
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(RETIRED_EXPLICIT_MODE_META_KEY, String(now));
    return owners;
  });
}

// ── controls ─────────────────────────────────────────────────────────────────

/**
 * Pause stops new executions now; a running one finishes its batch. Resume
 * also restarts consumers the scheduler stopped after repeated failures.
 */
export function setMemoryExtractionPaused(input: {
  ownerUserId: string; workspaceId?: string; paused: boolean; now: number; scheduler: MemoryExtractionScheduler | null;
}): void {
  const states = listExtractionJobStates(input.ownerUserId);
  if (input.workspaceId !== undefined) {
    if (!setExtractionWorkspacePaused(input.workspaceId, input.ownerUserId, input.paused, input.now)) {
      throw new MemoryError('not_found', 'Automatic memory has not started for this workspace');
    }
  } else {
    setExtractionPaused(input.ownerUserId, input.paused, input.now);
  }
  if (input.paused || !input.scheduler) return;
  for (const state of states) {
    if (!state.jobId || !state.autoPaused || (input.workspaceId !== undefined && state.workspaceId !== input.workspaceId)) continue;
    try { input.scheduler.updateJob(state.jobId, { enabled: true }); }
    catch (error) { log.warn('scheduler', 'could not restart automatic memory', { jobId: state.jobId, error: String(error) }); }
  }
  input.scheduler.wakeJobs([]);
}

/** Cancels the owner's running extraction (one workspace's, with workspaceId); it records as cancelled and saves nothing. */
export function cancelMemoryExtraction(ownerUserId: string, scheduler: MemoryExtractionScheduler, workspaceId?: string): number {
  let cancelled = 0;
  for (const state of listExtractionJobStates(ownerUserId)) {
    if (!state.jobId || (workspaceId !== undefined && state.workspaceId !== workspaceId)) continue;
    if (scheduler.cancelActiveRun(state.jobId)) cancelled += 1;
  }
  return cancelled;
}

// ── status (C5) ──────────────────────────────────────────────────────────────

/** What Settings › Memory › Details describes: extraction and the profile. Consolidation runs unseen; only Today's tokens count them (the limit is shared). */
const SHOWN_RUN_KINDS = ['extract', 'profile'] as const;

export function memoryExtractionStatus(ownerUserId: string, now: number, scheduler: MemoryExtractionScheduler | null): MemoryExtractionStatus {
  const supported = !!scheduler && extractionLocalOnly();
  const enabled = getMemorySettings(ownerUserId).mode === 'auto';
  const owner = getExtractionState(ownerUserId);
  const jobs = listExtractionJobStates(ownerUserId);
  const runs = listRecentExtractionRuns(ownerUserId, 10, undefined, SHOWN_RUN_KINDS);
  const todayTokens = extractionTokensOn(ownerUserId, startOfLocalDay(now));
  const latest = runs.find((run) => run.state !== 'active') ?? null;
  const availability = maintenanceRuntimeAvailability(resolveMetaAgentRuntime(ownerUserId).runtimeId);
  const stopped = jobs.find((job) => job.autoPaused);
  // A held consumer (paused, AI navigation off, the assistant's conversation on a runtime with no direct call) is skipped
  // quietly: its turns do not count as waiting.
  const waiting = jobs.some((job) => !!job.jobId && extractionHold(job, now) === null && extractionPending(job));
  const exhausted = MEMORY_EXTRACTION_LIMITS.dailyTokenLimit - todayTokens < MEMORY_EXTRACTION_LIMITS.minExecutionBudget;
  let state: MemoryExtractionState;
  let stateReason: string | null = null;
  if (!supported) { state = 'unsupported'; stateReason = UNSUPPORTED_REASON; }
  else if (!enabled) state = 'off';
  else if (!availability.available) { state = 'unsupported'; stateReason = availability.reason ?? 'The Pages upkeep runtime cannot run automatic memory'; }
  else if (owner.paused) state = 'paused';
  else if (globalMaintenancePaused(ownerUserId)) { state = 'maintenance_paused'; stateReason = 'Pages upkeep is paused (Settings, under Pages upkeep)'; }
  else if (stopped) { state = 'stopped'; stateReason = stopped.lastError ?? 'Stopped after repeated failed runs; resume to try again'; }
  else if (exhausted) { state = 'budget_exhausted'; stateReason = `Today's automatic memory limit of ${MEMORY_EXTRACTION_LIMITS.dailyTokenLimit} tokens is reached; it continues tomorrow`; }
  else if (liveExtractionRunCount(ownerUserId, SHOWN_RUN_KINDS) > 0) state = 'running';
  else if (waiting) state = 'waiting';
  else state = 'idle';
  return {
    enabled,
    paused: owner.paused,
    lastRunAt: latest ? latest.finishedAt ?? latest.startedAt : null,
    lastError: latest && latest.state !== 'succeeded' ? latest.error : null,
    pendingCount: pendingExtractedMemoryCount(ownerUserId),
    todayTokens,
    dailyTokenLimit: MEMORY_EXTRACTION_LIMITS.dailyTokenLimit,
    executionTokenLimit: MEMORY_EXTRACTION_LIMITS.executionTokenBudget,
    state,
    stateReason,
    supported,
    pausedWorkspaceIds: jobs.filter((job) => job.paused).map((job) => job.workspaceId),
    maybeGlobalMemoryIds: pendingMaybeGlobalMemoryIds(ownerUserId),
    exclusions: [...EXTRACTION_EXCLUSIONS],
    recentRuns: runs.map((run) => {
      // A run left active by a stopped backend shows as failed; its workspace's next run records it so.
      const orphaned = run.state === 'active' && !isExtractionRunLive(run.id);
      return {
        id: run.id, workspaceId: run.workspaceId, state: orphaned ? 'failed' as const : run.state,
        startedAt: run.startedAt, finishedAt: run.finishedAt, summary: run.summary,
        error: orphaned ? 'The run stopped before it finished' : run.error,
        sources: extractionSourceCount(run.id), proposed: run.proposedCount, noChange: run.noChangeCount, dropped: run.droppedCount,
        tokens: run.state === 'active' ? null : run.reportedTokens,
      };
    }),
  };
}
