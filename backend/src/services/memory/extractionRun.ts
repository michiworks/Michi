import { randomUUID } from 'node:crypto';
import { estimateTokens, isSystemWorkspaceSettings, usageSummaryTotalTokens } from 'michi-shared';
import { getRuntime } from '../../agents/registry';
import type { AgentRuntime } from '../../agents/types';
import { isAssistantWorkspace } from '../../assistant/identity';
import { workspaceOwnerMatches } from '../agentOwner';
import { parseTurnMessage, readableTurnsFrom, turnMessageBounds } from '../conversationUpdates';
import { getDb, runInTransaction } from '../db';
import { getAiGlobalContext } from '../dbRepository';
import { log } from '../logger';
import { stripSentinelsStreamingSafe } from '../messageSerialization';
import { resolveBackgroundRuntime } from '../metaAgent/settings';
import { startOfLocalDay } from '../metaAgent/todayUsage';
import { ownsUnattendedRun } from '../scheduledJobs/repository';
import { companionTaintOf, getTurnTrust } from '../turnTrust';
import { learnsFromConversation, learnsInWorkspace } from './assistantConversation';
import {
  advanceConsolidationCursor, announceConsolidation, buildConsolidationPrompt, clearPlannedCursor, commitConsolidation, consolidationDue,
  consolidationListing, CONSOLIDATION_INSTRUCTIONS, CONSOLIDATION_LIMITS, CONSOLIDATION_RUN_ID_PREFIX, listedConsolidationBatch,
  liveConsolidationRun, nextConsolidationBatch, parseConsolidationListing, planConsolidationCursor, plannedCursorOf, settleUnreadableConsolidation,
  type ConsolidationHolds, type ConsolidationPayload,
} from './consolidation';
import { buildExtractionInstructions } from './extractionPolicy';
import {
  MEMORY_CONSOLIDATE_TOOL_NAME, memoryExtractionBootstrapInstructions, MEMORY_EXTRACTION_TOOL_NAMES, MEMORY_PROFILE_TOOL_NAME,
} from './extractionProfile';
import {
  addExtractionUsage, advanceConversationExtraction, conversationExtractedSeq, extractionTokensOn, failOrphanedExtractionRuns,
  finishExtractionRun, getExtractionCursor, getExtractionCursorByJob, getExtractionRun, getExtractionState, insertExtractionRun,
  lastFinishedExtractionRun, latestTombstoneSeq, listExtractionJobStates, listExtractionSources, liveExtractionRunCount,
  markExtractionBudgetExhausted, pruneConsolidation, pruneExtractionRuns, raiseExtractionCursor, recordExtractionDecision, turnsTombstonedAfter,
  turnTombstoned, workspaceCompletionCounter, type ExtractionCursor, type ExtractionRunRecord, type ExtractionSourceInput,
} from './extractionRepository';
import { buildExtractionPrompt, commitExtractionPayload, type ExtractionPayload, type ExtractionTurnInput } from './extractionV2';
import { profileMemoryCount, userScopeChangesSince } from './memoryRepository';
import { getMemorySettings, memoryVersion } from './memoryService';
import { lastTypedConversation, lastTypedInto, storedTypedText } from './typedText';
import {
  buildProfilePrompt, commitProfilePayload, listedProfileSources, memoryProfileBootstrapInstructions, profileLanguage, profileRebuildState,
  PROFILE_LIMITS, recordProfileAttempt, recordProfileFailure, type ProfilePayload,
} from './userProfile';

/**
 * One automatic extraction execution, as the scheduler runs it for a
 * workspace's execution identity (see maintenanceCoordinator): discovery that
 * never starts a model; a plan that claims the new turns of one conversation
 * and puts them inline in the prompt (extractionV2.buildExtractionPrompt);
 * one answer, a direct structured model call (extractionDirect.ts) or, on a
 * runtime without one, one memory_extract call in a maintenance session
 * (extractionTools.ts), that stages the payload; and a settle step that
 * commits the payload and the conversation's position together, only when
 * the answer came and the scheduler run is still this process's.
 *
 * When (spec §C): a conversation is read once it has been quiet for
 * EXTRACTION_QUIET_MS, or once EXTRACTION_TURN_TRIGGER of its turns wait,
 * whatever comes first; once the user left it and stayed away for
 * EXTRACTION_LEFT_GRACE_MS: they typed in another
 * conversation after its last turn (typedText.lastTypedConversation), or no
 * window shows it any more (watchConversationPresence: its pane closed or
 * switched to another conversation, its window closed), and leaving wakes
 * the scheduler's check at once, which starts that wait (server.ts: panePresence's and typedText's
 * signals). Turns older than EXTRACTION_BACKLOG_WINDOW_MS are passed over
 * without a model on automatic runs. When the user comes back to it and types while it is read,
 * that run's answer gives way and it is read again once they leave, unless
 * the next read could not take in what they said (a backlog:
 * settleMemoryExtractionRun); a run that asked a model is followed by another check about a
 * second later, so a backlog drains one conversation after another; and at
 * once, after a
 * restart, for the turns that completed before this process started
 * (markExtractionBoot): the state is durable, so what was said before a
 * shutdown is read at the next start. A manual start reads any conversation
 * that has turns waiting. The batch is the whole new part of the
 * conversation, within EXTRACTION_TURN_TRIGGER turns and the execution's
 * token budget; the rest is the next batch. An execution answered with direct
 * calls reads up to MEMORY_EXTRACTION_LIMITS.conversationsPerExecution
 * conversations, directConcurrency at a time, each a batch of its own
 * (planMemoryExtractionRun's exclude; the scheduler runs them).
 *
 * Positions: a conversation's own (memory_extraction_conversations) and the
 * workspace cursor below every turn still waiting, which rises as turns are
 * read (compactCursor), so a turn at or below it is never read again.
 *
 * When a workspace has nothing to read, its execution may instead tidy
 * Michi's own notes (consolidation.ts: a run of kind 'consolidate', on the
 * owner's designated job only, when consolidationDue says so) or else
 * rebuild the user's profile (userProfile.ts: a run of kind 'profile',
 * planned when profileRebuildDue says so). Both are answered the same two
 * ways; neither moves a conversation's position, and neither ever counts as a
 * failed execution, so they cannot hold up the workspace's extraction.
 * Consolidation shows the user nothing: its settle step returns no summary
 * and no error whatever happened.
 */

export const MEMORY_EXTRACTION_LIMITS = Object.freeze({
  /** Source turns one execution reads at most (halved after an execution reported more than its budget). */
  maxSourcesPerExecution: 20,
  /** Tokens one execution may use (Michi's estimate sizes the batch; the runtime's report is recorded). */
  executionTokenBudget: 80_000,
  /** Tokens an owner's extraction may use per local day (reported, else estimated). */
  dailyTokenLimit: 3_000_000,
  /** An execution starts only with at least this much of the daily limit left. */
  minExecutionBudget: 20_000,
  /** Invalid answers an execution may repair; the next one fails it. */
  maxRepairs: 2,
  /** Finished executions kept per workspace. */
  runsKept: 20,
  /** Scheduler timeout of one execution. */
  timeoutSeconds: 600,
  /** Conversations one scheduler run answered with direct calls reads at most, each an execution of its own ... */
  conversationsPerExecution: 8,
  /** ... and how many of those executions run at once. */
  directConcurrency: 3,
});

/** A conversation is read once it has been quiet this long ... */
export const EXTRACTION_QUIET_MS = 30 * 60_000;
/** ... or once this many of its turns wait. */
export const EXTRACTION_TURN_TRIGGER = 20;
/**
 * A conversation the user left is read once they stayed away this long, so
 * switching back and forth between panes does not split it into one-turn
 * batches (Recent conversations already shows what was just said).
 */
export const EXTRACTION_LEFT_GRACE_MS = 2 * 60_000;
/**
 * Turns that completed longer ago than this are not read automatically (a
 * catch-up after a long pause would otherwise read everything at once); a
 * manual start still reads them.
 */
export const EXTRACTION_BACKLOG_WINDOW_MS = 7 * 24 * 60 * 60_000;

export const EXTRACTION_RUN_ID_PREFIX = 'mxr-';
/** The id prefix of a run that rebuilds the user's profile. */
export const PROFILE_RUN_ID_PREFIX = 'mpr-';

/** The memory_extract schema the runtime lists. */
const TOOL_CATALOG_TOKENS = 900;
/** The related memories the prompt lists, before they are looked up. */
const RELATED_ALLOWANCE_TOKENS = 700;
/** The answer: one memory_extract call (or the JSON payload) and a closing word. */
const ANSWER_TOKENS = 1_500;

let bootAt: number | null = null;
let conversationShown: ((nodeId: string) => boolean) | null = null;
/** When each conversation was first seen left, by node id (conversationLeft). */
const leftSince = new Map<string, number>();

/**
 * This process started at `at` (server.ts, before the scheduler): turns that
 * completed earlier and still wait are read at once, without waiting for
 * their conversation to be quiet. null (tests): no such catch-up.
 */
export function markExtractionBoot(at: number | null): void {
  bootAt = at;
}

/**
 * Whether some window shows a conversation now (server.ts: the pane
 * presence the renderers report; for V, the Companion panel's beacons). One
 * that none shows was left, and is read once it stays so for
 * EXTRACTION_LEFT_GRACE_MS. null (tests, evaluations):
 * presence is not consulted.
 */
export function watchConversationPresence(shown: ((nodeId: string) => boolean) | null): void {
  conversationShown = shown;
  leftSince.clear();
}

// ── discovery ────────────────────────────────────────────────────────────────

interface WorkspaceRow { id: string; name: string; owner_user_id: string | null; settings: string | null; deleted_at: number | null; purged_at: number | null; archived_at: number | null; created_at: number }

/** A workspace whose conversations extraction reads: the owner's, live, and not a system one but the assistant's (V's alone: pendingConversations). */
export function extractionWorkspace(workspaceId: string, ownerUserId: string): WorkspaceRow | null {
  const row = getDb().prepare('SELECT id,name,owner_user_id,settings,deleted_at,purged_at,archived_at,created_at FROM workspaces WHERE id = ?')
    .get(workspaceId) as WorkspaceRow | undefined;
  if (!row || row.deleted_at !== null || row.purged_at !== null || row.archived_at !== null) return null;
  if (!workspaceOwnerMatches(row.owner_user_id, ownerUserId) || !learnsInWorkspace(row.settings)) return null;
  return row;
}

/** Tokens left today for the owner's extraction, after the floor that still starts an execution. */
export function extractionBudgetLeft(ownerUserId: string, now: number): number {
  return MEMORY_EXTRACTION_LIMITS.dailyTokenLimit - extractionTokensOn(ownerUserId, startOfLocalDay(now));
}

export function extractionLocalOnly(): boolean {
  return process.env.MICHI_CLOUD !== '1';
}

/**
 * Whether automatic memory answers a run on this runtime with one direct
 * structured call (extractionDirect.ts) rather than a maintenance session:
 * it has completeStructured, and MICHI_MEMORY_DIRECT is not 0.
 */
export function answersMemoryDirectly(runtime: Pick<AgentRuntime, 'completeStructured'> | undefined): boolean {
  return process.env.MICHI_MEMORY_DIRECT !== '0' && typeof runtime?.completeStructured === 'function';
}

export type ExtractionHold = 'off' | 'unsupported' | 'paused' | 'workspace_paused' | 'budget_exhausted'
  | 'workspace_unavailable' | 'navigation_off' | 'session_only';

/**
 * Why this consumer may not start an execution now, or null. Database reads only (and the
 * registered runtimes). Only Settings › Memory holds it (memory off, its pause, a workspace's
 * pause): the Meta agent's pause does not.
 */
export function extractionHold(cursor: ExtractionCursor, now: number): ExtractionHold | null {
  if (!extractionLocalOnly()) return 'unsupported';
  if (getMemorySettings(cursor.ownerUserId).mode !== 'auto') return 'off';
  if (getExtractionState(cursor.ownerUserId).paused) return 'paused';
  if (cursor.paused) return 'workspace_paused';
  const workspace = extractionWorkspace(cursor.workspaceId, cursor.ownerUserId);
  if (!workspace) return 'workspace_unavailable';
  // AI navigation off: its conversations are not read, quietly (not a failure); the turns wait.
  if (!getAiGlobalContext(cursor.workspaceId, cursor.ownerUserId)) return 'navigation_off';
  // The assistant's workspace holds no maintenance session (every chat there runs as the assistant), so V waits, quietly,
  // for a runtime that answers directly.
  if (isSystemWorkspaceSettings(workspace.settings)
    && !answersMemoryDirectly(getRuntime(resolveBackgroundRuntime(cursor.ownerUserId).runtimeId))) return 'session_only';
  if (extractionBudgetLeft(cursor.ownerUserId, now) < MEMORY_EXTRACTION_LIMITS.minExecutionBudget) return 'budget_exhausted';
  return null;
}

/** A conversation of a workspace with turns extraction has not read yet. */
export interface PendingConversation {
  nodeId: string;
  /** Its position: the turns after it wait. */
  after: number;
  /** How many turns wait. */
  pending: number;
  /** The oldest waiting turn's completion position: the oldest conversation goes first. */
  firstSeq: number;
  /** When its newest waiting turn completed. */
  lastAt: number;
  /** One of its turns is running now. */
  active: boolean;
}

/**
 * The turns extraction may read in a workspace: the feed's (conversationUpdates.ts); in the assistant's, V's archived
 * conversations' too, since New conversation and a History switch archive V at once, before what it was told is read.
 */
function extractionReadable(workspaceId: string, ownerUserId: string): ReturnType<typeof readableTurnsFrom> {
  return readableTurnsFrom(workspaceId, ownerUserId, { archivedTrees: isAssistantWorkspace(workspaceId) });
}

/**
 * Every conversation of the workspace that learns (its memory setting; of
 * the assistant's workspace, V alone, archived ones included:
 * assistantConversation.ts) with readable completed turns after both `floor`
 * and its own position, the one waiting longest first. Database reads only.
 */
function pendingConversations(workspaceId: string, ownerUserId: string, floor: number): PendingConversation[] {
  const readable = extractionReadable(workspaceId, ownerUserId);
  const position = `COALESCE((SELECT c.extracted_seq FROM memory_extraction_conversations c WHERE c.node_id = t.node_id AND c.owner_user_id = ?), 0)`;
  const rows = getDb().prepare(`SELECT t.node_id AS nodeId, COUNT(*) AS pending, MIN(t.completion_seq) AS firstSeq,
      MAX(COALESCE(t.completed_at, 0)) AS lastAt, MAX(?, ${position}) AS after,
      EXISTS (SELECT 1 FROM turns r WHERE r.node_id = t.node_id AND r.status = 'active') AS active, MAX(w.settings) AS settings
    ${readable.sql} AND n.memory_mode IS NULL AND t.completion_seq > ? AND t.completion_seq > ${position}
    GROUP BY t.node_id ORDER BY firstSeq, t.node_id`)
    .all(floor, ownerUserId, ...readable.params, floor, ownerUserId) as Array<{
      nodeId: string; pending: number; firstSeq: number; lastAt: number; after: number; active: number; settings: string | null;
    }>;
  return rows.filter((row) => learnsFromConversation(row.nodeId, row.settings))
    .map(({ settings: _settings, ...row }) => ({ ...row, active: row.active === 1 }));
}

/** Whether a conversation's waiting turns are read now (see the module comment). */
function conversationDue(conversation: PendingConversation, now: number): boolean {
  if (conversation.pending >= EXTRACTION_TURN_TRIGGER) return true;
  if (conversation.active) return false;
  return now - conversation.lastAt >= EXTRACTION_QUIET_MS || (bootAt !== null && conversation.lastAt < bootAt) || conversationLeft(conversation, now);
}

/**
 * The user moved on from it, and stayed away for EXTRACTION_LEFT_GRACE_MS:
 * typed in another conversation after its last turn, or no window shows it any
 * more. Coming back (it is shown again, or a turn of it completes) starts over.
 */
function conversationLeft(conversation: PendingConversation, now: number): boolean {
  if (!movedOn(conversation)) {
    leftSince.delete(conversation.nodeId);
    return false;
  }
  const since = leftSince.get(conversation.nodeId);
  if (since === undefined || since < conversation.lastAt) {
    leftSince.set(conversation.nodeId, now);
    return false;
  }
  return now - since >= EXTRACTION_LEFT_GRACE_MS;
}

function movedOn(conversation: PendingConversation): boolean {
  const typed = lastTypedConversation();
  if (typed && typed.nodeId !== conversation.nodeId && typed.at > conversation.lastAt) return true;
  if (!conversationShown) return false;
  try {
    return !conversationShown(conversation.nodeId);
  } catch (error) {
    log.warn('scheduler', 'automatic memory: conversation presence unavailable', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/** The conversation the consumer reads next: the first due one (any with turns waiting, for a manual start) not in `exclude`, or null. */
function nextConversation(cursor: ExtractionCursor, now: number, automatic: boolean, exclude?: ReadonlySet<string>): PendingConversation | null {
  return pendingExtractionConversation({ ownerUserId: cursor.ownerUserId, workspaceId: cursor.workspaceId, now, due: automatic, exclude });
}

/** Whether any conversation of this consumer has turns waiting, due or not (Settings › Memory: waiting). */
export function extractionPending(cursor: ExtractionCursor): boolean {
  return pendingConversations(cursor.workspaceId, cursor.ownerUserId, cursor.completionCursor).length > 0;
}

/**
 * Moves the workspace's cursor up to just below its oldest waiting turn, or
 * to its counter when nothing waits: every turn at or below it is read or
 * skipped. Call after a conversation's position moved.
 */
function compactCursor(workspaceId: string, ownerUserId: string, now: number): void {
  const cursor = getExtractionCursor(workspaceId, ownerUserId);
  if (!cursor) return;
  const waiting = pendingConversations(workspaceId, ownerUserId, cursor.completionCursor);
  const to = waiting.length ? Math.min(...waiting.map((conversation) => conversation.firstSeq)) - 1 : workspaceCompletionCounter(workspaceId);
  if (to > cursor.completionCursor) raiseExtractionCursor(workspaceId, ownerUserId, to, now);
}

/**
 * Database-only discovery for one execution identity: whether a conversation
 * is due (any with turns waiting, when `automatic` is false: a manual start)
 * and nothing holds the consumer, or, with nothing of its own to read,
 * whether the user's profile is due a rebuild (profileRebuildDue; a workspace
 * whose conversations AI navigation may not read still serves it). Never
 * creates a run, session or model call.
 */
export function memoryExtractionHasWork(input: { jobId: string; workspaceId: string; ownerUserId: string }, now: number, automatic = false): boolean {
  const cursor = getExtractionCursorByJob(input.jobId);
  if (!cursor || cursor.workspaceId !== input.workspaceId || cursor.ownerUserId !== input.ownerUserId) return false;
  const hold = extractionHold(cursor, now);
  if (hold === null || hold === 'budget_exhausted') {
    const waiting = nextConversation(cursor, now, automatic);
    if (waiting && hold === 'budget_exhausted') markExtractionBudgetExhausted(cursor.ownerUserId, startOfLocalDay(now), now);
    if (waiting && hold === null) return true;
  }
  if (!servesProfile(hold)) return false;
  if (consolidationDueOn(cursor.ownerUserId, input.jobId, now)) return true;
  return profileRebuildDue(cursor.ownerUserId, now);
}

// ── consolidation (consolidation.ts) ────────────────────────────────────────

/**
 * The job that tidies the owner's notes: the one of their earliest-created
 * extraction consumer that may run (held by nothing, or only by AI navigation
 * being off: consolidation reads memories, not conversations), so a run is
 * planned once per owner, not once per workspace.
 */
export function designatedConsolidationJob(ownerUserId: string, now: number): string | null {
  for (const state of listExtractionJobStates(ownerUserId)) {
    if (!state.jobId || state.autoPaused) continue;
    const hold = extractionHold(state, now);
    if (hold === null || hold === 'navigation_off') return state.jobId;
  }
  return null;
}

/** What consolidationDue reads of automatic memory's holds (consolidation.ts never imports this module). */
export function consolidationHolds(ownerUserId: string, now: number): ConsolidationHolds {
  const hold = !extractionLocalOnly() ? 'unsupported'
    : getMemorySettings(ownerUserId).mode !== 'auto' ? 'off'
      : getExtractionState(ownerUserId).paused ? 'paused' : null;
  return { hold, budgetLeft: extractionBudgetLeft(ownerUserId, now), minBudget: MEMORY_EXTRACTION_LIMITS.minExecutionBudget, bootAt };
}

/** A workspace consolidation may look in: the owner's, live (not archived, deleted or a system one), with AI navigation on. */
export function consolidationLiveWorkspace(ownerUserId: string): (workspaceId: string) => boolean {
  return (workspaceId) => extractionWorkspace(workspaceId, ownerUserId) !== null && getAiGlobalContext(workspaceId, ownerUserId);
}

function consolidationDueOn(ownerUserId: string, jobId: string, now: number): boolean {
  return designatedConsolidationJob(ownerUserId, now) === jobId && consolidationDue(ownerUserId, now, consolidationHolds(ownerUserId, now));
}

/**
 * A consolidation run for this consumer's execution (spec §C5), on the
 * owner's designated job when consolidationDue says so: the next batch, its
 * listing (ids and versions) and the cursor it moves to recorded before the
 * model sees anything. A batch with no pair moves the cursor past its inputs
 * at once, with no run and no model (null: the profile may run instead).
 * `position`: the cursor's (the run stays there).
 */
function planConsolidationRun(cursor: ExtractionCursor, input: PlanInput, position: number): ExtractionPlan | null {
  const ownerUserId = cursor.ownerUserId;
  if (!consolidationDueOn(ownerUserId, input.jobId, input.now)) return null;
  const direct = input.direct === true;
  const live = consolidationLiveWorkspace(ownerUserId);
  return runInTransaction((): ExtractionPlan | null => {
    if (liveConsolidationRun(ownerUserId)) return null;
    const batch = nextConsolidationBatch(ownerUserId, input.now, live);
    if (!batch) return null;
    if (batch.groups.length === 0) {
      advanceConsolidationCursor(ownerUserId, batch.through, input.now);
      return null;
    }
    const toolName = direct ? null : MEMORY_CONSOLIDATE_TOOL_NAME;
    const system = CONSOLIDATION_INSTRUCTIONS(toolName);
    const prompt = buildConsolidationPrompt(batch, input.now, toolName);
    const id = `${CONSOLIDATION_RUN_ID_PREFIX}${randomUUID()}`;
    insertExtractionRun({
      id, kind: 'consolidate', ownerUserId, workspaceId: cursor.workspaceId, jobId: input.jobId, runId: input.runId,
      configRevision: cursor.revision, after: position, through: position, memoryVersion: memoryVersion({ ownerUserId }, null),
      tombstoneMark: latestTombstoneSeq(ownerUserId),
      tokenBudget: Math.min(CONSOLIDATION_LIMITS.runTokens, extractionBudgetLeft(ownerUserId, input.now)),
      estimatedTokens: executionBaseTokens(system, direct) + estimateTokens(prompt), now: input.now,
      sources: [], related: consolidationListing(batch),
    });
    planConsolidationCursor(ownerUserId, id, batch.through, input.now);
    return { kind: 'run', id, system, prompt, configRevision: cursor.revision, sources: 0, nodeId: null };
  });
}

/** When each owner's consolidation runs and log rows were last pruned (this process): at most once per pruneEveryMs. */
const consolidationPrunedAt = new Map<string, number>();

function pruneConsolidationSometimes(ownerUserId: string, now: number): void {
  const last = consolidationPrunedAt.get(ownerUserId);
  if (last !== undefined && now - last < CONSOLIDATION_LIMITS.pruneEveryMs) return;
  consolidationPrunedAt.set(ownerUserId, now);
  try {
    pruneConsolidation(ownerUserId, now - CONSOLIDATION_LIMITS.retentionMs);
  } catch (error) {
    log.warn('scheduler', 'consolidation: old runs were not pruned', { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Settles a consolidation run (spec §C8) from its staged answer. Stopped by
 * the scheduler: the run ends cancelled or failed with that status. Memory
 * turned off: cancelled, nothing applied, the cursor kept. A conversation
 * turn that ran meanwhile does not stop it: the commit checks every change
 * again on the current rows and skips only those whose notes changed
 * (commitConsolidation, the 2026-11-08 "re-check, skip if changed"). Unreadable past its repairs:
 * every listed note is logged unreadable and the cursor moves past them (the
 * same batch is never retried unchanged). Failed, or no answer: the cursor
 * stays. Otherwise the decisions are checked again and applied with the
 * cursor in one transaction (commitConsolidation), then announced. The
 * execution succeeds with no summary and no error in every case but a
 * scheduler stop: consolidation never fails, backs off or marks a job.
 */
function settleConsolidationRun(run: ExtractionRunRecord, current: ExtractionRunRecord, input: SettleExtractionInput, reportedTokens: number): {
  status: SettleStatus; summary: string | null; error: string | null;
} {
  const ownerUserId = run.ownerUserId;
  const quiet = { status: 'succeeded' as const, summary: null, error: null };
  const end = (state: 'succeeded' | 'failed' | 'cancelled', error: string | null, counts?: CommitCounts) => {
    finishExtractionRun({ id: run.id, state, summary: null, error, reportedTokens, ...(counts ? { counts } : {}), now: input.now });
  };
  const stop = (state: 'failed' | 'cancelled', error: string) => {
    end(state, error);
    clearPlannedCursor(ownerUserId, run.id, input.now);
  };
  pruneConsolidationSometimes(ownerUserId, input.now);
  if (input.status === 'cancelled' || input.status === 'interrupted' || input.status === 'timed_out') {
    const error = input.status === 'cancelled' ? 'Cancelled' : input.error ?? 'Automatic memory stopped before finishing';
    stop(input.status === 'cancelled' ? 'cancelled' : 'failed', error);
    return { status: input.status, summary: null, error };
  }
  if (getMemorySettings(ownerUserId).mode !== 'auto') {
    stop('cancelled', 'Automatic memory was turned off during this run; nothing was changed');
    return quiet;
  }
  const through = plannedCursorOf(ownerUserId, run.id);
  const batch = listedConsolidationBatch(ownerUserId, parseConsolidationListing(current.related), through);
  if (current.stoppedReason === 'invalid_limit' && through) {
    const error = `The model gave ${current.invalidCalls} invalid answers (at most ${MEMORY_EXTRACTION_LIMITS.maxRepairs} repairs); its notes were left as they were`;
    try {
      runInTransaction(() => {
        if (!ownsUnattendedRun(run.runId, input.claimedBy, input.now)) throw new Error('The scheduler no longer owns this run');
        settleUnreadableConsolidation({ ownerUserId, runId: run.id, batch, through, now: input.now });
        end('failed', error, { proposed: 0, dropped: 0, noChange: batch.notes.size });
      });
    } catch (cause) {
      stop('failed', `${error}; the batch was not settled: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    return quiet;
  }
  if (input.status !== 'succeeded' || current.payload === null || !through) {
    stop('failed', input.status !== 'succeeded' ? input.error ?? 'Automatic memory stopped before finishing'
      : !through ? 'The run no longer holds its planned cursor'
        : input.turnId === null ? 'The model gave no answer' : `Automatic memory finished without calling ${MEMORY_CONSOLIDATE_TOOL_NAME}`);
    return quiet;
  }
  let payload: ConsolidationPayload;
  try {
    payload = JSON.parse(current.payload) as ConsolidationPayload;
    if (!Array.isArray(payload?.decisions)) throw new Error('not a payload');
  } catch {
    stop('failed', 'The staged answer could not be read');
    return quiet;
  }
  let committed: ReturnType<typeof commitConsolidation> | { error: string };
  try {
    committed = runInTransaction(() => {
      if (!ownsUnattendedRun(run.runId, input.claimedBy, input.now)) return { error: 'The scheduler no longer owns this run; nothing was changed' };
      const fresh = getExtractionRun(run.id, ownerUserId);
      if (!fresh || fresh.state !== 'active') return { error: 'The consolidation run already settled' };
      const result = commitConsolidation(payload, {
        ownerUserId, runId: run.id, batch, through, liveWorkspace: consolidationLiveWorkspace(ownerUserId), now: input.now,
      });
      end('succeeded', null, { proposed: result.applied.length, dropped: result.skipped, noChange: result.kept });
      return result;
    });
  } catch (error) {
    log.warn('scheduler', 'consolidation: the commit failed', { runId: run.id, error: error instanceof Error ? error.message : String(error) });
    stop('failed', `The commit failed: ${error instanceof Error ? error.message : String(error)}`);
    return quiet;
  }
  if ('error' in committed) {
    stop('failed', committed.error);
    return quiet;
  }
  announceConsolidation(committed);
  return quiet;
}

// ── the user's profile ──────────────────────────────────────────────────────

/** A consumer held only because AI navigation may not read its conversations still rebuilds the profile (it reads memories). */
function servesProfile(hold: ExtractionHold | null): boolean {
  return hold === null || hold === 'navigation_off';
}

/** No run of the owner is live and no conversation is due to be read. A held consumer (paused, navigation off, stopped) waits on nothing. */
function extractionIdle(ownerUserId: string, now: number): boolean {
  if (liveExtractionRunCount(ownerUserId) > 0) return false;
  for (const state of listExtractionJobStates(ownerUserId)) {
    if (!state.jobId || state.autoPaused || extractionHold(state, now) !== null) continue;
    if (nextConversation(state, now, true)) return false;
  }
  return true;
}

/**
 * Whether the owner's profile (userProfile.ts) should be rebuilt now. One
 * rule: memory is on and automatic memory may run (not paused, budget left,
 * a local backend); then a rebuild the user asked for (Settings › Memory)
 * runs at once, and otherwise one follows PROFILE_LIMITS.changes changed
 * user-scope memories since the latest rebuild started, or anything changed
 * and PROFILE_LIMITS.intervalMs passed since then, with notes enough
 * (PROFILE_LIMITS.minSources), when the store is idle. Database reads only.
 */
export function profileRebuildDue(ownerUserId: string, now: number): boolean {
  if (!extractionLocalOnly() || getMemorySettings(ownerUserId).mode !== 'auto') return false;
  if (getExtractionState(ownerUserId).paused) return false;
  if (extractionBudgetLeft(ownerUserId, now) < MEMORY_EXTRACTION_LIMITS.minExecutionBudget) return false;
  const state = profileRebuildState(ownerUserId);
  if (state.requestedAt !== null) return true;
  const changed = userScopeChangesSince(ownerUserId, state.attemptedAt ?? 0, PROFILE_LIMITS.changes);
  if (changed === 0) return false;
  if (changed < PROFILE_LIMITS.changes && state.attemptedAt !== null && now - state.attemptedAt < PROFILE_LIMITS.intervalMs) return false;
  if (profileMemoryCount(ownerUserId, PROFILE_LIMITS.minSources) < PROFILE_LIMITS.minSources) return false;
  return extractionIdle(ownerUserId, now);
}

/** What one execution's context holds besides its prompt: the session's instructions and tool catalog, or a direct call's system prompt. */
function executionBaseTokens(system: string, direct: boolean): number {
  return estimateTokens(system) + (direct ? 0 : TOOL_CATALOG_TOKENS);
}

/**
 * A profile run for this consumer's execution, when a rebuild is due: the
 * prompt lists the owner's notes (buildProfilePrompt) and the run records
 * them, with the user scope's version, before the model sees anything. With
 * fewer notes than a profile needs once filtered, nothing runs. `position`:
 * the cursor's (the run stays there).
 */
function planProfileRun(cursor: ExtractionCursor, input: PlanInput, position: number): ExtractionPlan | null {
  const ownerUserId = cursor.ownerUserId;
  if (!profileRebuildDue(ownerUserId, input.now)) return null;
  const direct = input.direct === true;
  const prompt = buildProfilePrompt({ ownerUserId, now: input.now, ...(direct ? { toolName: null } : {}) });
  recordProfileAttempt(ownerUserId, input.now);
  if (!prompt) return null;
  const budget = Math.min(MEMORY_EXTRACTION_LIMITS.executionTokenBudget, extractionBudgetLeft(ownerUserId, input.now));
  const system = direct ? prompt.system : memoryProfileBootstrapInstructions();
  const id = `${PROFILE_RUN_ID_PREFIX}${randomUUID()}`;
  insertExtractionRun({
    id, kind: 'profile', ownerUserId, workspaceId: cursor.workspaceId, jobId: input.jobId, runId: input.runId,
    configRevision: cursor.revision, after: position, through: position, memoryVersion: prompt.sourceVersion,
    tombstoneMark: latestTombstoneSeq(ownerUserId), tokenBudget: budget,
    estimatedTokens: executionBaseTokens(system, direct) + estimateTokens(prompt.prompt), now: input.now,
    sources: [], related: prompt.sources.map((source) => ({ ref: source.ref, memoryId: source.memoryId })),
  });
  return { kind: 'run', id, system, prompt: prompt.prompt, configRevision: cursor.revision, sources: 0, nodeId: null };
}

// ── source turns ─────────────────────────────────────────────────────────────

/** A user message read at most (the prompt shows its start and end; quotes are checked against all of it). */
const USER_MESSAGE_CHARS = 100_000;
/** What is read of the reply and of the assistant message the user answered: the start and the end. */
const REPLY_HEAD_CHARS = 600;
const REPLY_TAIL_CHARS = 300;
const BEFORE_HEAD_CHARS = 300;
const BEFORE_TAIL_CHARS = 700;

interface BoundedRow { id: string; role: string; length: number; head: string; tail: string; metadata: string | null; created_at: number }

/** An assistant message as its start and end, sentinels removed. */
function assistantExcerpt(row: { length: number; head: string; tail: string }, head: number, tail: number): string {
  const start = stripSentinelsStreamingSafe(row.head);
  if (!row.tail) return start;
  return `${start}\n[… ${row.length - head - tail} characters omitted …]\n${stripSentinelsStreamingSafe(row.tail)}`;
}

/** A turn of the completion feed, as the planner and the settle step name it. */
interface TurnLocation { turnId: string; nodeId: string; userMessageId: string; assistantMessageId: string; completedAt: number }

/** A turn the user asked Michi not to recall, of a conversation that stopped learning, or before Delete all memories: recall hid its document (recallIndex.ts). */
const HIDDEN_TURN_SQL = "SELECT 1 FROM memory_recall_docs WHERE doc_kind = 'turn' AND ref_id = ? AND hidden = 1 LIMIT 1";

/**
 * A turn automatic memory never reads: recall hid it, or a removal names it
 * (a memory saved from it was deleted, or the user asked to forget what it
 * says: recallIndex.keepTurnOutOfMemory).
 */
function keptOutOfMemory(ownerUserId: string, turnId: string): boolean {
  return !!getDb().prepare(HIDDEN_TURN_SQL).get(turnId) || turnTombstoned(ownerUserId, turnId);
}

/**
 * One completed turn as the extractor reads it: what the user wrote (the
 * message and any steered into it), its time and quoted text, the reply's
 * start and end, the end of the assistant message the user answered and
 * whether that turn read outside content, and the conversation's title, as
 * they were written: what the user asked not to remember is the extractor's
 * to honor (exclude_turns). The answered message is left out when its turn
 * is kept out of memory, and when it is Companion material. Companion
 * material never becomes memory: a turn that took in what a check-in wrote
 * or the agent's collectors read (turnTrust.companionTaintOf) is read as
 * what the user typed in it alone (typedText.storedTypedText), with no reply,
 * quoted text or answered message; and a check-in's post (recorded as its
 * material: chatHub.postSelfMessage) or the reply of such a turn is never
 * the message a turn answered. null when the turn can no longer be
 * read as one turn (deleted, or rewritten), when it is kept out of memory
 * (recall hid it, or a removal names it: keptOutOfMemory), when its
 * conversation stopped learning (its memory setting), or when the user wrote
 * nothing.
 */
export function readExtractionTurn(location: TurnLocation, ownerUserId: string): ExtractionTurnInput | null {
  const db = getDb();
  if (keptOutOfMemory(ownerUserId, location.turnId)) return null;
  const bounds = turnMessageBounds(location);
  if (!bounds) return null;
  const node = db.prepare('SELECT title, memory_mode FROM nodes WHERE id = ?').get(location.nodeId) as
    { title: string | null; memory_mode: string | null } | undefined;
  if (!node || node.memory_mode !== null) return null;
  const rows = db.prepare(`SELECT id, role, length(content) AS length, created_at,
      substr(content, 1, CASE WHEN role = 'user' THEN ? ELSE ? END) AS head,
      CASE WHEN role = 'assistant' AND length(content) > ? THEN substr(content, -?) ELSE '' END AS tail,
      CASE WHEN role = 'user' THEN metadata ELSE NULL END AS metadata
    FROM messages WHERE node_id = ? AND seq BETWEEN ? AND ? AND role IN ('user', 'assistant') ORDER BY seq, id`)
    .all(USER_MESSAGE_CHARS, REPLY_HEAD_CHARS, REPLY_HEAD_CHARS + REPLY_TAIL_CHARS, REPLY_TAIL_CHARS,
      location.nodeId, bounds.first, bounds.last) as unknown as BoundedRow[];
  const user: string[] = [];
  let userAt: number | null = null;
  let quotedText: string | null = null;
  let reply = '';
  for (const row of rows) {
    // Another input between the turn's boundaries means they no longer identify one turn.
    const parsed = parseTurnMessage(row, location);
    if (!parsed) return null;
    const { metadata } = parsed;
    const initial = row.id === location.userMessageId;
    if (row.role === 'user') {
      if (row.head.trim()) user.push(row.head);
      if (initial) {
        userAt = row.created_at;
        quotedText = typeof metadata?.quotedText === 'string' && metadata.quotedText.trim() ? metadata.quotedText : null;
      }
    } else {
      reply = assistantExcerpt(row, REPLY_HEAD_CHARS, REPLY_TAIL_CHARS);
    }
  }
  if (user.length === 0) return null;
  const read = { turnId: location.turnId, nodeId: location.nodeId, title: node.title, userAt: userAt ?? location.completedAt, completedAt: location.completedAt };
  if (companionTaintOf({ nodeId: location.nodeId, turnId: location.turnId }) !== null) {
    const typed = storedTypedText(location.nodeId, location.turnId);
    return typed.length === 0 ? null : {
      ...read, userText: typed.join('\n\n'), quotedText: null, assistantText: '', previousAssistantText: null, previousUntrusted: false,
    };
  }
  const before = db.prepare(`SELECT id, length(content) AS length, substr(content, 1, ?) AS head,
      CASE WHEN length(content) > ? THEN substr(content, -?) ELSE '' END AS tail
    FROM messages WHERE node_id = ? AND role = 'assistant' AND seq < ? ORDER BY seq DESC LIMIT 1`)
    .get(BEFORE_HEAD_CHARS, BEFORE_HEAD_CHARS + BEFORE_TAIL_CHARS, BEFORE_TAIL_CHARS, location.nodeId, bounds.first) as
    { id: string; length: number; head: string; tail: string } | undefined;
  const beforeTurn = before
    ? db.prepare('SELECT turn_id FROM turns WHERE assistant_message_id = ? AND node_id = ?').get(before.id, location.nodeId) as { turn_id: string } | undefined
    : undefined;
  const beforeText = before ? assistantExcerpt(before, BEFORE_HEAD_CHARS, BEFORE_TAIL_CHARS) : null;
  // The reply the user answered stays out when its own turn is kept out of memory or holds Companion material (a check-in's post).
  const beforeHidden = !!beforeText && !!beforeTurn && (keptOutOfMemory(ownerUserId, beforeTurn.turn_id)
    || companionTaintOf({ nodeId: location.nodeId, turnId: beforeTurn.turn_id }) !== null);
  return {
    ...read,
    userText: user.join('\n\n'),
    quotedText,
    assistantText: reply,
    previousAssistantText: beforeHidden ? null : beforeText,
    previousUntrusted: beforeTurn ? getTurnTrust({ nodeId: location.nodeId, turnId: beforeTurn.turn_id }).untrusted : false,
  };
}

// ── planning ─────────────────────────────────────────────────────────────────

export type ExtractionPlan =
  | { kind: 'skip'; summary: string }
  /**
   * `system`: the run's system prompt (a direct call's; a session's bootstrap
   * instructions). `nodeId`: the conversation it reads; null for a profile run.
   */
  | { kind: 'run'; id: string; system: string; prompt: string; configRevision: number; sources: number; nodeId: string | null };

/**
 * An execution's projected tokens: a direct call reads its context once; a
 * session reads it for its call and once more after the result.
 */
function projectedTokens(contextTokens: number, direct: boolean): number {
  return (direct ? 1 : 2) * contextTokens + ANSWER_TOKENS;
}

/** The new turns of one conversation an execution reads next (nextConversationBatch). */
export interface ExtractionBatch {
  /** Every turn the batch claims, in completion order, with the turn as the extractor reads it (null: unreadable). */
  picked: Array<{ source: ExtractionSourceInput; turn: ExtractionTurnInput | null }>;
  /** The picked turns that can be read: what the prompt shows and the commit checks quotes against. */
  turns: ExtractionTurnInput[];
  /** The completion position the batch reaches: the conversation's position moves here once it is settled (at once when turns is empty). */
  through: number;
}

interface TurnRow { turnId: string; nodeId: string; userMessageId: string; assistantMessageId: string; completionSeq: number; completedAt: number }

/**
 * The batch an execution reads in one conversation after position `after`,
 * shared by planMemoryExtractionRun and evaluations: the conversation's next
 * completed turns in completion order, each read as the extractor sees it
 * (readExtractionTurn) with its trust mark, at most maxSources and no more
 * than `budget` projected tokens allow (`direct`: the answer is one direct
 * call). Database reads only. 'navigation_off' when AI access to the
 * workspace's conversations is off; an empty `turns` means nothing readable
 * waits up to `through`.
 */
export function nextConversationBatch(input: {
  ownerUserId: string; workspaceId: string; workspaceName: string; nodeId: string; after: number; now: number;
  maxSources: number; budget: number; direct?: boolean;
}): ExtractionBatch | 'navigation_off' {
  if (!getAiGlobalContext(input.workspaceId, input.ownerUserId)) return 'navigation_off';
  const direct = input.direct === true;
  const readable = extractionReadable(input.workspaceId, input.ownerUserId);
  const rows = getDb().prepare(`SELECT t.turn_id AS turnId, t.node_id AS nodeId, t.user_message_id AS userMessageId,
      t.assistant_message_id AS assistantMessageId, t.completion_seq AS completionSeq, t.completed_at AS completedAt
    ${readable.sql} AND t.node_id = ? AND t.completion_seq > ? ORDER BY t.completion_seq LIMIT ?`)
    .all(...readable.params, input.nodeId, input.after, Math.max(1, input.maxSources)) as unknown as TurnRow[];
  const system = direct ? buildExtractionInstructions({ toolName: null }) : memoryExtractionBootstrapInstructions();
  const base = executionBaseTokens(system, direct);
  const picked: ExtractionBatch['picked'] = [];
  for (const row of rows) {
    const read = readExtractionTurn(row, input.ownerUserId);
    const untrusted = getTurnTrust({ nodeId: row.nodeId, turnId: row.turnId }).untrusted;
    const turn = read ? { ...read, untrusted } : null;
    if (turn && picked.length > 0) {
      const turns = [...picked.flatMap((entry) => (entry.turn ? [entry.turn] : [])), turn];
      const prompt = buildExtractionPrompt({
        ownerUserId: input.ownerUserId, workspaceId: input.workspaceId, workspaceName: input.workspaceName, turns, now: input.now, related: [],
        ...(direct ? { toolName: null } : {}),
      });
      if (projectedTokens(base + RELATED_ALLOWANCE_TOKENS + estimateTokens(prompt.prompt), direct) > input.budget) break;
    }
    picked.push({
      source: {
        sourceTurnId: row.turnId, nodeId: row.nodeId, userMessageId: row.userMessageId, assistantMessageId: row.assistantMessageId,
        completionSeq: row.completionSeq, completedAt: row.completedAt, untrusted,
      },
      turn,
    });
  }
  const through = picked.length ? picked[picked.length - 1]!.source.completionSeq : input.after;
  return { picked, turns: picked.flatMap((entry) => (entry.turn ? [entry.turn] : [])), through };
}

/**
 * The conversation of a workspace extraction reads next, with its position:
 * the first due one, or with `due` false any with turns waiting (a manual
 * start, an evaluation), leaving out those in `exclude` (the ones the same
 * scheduler run is reading). Positions start at the workspace's cursor, or 0
 * when it has none (an evaluation's workspace).
 */
export function pendingExtractionConversation(input: {
  ownerUserId: string; workspaceId: string; now: number; due?: boolean; exclude?: ReadonlySet<string>;
}): PendingConversation | null {
  const floor = getExtractionCursor(input.workspaceId, input.ownerUserId)?.completionCursor ?? 0;
  return pendingConversations(input.workspaceId, input.ownerUserId, floor)
    .find((conversation) => !input.exclude?.has(conversation.nodeId)
      && (input.due === false || conversationDue(conversation, input.now))) ?? null;
}

/**
 * A batch read without a model (nothing in it readable), or one an evaluation
 * committed itself: the conversation's position moves past it
 * (compare-and-set), then the workspace's cursor.
 */
export function recordConversationExtracted(input: { ownerUserId: string; workspaceId: string; nodeId: string; from: number; to: number; now: number }): boolean {
  return runInTransaction(() => {
    const floor = getExtractionCursor(input.workspaceId, input.ownerUserId)?.completionCursor ?? 0;
    const moved = advanceConversationExtraction({ ...input, floor });
    if (moved) compactCursor(input.workspaceId, input.ownerUserId, input.now);
    return moved;
  });
}

/** Conversations with nothing readable (or only turns older than the backlog window) one plan moves past before it gives up for this time. */
const UNREADABLE_SKIPS_PER_PLAN = 8;

/** The completion position of the conversation's last turn after `after` that completed before `cutoff`, or `after` when none did. */
function staleTurnsThrough(workspaceId: string, ownerUserId: string, nodeId: string, after: number, cutoff: number): number {
  const readable = readableTurnsFrom(workspaceId, ownerUserId);
  const row = getDb().prepare(`SELECT MAX(t.completion_seq) AS through
    ${readable.sql} AND t.node_id = ? AND t.completion_seq > ? AND COALESCE(t.completed_at, 0) < ?`)
    .get(...readable.params, nodeId, after, cutoff) as { through: number | null } | undefined;
  return row?.through ?? after;
}

interface PlanInput {
  jobId: string; workspaceId: string; ownerUserId: string; runId: string; now: number;
  /** A manual start: any conversation with turns waiting, due or not. */
  manual?: boolean;
  /** The run is answered with a direct structured call: its prompt asks for the JSON payload, not a tool call. */
  direct?: boolean;
  /**
   * The conversations the same scheduler run reads already: the next batch
   * comes from another one, and there is no profile run (a later run
   * rebuilds the profile).
   */
  exclude?: ReadonlySet<string>;
}

/**
 * Claims the next batch for a scheduler run: the new turns of the first due
 * conversation (any with turns waiting, on a manual start) the run does not
 * read already. A held consumer, or nothing due, returns skip; a batch with
 * no readable turn moves the conversation past them without a model. The
 * batch, its untrusted flags, the memories the prompt lists and the memory
 * version are durable before the model sees anything.
 */
export function planMemoryExtractionRun(input: PlanInput): ExtractionPlan {
  const cursor = getExtractionCursorByJob(input.jobId);
  if (!cursor || cursor.workspaceId !== input.workspaceId || cursor.ownerUserId !== input.ownerUserId) {
    throw new Error('This automatic memory consumer no longer exists');
  }
  failOrphanedExtractionRuns(cursor.workspaceId, cursor.ownerUserId, input.now);
  const hold = extractionHold(cursor, input.now);
  // Nothing of the workspace's own to read: the execution may tidy Michi's own notes, or else rebuild the user's profile.
  const profile = (summary: string): ExtractionPlan => {
    if (input.exclude) return { kind: 'skip', summary };
    const current = getExtractionCursor(cursor.workspaceId, cursor.ownerUserId) ?? cursor;
    return planConsolidationRun(current, input, current.completionCursor)
      ?? planProfileRun(current, input, current.completionCursor) ?? { kind: 'skip', summary };
  };
  if (hold === 'navigation_off') return profile(holdSummary(hold));
  if (hold) return { kind: 'skip', summary: holdSummary(hold) };
  const direct = input.direct === true;
  const workspace = extractionWorkspace(cursor.workspaceId, cursor.ownerUserId)!;
  const budget = Math.min(MEMORY_EXTRACTION_LIMITS.executionTokenBudget, extractionBudgetLeft(cursor.ownerUserId, input.now));
  // Halve the batch after an execution that reported more than its budget.
  const previous = lastFinishedExtractionRun(cursor.workspaceId, cursor.ownerUserId);
  const previousSources = previous ? listExtractionSources(previous.id).length : 0;
  const overran = !!previous && (previous.stoppedReason === 'budget' || (previous.reportedTokens ?? 0) > previous.tokenBudget);
  const maxSources = overran ? Math.max(1, Math.floor(previousSources / 2)) : MEMORY_EXTRACTION_LIMITS.maxSourcesPerExecution;
  let conversation: PendingConversation;
  let batch: ExtractionBatch;
  for (let skipped = 0; ; skipped += 1) {
    const found = nextConversation(cursor, input.now, input.manual !== true, input.exclude);
    if (!found) {
      runInTransaction(() => compactCursor(cursor.workspaceId, cursor.ownerUserId, input.now));
      return profile('No new conversation turns');
    }
    // Turns older than the backlog window are not read automatically: move past them without a model.
    if (input.manual !== true) {
      const stale = staleTurnsThrough(cursor.workspaceId, cursor.ownerUserId, found.nodeId, found.after, input.now - EXTRACTION_BACKLOG_WINDOW_MS);
      if (stale > found.after) {
        recordConversationExtracted({ ownerUserId: cursor.ownerUserId, workspaceId: cursor.workspaceId, nodeId: found.nodeId,
          from: found.after, to: stale, now: input.now });
        if (skipped + 1 >= UNREADABLE_SKIPS_PER_PLAN) return profile('No new conversation turns');
        continue;
      }
    }
    const next = nextConversationBatch({
      ownerUserId: cursor.ownerUserId, workspaceId: cursor.workspaceId, workspaceName: workspace.name, nodeId: found.nodeId,
      after: found.after, now: input.now, maxSources, budget, direct,
    });
    if (next === 'navigation_off') return profile(holdSummary('navigation_off'));
    if (next.turns.length > 0) {
      conversation = found;
      batch = next;
      break;
    }
    // Nothing readable (rewritten or hidden turns): move past them without a model, then on to the next conversation.
    if (next.through > found.after) {
      recordConversationExtracted({ ownerUserId: cursor.ownerUserId, workspaceId: cursor.workspaceId, nodeId: found.nodeId,
        from: found.after, to: next.through, now: input.now });
    }
    if (skipped + 1 >= UNREADABLE_SKIPS_PER_PLAN) return profile('No new conversation turns');
  }
  const { picked, turns, through } = batch;
  const prompt = buildExtractionPrompt({
    ownerUserId: cursor.ownerUserId, workspaceId: cursor.workspaceId, workspaceName: workspace.name, turns, now: input.now,
    ...(direct ? { toolName: null } : {}),
  });
  const system = direct ? prompt.system : memoryExtractionBootstrapInstructions();
  const id = `${EXTRACTION_RUN_ID_PREFIX}${randomUUID()}`;
  insertExtractionRun({
    id, ownerUserId: cursor.ownerUserId, workspaceId: cursor.workspaceId, jobId: input.jobId, runId: input.runId,
    configRevision: cursor.revision, after: conversation.after, through,
    memoryVersion: memoryVersion({ ownerUserId: cursor.ownerUserId }, cursor.workspaceId), tombstoneMark: latestTombstoneSeq(cursor.ownerUserId),
    tokenBudget: budget, estimatedTokens: executionBaseTokens(system, direct) + estimateTokens(prompt.prompt), now: input.now,
    sources: picked.map((entry) => entry.source), related: prompt.related,
  });
  return { kind: 'run', id, system, prompt: prompt.prompt, configRevision: cursor.revision, sources: picked.length, nodeId: conversation.nodeId };
}

function holdSummary(hold: ExtractionHold): string {
  switch (hold) {
    case 'off': return 'Skipped: automatic memory is turned off';
    case 'unsupported': return 'Skipped: automatic memory runs only on the local backend';
    case 'paused': return 'Skipped: automatic memory is paused';
    case 'workspace_paused': return 'Skipped: automatic memory is paused for this workspace';
    case 'budget_exhausted': return 'Skipped: today\'s automatic memory token limit is reached';
    case 'workspace_unavailable': return 'Skipped: the workspace is archived, deleted or not a local workspace';
    case 'navigation_off': return 'Skipped: AI access to this workspace\'s conversations is turned off';
    case 'session_only': return 'Skipped: the assistant\'s conversation is read only by a runtime that answers directly';
  }
}

// ── settling ─────────────────────────────────────────────────────────────────

export type SettleStatus = 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';

export interface SettleExtractionInput {
  id: string; ownerUserId: string; status: SettleStatus; error: string | null;
  /** The session turn that answered, whose usage the runtime reported; null for a direct call. */
  turnId: string | null;
  /** Tokens a direct call reported (extractionDirect.ts); absent: read from the turn, else Michi's estimate. */
  reportedTokens?: number | null;
  claimedBy: string; now: number;
}

/** Tokens the runtime reported on the run's reply, or null. */
function reportedTurnTokens(turnId: string | null): number | null {
  if (!turnId) return null;
  const row = getDb().prepare(`SELECT m.metadata FROM turns t JOIN messages m ON m.id = t.assistant_message_id WHERE t.turn_id = ?`)
    .get(turnId) as { metadata: string | null } | undefined;
  if (!row?.metadata) return null;
  try {
    const tokens = usageSummaryTotalTokens((JSON.parse(row.metadata) as { usageSummary?: unknown } | null)?.usageSummary);
    return tokens === undefined ? null : Math.round(tokens);
  } catch { /* unreadable metadata counts as unreported */ }
  return null;
}

function chargeUsage(run: ExtractionRunRecord, input: SettleExtractionInput, now: number): { tokens: number; reported: number | null } {
  const reported = input.reportedTokens !== undefined && input.reportedTokens !== null && Number.isFinite(input.reportedTokens)
    ? Math.max(0, Math.round(input.reportedTokens)) : reportedTurnTokens(input.turnId);
  const current = getExtractionRun(run.id, run.ownerUserId) ?? run;
  const tokens = reported ?? current.estimatedTokens;
  const dayStart = startOfLocalDay(now);
  const total = addExtractionUsage(run.ownerUserId, dayStart, tokens);
  if (total >= MEMORY_EXTRACTION_LIMITS.dailyTokenLimit - MEMORY_EXTRACTION_LIMITS.minExecutionBudget) {
    markExtractionBudgetExhausted(run.ownerUserId, dayStart, now);
  }
  return { tokens, reported };
}

interface CommitCounts { proposed: number; dropped: number; noChange: number }

function countsSummary(counts: CommitCounts, sources: number, excluded = 0, forgotten = 0): string {
  const parts = [
    counts.proposed && `saved ${counts.proposed} memor${counts.proposed === 1 ? 'y' : 'ies'}`,
    counts.noChange && `nothing to save in ${counts.noChange} turn${counts.noChange === 1 ? '' : 's'}`,
    counts.dropped && `dropped ${counts.dropped} (already stored, removed before, or not the user's own words)`,
    excluded && `left out ${excluded} turn${excluded === 1 ? '' : 's'} the user declined`,
    forgotten && `forgot ${forgotten} of Michi's own note${forgotten === 1 ? '' : 's'} the user declined`,
  ].filter(Boolean);
  return `Automatic memory: read ${sources} turn${sources === 1 ? '' : 's'}${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
}

/** The run's turns as the commit checks them, read again now: one deleted, hidden or no longer learning meanwhile is left out (its memories drop). */
function commitTurns(sources: ReturnType<typeof listExtractionSources>, ownerUserId: string): ExtractionTurnInput[] {
  return sources.flatMap((source) => {
    const turn = readExtractionTurn({ turnId: source.sourceTurnId, nodeId: source.nodeId, userMessageId: source.userMessageId,
      assistantMessageId: source.assistantMessageId, completedAt: source.completedAt }, ownerUserId);
    return turn ? [{ ...turn, untrusted: source.untrusted }] : [];
  });
}

/**
 * Moves the run's conversation from the run's start to its end (compare-and-
 * set, in the caller's transaction), then the workspace's cursor; false when
 * the conversation moved meanwhile or the consumer is no longer this run's.
 * The workspace's cursor may have risen meanwhile, as another conversation's
 * run settled, but never to the run's first turn.
 */
function advanceRunConversation(run: ExtractionRunRecord, sources: ReturnType<typeof listExtractionSources>, now: number): boolean {
  const cursor = getExtractionCursorByJob(run.jobId);
  const nodeId = sources[0]?.nodeId;
  if (!cursor || cursor.workspaceId !== run.workspaceId || cursor.ownerUserId !== run.ownerUserId || !nodeId) return false;
  if (!advanceConversationExtraction({ nodeId, ownerUserId: run.ownerUserId, workspaceId: run.workspaceId, floor: cursor.completionCursor,
    from: run.after, to: run.through, firstSeq: Math.min(...sources.map((source) => source.completionSeq)), now })) return false;
  compactCursor(run.workspaceId, run.ownerUserId, now);
  return true;
}

/** The receipt reason of a turn whose run's answer failed validation past its repairs. */
const UNREADABLE_RECEIPT = 'unreadable';

/** A turn of the conversation was running at that time. */
const TURN_RAN_AT_SQL = 'SELECT 1 FROM turns WHERE node_id = ? AND started_at <= ? AND (completed_at IS NULL OR completed_at > ?) LIMIT 1';
/** The conversation's turns after a position that had completed by then: what waited when a run was planned. */
const WAITING_AT_SQL = `SELECT COUNT(*) AS n FROM turns WHERE node_id = ? AND status = 'completed' AND user_message_id IS NOT NULL
  AND completion_seq > ? AND completed_at <= ?`;

/**
 * The user came back to the run's conversation and typed in it after the run
 * was planned (typedText.lastTypedInto). As a conversation the user is in is
 * read only once they leave it (conversationDue), its answer then gives way:
 * the next run reads the conversation once they leave it again, with what
 * they said since, so a later "don't keep that" is read with what it is
 * about. A run whose next read could not take in what they said since keeps
 * its answer, or a conversation the user stays in would never be read: one
 * planned for the backlog of that conversation (EXTRACTION_TURN_TRIGGER
 * turns waited), one that read less than waited (its token budget), and one
 * planned while a turn ran there. A later decline in such a conversation
 * reaches the notes through the next read's forget.
 */
function cameBackDuringRun(run: ExtractionRunRecord, sources: ReturnType<typeof listExtractionSources>): boolean {
  const nodeId = sources[0]?.nodeId;
  const typed = nodeId ? lastTypedInto(nodeId) : null;
  if (typed === null || typed <= run.startedAt) return false;
  if (getDb().prepare(TURN_RAN_AT_SQL).get(nodeId!, run.startedAt, run.startedAt)) return false;
  const waited = (getDb().prepare(WAITING_AT_SQL).get(nodeId!, run.after, run.startedAt) as { n: number }).n;
  return waited < EXTRACTION_TURN_TRIGGER && waited <= sources.length;
}

/**
 * Settles an execution from its staged answer, never from a session's reply.
 * It succeeds only when the answer came and the scheduler run is still owned;
 * then the memories (commitExtractionPayload) and the conversation's position
 * commit in one transaction. A run whose answers failed validation past its
 * repairs (invalid_limit) settles its turns as unreadable instead
 * (settleUnreadable), so the same batch is never retried unchanged. A removal
 * that named one of its turns while the model read them (the user forgot
 * what one says, from another conversation, right after leaving it:
 * memoryTools' memory_delete) drops the answer, which may carry it in any
 * memory, and keeps the position: the next run reads the turns again, that
 * one left out (readExtractionTurn). So does the user's coming back to the
 * conversation and typing in it meanwhile (cameBackDuringRun): it is read
 * again, with what they said since, once they leave it. Anything else keeps
 * the position and drops the staged answer.
 */
export function settleMemoryExtractionRun(input: SettleExtractionInput): { status: SettleStatus; summary: string | null; error: string | null } {
  const run = getExtractionRun(input.id, input.ownerUserId);
  if (!run || run.state !== 'active') return { status: 'failed', summary: null, error: 'Automatic memory run record is missing' };
  const { tokens, reported } = chargeUsage(run, input, input.now);
  const current = getExtractionRun(run.id, run.ownerUserId)!;
  if (run.kind === 'profile') return settleProfileRun(run, current, input, reported ?? tokens);
  if (run.kind === 'consolidate') return settleConsolidationRun(run, current, input, reported ?? tokens);
  const sources = listExtractionSources(run.id);
  const fail = (status: SettleStatus, error: string) => {
    finishExtractionRun({ id: run.id, state: status === 'cancelled' ? 'cancelled' : 'failed', summary: null, error, reportedTokens: reported ?? tokens, now: input.now });
    pruneExtractionRuns(run.workspaceId, run.ownerUserId, MEMORY_EXTRACTION_LIMITS.runsKept);
    return { status: status === 'succeeded' ? 'failed' as const : status, summary: null, error };
  };
  // Past its repairs the answer is unreadable however the run ended, unless it was stopped (cancelled, interrupted).
  const unreadable = current.stoppedReason === 'invalid_limit' && (input.status === 'succeeded' || input.status === 'failed' || input.status === 'timed_out');
  if (input.status !== 'succeeded' && !unreadable) {
    return fail(input.status, input.status === 'cancelled' ? 'Cancelled' : input.error ?? 'Automatic memory stopped before finishing');
  }
  if (getMemorySettings(run.ownerUserId).mode !== 'auto') return fail('cancelled', 'Automatic memory was turned off during this run; nothing was saved');
  if (unreadable) return settleUnreadable(run, current, sources, input, reported ?? tokens, fail);
  if (current.payload === null || sources.some((source) => source.decision === null)) {
    return fail('failed', input.turnId === null
      ? 'The model gave no answer; nothing was saved and the turns are retried'
      : `Automatic memory finished without calling ${MEMORY_EXTRACTION_TOOL_NAMES[0]}; nothing was saved and the turns are retried`);
  }
  let payload: ExtractionPayload;
  try {
    // Staged after validateExtractionPayload: already normalized (its keywords may even be none now).
    payload = JSON.parse(current.payload) as ExtractionPayload;
    if (!Array.isArray(payload?.memories) || !Array.isArray(payload?.turn_keys)) throw new Error('not a payload');
    payload.exclude_turns ??= [];
    payload.forget ??= [];
  } catch {
    return fail('failed', 'The staged answer could not be read; nothing was saved and the turns are retried');
  }
  let outcome: { counts: CommitCounts; excluded: number; forgotten: number } | { error: string } | { removed: true } | { cameBack: true };
  try {
    outcome = runInTransaction(() => {
      if (!ownsUnattendedRun(run.runId, input.claimedBy, input.now)) return { error: 'The scheduler no longer owns this run; nothing was saved' };
      const fresh = getExtractionRun(run.id, run.ownerUserId);
      if (!fresh || fresh.state !== 'active') return { error: 'Automatic memory run already settled' };
      // The user removed or kept out of memory something these turns say while the model read them (forget what was
      // just said, from another conversation): the answer may carry it in any memory, so none is saved, and the next
      // run reads the turns again without it.
      if (turnsTombstonedAfter(run.ownerUserId, sources.map((source) => source.sourceTurnId), run.tombstoneMark)) return { removed: true as const };
      // The user came back to the conversation and typed in it while the model read it (a "don't keep that" may be
      // what they said): as a conversation the user is in, it is read again, with what they said since, once they leave.
      if (cameBackDuringRun(run, sources)) return { cameBack: true as const };
      if (!advanceRunConversation(run, sources, input.now)) return { error: 'The conversation\'s automatic memory position moved; nothing was saved' };
      const committed = commitExtractionPayload(payload, {
        ownerUserId: run.ownerUserId, workspaceId: run.workspaceId, turns: commitTurns(sources, run.ownerUserId), related: fresh.related,
        runId: run.id, now: input.now,
      });
      const counts: CommitCounts = {
        proposed: committed.saved.length, dropped: committed.dropped.length,
        noChange: sources.filter((source) => source.decision === 'no_change').length,
      };
      finishExtractionRun({ id: run.id, state: 'succeeded', summary: countsSummary(counts, sources.length, committed.excludedTurns, committed.forgotten),
        error: null, reportedTokens: reported ?? tokens, counts, now: input.now });
      return { counts, excluded: committed.excludedTurns, forgotten: committed.forgotten };
    });
  } catch (error) {
    log.warn('scheduler', 'automatic memory commit failed', { runId: run.id, error: error instanceof Error ? error.message : String(error) });
    return fail('failed', `Saving the memories failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if ('error' in outcome) return fail('failed', outcome.error);
  if ('removed' in outcome || 'cameBack' in outcome) {
    // Not a failed execution: the conversation keeps its position, and a later check reads it again (the next one, about
    // a second later; once the user leaves it again, when they came back to it).
    const turns = `${sources.length} turn${sources.length === 1 ? '' : 's'}`;
    const summary = 'removed' in outcome
      ? `Automatic memory: read ${turns} · the user removed something they say meanwhile; nothing saved, they are read again without it`
      : `Automatic memory: read ${turns} · the user came back to the conversation meanwhile; nothing saved, it is read again once they leave it`;
    finishExtractionRun({ id: run.id, state: 'cancelled', summary, error: null, reportedTokens: reported ?? tokens, now: input.now });
    pruneExtractionRuns(run.workspaceId, run.ownerUserId, MEMORY_EXTRACTION_LIMITS.runsKept);
    return { status: 'succeeded', summary, error: null };
  }
  pruneExtractionRuns(run.workspaceId, run.ownerUserId, MEMORY_EXTRACTION_LIMITS.runsKept);
  const over = reported !== null && reported > run.tokenBudget ? ` · used ${reported} tokens, over this run's ${run.tokenBudget}` : '';
  return { status: 'succeeded', summary: `${countsSummary(outcome.counts, sources.length, outcome.excluded, outcome.forgotten)}${over}`, error: null };
}

/**
 * Settles a run whose answers failed validation past its repairs: every
 * source turn gets a no-change receipt, UNREADABLE_RECEIPT, and the
 * conversation moves past them in one transaction, as a committed answer
 * would move it. A model that cannot answer a batch would fail it again the
 * same way, so it is not retried; the turns are skipped and nothing is saved
 * from them. The run is recorded as failed, with an error that says so
 * (Settings › Memory shows it), while the scheduler counts the execution as
 * done: the next one reads the next turns without a retry backoff.
 */
function settleUnreadable(
  run: ExtractionRunRecord, current: ExtractionRunRecord, sources: ReturnType<typeof listExtractionSources>, input: SettleExtractionInput,
  reportedTokens: number, fail: (status: SettleStatus, error: string) => { status: SettleStatus; summary: string | null; error: string | null },
): { status: SettleStatus; summary: string | null; error: string | null } {
  const turns = `${sources.length} turn${sources.length === 1 ? '' : 's'}`;
  const error = `The model gave ${current.invalidCalls} invalid answers (at most ${MEMORY_EXTRACTION_LIMITS.maxRepairs} repairs), so its answer could not be read; ${turns} skipped, nothing saved from them`;
  const summary = `Automatic memory: read ${turns} · the answer could not be read after ${current.invalidCalls} invalid answers; skipped, nothing saved`;
  let outcome: { error: string } | null;
  try {
    outcome = runInTransaction(() => {
      if (!ownsUnattendedRun(run.runId, input.claimedBy, input.now)) return { error: 'The scheduler no longer owns this run; nothing was saved' };
      const fresh = getExtractionRun(run.id, run.ownerUserId);
      if (!fresh || fresh.state !== 'active') return { error: 'Automatic memory run already settled' };
      if (!advanceRunConversation(run, sources, input.now)) return { error: 'The conversation\'s automatic memory position moved; nothing was saved' };
      for (const source of sources) recordExtractionDecision(run.id, source.sourceTurnId, 'no_change', UNREADABLE_RECEIPT, input.now);
      finishExtractionRun({ id: run.id, state: 'failed', summary, error, reportedTokens,
        counts: { proposed: 0, dropped: 0, noChange: sources.length }, now: input.now });
      return null;
    });
  } catch (cause) {
    log.warn('scheduler', 'automatic memory: an unreadable batch was not settled', { runId: run.id, error: cause instanceof Error ? cause.message : String(cause) });
    return fail('failed', `Settling the unreadable answer failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (outcome) return fail('failed', outcome.error);
  log.warn('scheduler', 'automatic memory: answer unreadable, turns skipped', { runId: run.id, workspaceId: run.workspaceId, turns: sources.length, invalidCalls: current.invalidCalls });
  pruneExtractionRuns(run.workspaceId, run.ownerUserId, MEMORY_EXTRACTION_LIMITS.runsKept);
  return { status: 'succeeded', summary, error: null };
}

/**
 * Settles a profile run from its staged answer: the profile is stored
 * (commitProfilePayload) when the answer came and the scheduler run is still
 * this process's. A rebuild that stored nothing is recorded on the run
 * (Settings › Memory shows its error) and on the profile, which keeps the
 * lines it had; it is not a failed execution, since the scheduler's backoff
 * and repeated-failure stop belong to the workspace's extraction. The next
 * rebuild follows the cadence rule (profileRebuildDue).
 */
function settleProfileRun(run: ExtractionRunRecord, current: ExtractionRunRecord, input: SettleExtractionInput, reportedTokens: number): {
  status: SettleStatus; summary: string | null; error: string | null;
} {
  const ownerUserId = run.ownerUserId;
  const end = (state: 'succeeded' | 'failed' | 'cancelled', summary: string | null, error: string | null, counts?: CommitCounts) => {
    finishExtractionRun({ id: run.id, state, summary, error, reportedTokens, ...(counts ? { counts } : {}), now: input.now });
    pruneExtractionRuns(run.workspaceId, ownerUserId, MEMORY_EXTRACTION_LIMITS.runsKept);
  };
  const notRebuilt = (error: string) => {
    end('failed', null, error);
    recordProfileFailure(ownerUserId, error, input.now);
    return { status: 'succeeded' as const, summary: `Automatic memory: the profile of the user was not rebuilt (${error})`, error: null };
  };
  if (input.status === 'cancelled' || input.status === 'interrupted') {
    const error = input.status === 'cancelled' ? 'Cancelled' : input.error ?? 'Automatic memory stopped before finishing';
    end(input.status === 'cancelled' ? 'cancelled' : 'failed', null, error);
    recordProfileFailure(ownerUserId, error, input.now);
    return { status: input.status, summary: null, error };
  }
  if (getMemorySettings(ownerUserId).mode !== 'auto') {
    const error = 'Automatic memory was turned off during this run; nothing was saved';
    end('cancelled', null, error);
    return { status: 'cancelled', summary: null, error };
  }
  if (current.stoppedReason === 'invalid_limit') {
    return notRebuilt(`the model gave ${current.invalidCalls} invalid answers (at most ${MEMORY_EXTRACTION_LIMITS.maxRepairs} repairs)`);
  }
  if (input.status !== 'succeeded') return notRebuilt(input.error ?? 'Automatic memory stopped before finishing');
  if (current.payload === null) {
    return notRebuilt(input.turnId === null ? 'The model gave no answer' : `Automatic memory finished without calling ${MEMORY_PROFILE_TOOL_NAME}`);
  }
  let payload: ProfilePayload;
  try {
    payload = JSON.parse(current.payload) as ProfilePayload;
    if (!Array.isArray(payload?.sections)) throw new Error('not a payload');
  } catch {
    return notRebuilt('The staged answer could not be read');
  }
  let outcome: { summary: string } | { error: string };
  try {
    outcome = runInTransaction(() => {
      if (!ownsUnattendedRun(run.runId, input.claimedBy, input.now)) return { error: 'The scheduler no longer owns this run; nothing was saved' };
      const fresh = getExtractionRun(run.id, ownerUserId);
      if (!fresh || fresh.state !== 'active') return { error: 'Automatic memory run already settled' };
      const committed = commitProfilePayload(payload, {
        ownerUserId, sources: fresh.related, sourceVersion: run.memoryVersion,
        language: profileLanguage(listedProfileSources(ownerUserId, fresh.related)), now: input.now,
      });
      if (!committed.saved) return { error: 'Automatic memory was turned off during this run; nothing was saved' };
      const summary = `Automatic memory: rebuilt the profile of the user · ${committed.lines} line${committed.lines === 1 ? '' : 's'}`
        + `${committed.dropped.length ? ` · left out ${committed.dropped.length} citing a note that changed meanwhile` : ''}`;
      end('succeeded', summary, null, { proposed: committed.lines, dropped: committed.dropped.length, noChange: 0 });
      return { summary };
    });
  } catch (error) {
    log.warn('scheduler', 'automatic memory: the profile was not saved', { runId: run.id, error: error instanceof Error ? error.message : String(error) });
    return notRebuilt(`Saving the profile failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if ('error' in outcome) return notRebuilt(outcome.error);
  return { status: 'succeeded', summary: outcome.summary, error: null };
}

export interface SettledExtraction { status: SettleStatus; summary: string | null; error: string | null }

/**
 * What a scheduler run that settled several executions (one conversation
 * each) reports: stopped (timed out, cancelled, interrupted) when one was,
 * else succeeded when one did, with every summary; failed, with the first
 * error, when none did. A failed execution keeps its conversation's position
 * for the next run.
 */
export function combineSettledExtractions(results: readonly SettledExtraction[]): SettledExtraction {
  if (results.length === 1) return results[0]!;
  for (const stop of ['timed_out', 'cancelled', 'interrupted'] as const) {
    const stopped = results.find((result) => result.status === stop);
    if (stopped) return stopped;
  }
  const done = results.filter((result) => result.status === 'succeeded');
  if (done.length === 0) return results[0] ?? { status: 'failed', summary: null, error: 'Automatic memory read nothing' };
  const parts = done.map((result) => (result.summary ?? '').replace(/^Automatic memory: /u, '')).filter(Boolean);
  const failed = results.length - done.length;
  const summary = `Automatic memory: ${results.length} conversations · ${parts.join(' | ')}`
    + `${failed ? ` · ${failed} not read now, kept for the next run` : ''}`;
  return { status: 'succeeded', summary, error: null };
}

/** Records an execution that ended without settling (setup failed or the scheduler stopped it). */
export function failMemoryExtractionRun(id: string, ownerUserId: string, error: string, now: number, cancelled = false): void {
  const run = getExtractionRun(id, ownerUserId);
  if (!run || run.state !== 'active') return;
  finishExtractionRun({ id, state: cancelled ? 'cancelled' : 'failed', summary: null, error: cancelled ? 'Cancelled' : error,
    reportedTokens: null, now });
  if (run.kind === 'profile') recordProfileFailure(ownerUserId, cancelled ? 'Cancelled' : error, now);
  if (run.kind === 'consolidate') clearPlannedCursor(ownerUserId, id, now);
}
