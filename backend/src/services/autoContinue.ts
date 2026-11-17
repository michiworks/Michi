/**
 * Bounded automatic continuation (C81 step 1). A turn that stopped before it
 * finished for a reason outside the task is carried on by Michi, as if the
 * user had typed "continue", instead of waiting for them to:
 *
 * - it completed at a limit: stop reason max_tokens or max_turn_requests
 *   (Kiro's step cap);
 * - it failed on an error that clears up by itself: transient or connection
 *   (classifyAcpError), or a usage or rate limit (classifyMetaAgentRunError),
 *   read together by services/turnFailure.ts.
 *
 * Never for a Stop, a refusal, a sign-in or credentials failure, or a turn
 * a Michi restart cut short: those keep their Interrupted notice or the
 * answer's own line (shared turnEnd). Like thread replies (agents/
 * threadMessageWakes.ts), nothing is started after a restart: candidates
 * live in this process only, and a turn that ended in an earlier one is
 * never picked up.
 *
 * Which conversations: those Michi started and still follows (turnGuard
 * isMichiWorkConversation), always; the user's own only when Settings ›
 * Michi's "Auto-continue your chats" is on. Never while Michi is paused,
 * never in a check-in, the assistant's own conversations, Pages upkeep or
 * a scheduled run (their owners retry them), nor for a multi-model plan's
 * step (the plan retries it) or a turn without a request.
 *
 * When. A work conversation waits WORK_WAIT_MS after the turn ended, the
 * user's own USER_WAIT_MS, and gives up FRESHNESS_MS after that (a laptop
 * that slept past it continues nothing). At its time it still needs: no
 * newer turn in the conversation (the user wrote, or Michi sent something),
 * no Stop in it meanwhile, nothing running or queued there, no approval or
 * question waiting; until then it waits. At most AT_ONCE continuations
 * run at once.
 *
 * How many. Each continuation is a visible user message
 * "[auto-continue n/3 · <reason>]" with the shared continuation prompt
 * (turnContinuation.ts), sent through ChatHub.startRequestedSelfTurn;
 * `autoContinue` in its metadata records n. A turn that stops again is
 * continued as n + 1 up to IN_A_ROW; a user message, or a continued turn
 * that finishes, starts the count over (the next request has no `n`).
 * shouldStart withdraws a continuation still queued when the user sent
 * something first.
 *
 * Permissions. The continued turn follows the conversation's own mode, as
 * the user's "continue" would: its message carries no Michi-sent metadata
 * (companionSend, threadMessage), so turnGuard does not make it a
 * Michi-driven turn, and turnGuard and the Michi source do not count it as
 * the user writing in a work conversation either, which keeps that
 * conversation's rules as they were.
 */

import {
  autoContinueLabel,
  buildContinuationPrompt,
  isCheckinNodeId,
  parseAutoContinueSource,
  type AutoContinueReason,
  type AutoContinueSource,
  type ContinuationMessage,
  type DurableMessageMetadata,
} from 'michi-shared';
import type { ChatHub, TurnFinalizedEvent } from '../agents/chatHub';
import { startUnderRestoreLock } from '../agents/requestedTurnStart';
import type { AgentSession } from '../agents/types';
import { isAssistantNode } from '../assistant/identity';
import { requestAgentOwnerOrNull } from './agentOwner';
import { openDbOrNull } from './db';
import { log } from './logger';
import { classifyTurnFailure } from './turnFailure';
import { isMichiWorkConversation } from './turnGuard';

export const AUTO_CONTINUE_LIMITS = Object.freeze({
  IN_A_ROW: 3,
  AT_ONCE: 3,
  WORK_WAIT_MS: 60_000,
  USER_WAIT_MS: 5 * 60_000,
  FRESHNESS_MS: 30 * 60_000,
  TICK_MS: 10_000,
});

/** Derived from the turn it continues, so the same continuation never starts twice. */
export function autoContinueTurnId(fromTurnId: string): string {
  return `auto-continue-${fromTurnId}`;
}

/** How many of the conversation's latest messages a failed turn's restore reads back. */
const TRANSCRIPT_MESSAGES = 200;
const STOPPED_TURNS_MAX = 1_000;

type Hub = Pick<ChatHub, 'onTurnFinalized' | 'onCancel' | 'startRequestedSelfTurn' | 'isBusy' | 'getPendingPermission'
  | 'getPendingUserInput' | 'isShuttingDown'>;

export interface AutoContinueDeps {
  hub: Hub;
  /** ChatManager.ensureParentSession. */
  ensureSession(input: { ownerUserId: string; workspaceId: string; nodeId: string }): Promise<AgentSession | null>;
  /** nativeResume.acquireSessionRestoreLock; serializes with POST /message. */
  acquireRestoreLock(nodeId: string): Promise<() => void>;
  /** requestedTurnStart.isRegisteredLiveSession; absent: not checked. */
  isLiveSession?(session: AgentSession): boolean;
  /** Settings › Michi's "Auto-continue your chats" (CompanionSettings.autoContinueChats). */
  userChatsOn(): boolean;
  /** Pause Michi holds for this owner (services/michiPause.ts). */
  michiPaused(ownerUserId: string): boolean;
  now?(): number;
  /** Runs `tick` every `everyMs` until the returned function is called. Default: an unref'd interval. */
  every?(tick: () => void, everyMs: number): () => void;
}

interface Candidate {
  chatId: string;
  nodeId: string;
  workspaceId: string;
  /** The turn's owner as ChatHub had it: null on the desktop. */
  ownerUserId: string | null;
  /** Whose Michi pause and session it is. */
  agentOwner: string;
  fromTurnId: string;
  reason: AutoContinueReason;
  n: number;
  work: boolean;
  dueAt: number;
  expiresAt: number;
}

type Check = 'go' | 'wait' | 'drop';

interface NodeRow {
  kind: string | null;
  status: string | null;
  deleted_at: number | null;
  maintenance_job_id: string | null;
  scheduled_only_job_id: string | null;
  metadata: string | null;
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The reason a finished turn may be continued for, or null. */
export function autoContinueReasonOf(turn: Pick<TurnFinalizedEvent, 'outcome' | 'persisted' | 'stopReason' | 'error' | 'errorCode'>): AutoContinueReason | null {
  if (!turn.persisted) return null;
  if (turn.outcome === 'completed') {
    return turn.stopReason === 'max_tokens' || turn.stopReason === 'max_turn_requests' ? turn.stopReason : null;
  }
  if (turn.outcome !== 'error') return null;
  const kind = classifyTurnFailure(turn.error, turn.errorCode);
  return kind === 'transient' || kind === 'connection' || kind === 'quota' ? kind : null;
}

export class AutoContinue {
  private readonly candidates = new Map<string, Candidate>();
  /** Continuations being opened, queued or running: what AT_ONCE counts. */
  private readonly running = new Set<string>();
  /** Turns the user stopped here, newest last. */
  private readonly stopped = new Set<string>();
  private readonly unsubscribe: Array<() => void> = [];
  private cancelTimer: (() => void) | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: AutoContinueDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.unsubscribe.length > 0) return;
    this.unsubscribe.push(
      this.deps.hub.onTurnFinalized((turn) => this.turnFinalized(turn)),
      this.deps.hub.onCancel(({ chatId, turnId }) => this.cancelled(chatId, turnId)),
    );
  }

  stop(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.candidates.clear();
  }

  /** The conversations waiting to be continued (tests, diagnostics). */
  pending(): ReadonlyArray<Readonly<Candidate>> {
    return [...this.candidates.values()];
  }

  /** Starts what is due; the interval calls it, tests call it with their clock. */
  tick(): void {
    const now = this.now();
    const due = [...this.candidates.values()].sort((a, b) => a.dueAt - b.dueAt);
    for (const candidate of due) {
      if (now > candidate.expiresAt) {
        this.candidates.delete(candidate.nodeId);
        log.info('chat', 'auto-continue expired', { nodeId: candidate.nodeId, fromTurnId: candidate.fromTurnId });
        continue;
      }
      if (now < candidate.dueAt) continue;
      if (this.running.size >= AUTO_CONTINUE_LIMITS.AT_ONCE) break;
      const check = this.check(candidate);
      if (check === 'wait') continue;
      this.candidates.delete(candidate.nodeId);
      if (check === 'go') void this.begin(candidate);
    }
    this.settleTimer();
  }

  private turnFinalized(turn: TurnFinalizedEvent): void {
    try {
      this.running.delete(turn.turnId);
      // The conversation's latest turn decides: a later one replaces what an earlier one left.
      this.candidates.delete(turn.nodeId);
      const candidate = this.candidateOf(turn);
      if (candidate) {
        this.candidates.set(turn.nodeId, candidate);
        log.info('chat', 'auto-continue scheduled', {
          nodeId: turn.nodeId, fromTurnId: turn.turnId, reason: candidate.reason, n: candidate.n, inMs: candidate.dueAt - this.now(),
        });
      }
      this.settleTimer();
    } catch (error) {
      log.warn('chat', 'auto-continue not scheduled', { nodeId: turn.nodeId, turnId: turn.turnId, error: errorMessage(error) });
    }
  }

  /** A Stop: the stopped turn is never continued, and nothing waiting in that conversation starts. */
  private cancelled(chatId: string, turnId: string): void {
    this.stopped.add(turnId);
    if (this.stopped.size > STOPPED_TURNS_MAX) this.stopped.delete(this.stopped.values().next().value!);
    for (const candidate of this.candidates.values()) {
      if (candidate.chatId === chatId) this.candidates.delete(candidate.nodeId);
    }
  }

  private candidateOf(turn: TurnFinalizedEvent): Candidate | null {
    if (this.deps.hub.isShuttingDown() || this.stopped.has(turn.turnId) || !turn.userMessageId) return null;
    const reason = autoContinueReasonOf(turn);
    if (!reason) return null;
    const row = this.nodeRow(turn.nodeId, turn.userMessageId);
    if (!row || !this.eligibleNode(turn.nodeId, row)) return null;
    const userMetadata = parseMetadata(row.metadata) as DurableMessageMetadata & Record<string, unknown>;
    // Their owners retry these: a scheduled job's run, a multi-model plan's step.
    if (userMetadata.scheduledJobId || userMetadata.threadMessage?.plan) return null;
    const n = (parseAutoContinueSource(userMetadata.autoContinue)?.n ?? 0) + 1;
    if (n > AUTO_CONTINUE_LIMITS.IN_A_ROW) return null;
    const work = isMichiWorkConversation(turn.nodeId);
    if (!work && !this.userChatsOn()) return null;
    const agentOwner = requestAgentOwnerOrNull(turn.ownerUserId);
    if (!agentOwner || this.paused(agentOwner)) return null;
    const endedAt = this.now();
    const dueAt = endedAt + (work ? AUTO_CONTINUE_LIMITS.WORK_WAIT_MS : AUTO_CONTINUE_LIMITS.USER_WAIT_MS);
    return {
      chatId: turn.chatId,
      nodeId: turn.nodeId,
      workspaceId: turn.workspaceId,
      ownerUserId: turn.ownerUserId,
      agentOwner,
      fromTurnId: turn.turnId,
      reason,
      n,
      work,
      dueAt,
      expiresAt: dueAt + AUTO_CONTINUE_LIMITS.FRESHNESS_MS,
    };
  }

  private nodeRow(nodeId: string, userMessageId: string | null): NodeRow | null {
    const db = openDbOrNull();
    if (!db) return null;
    const row = db.prepare(`SELECT n.kind, n.status, n.deleted_at, n.maintenance_job_id, n.scheduled_only_job_id, m.metadata
        FROM nodes n LEFT JOIN messages m ON m.id = ? AND m.node_id = n.id WHERE n.id = ?`)
      .get(userMessageId ?? '', nodeId) as unknown as NodeRow | undefined;
    return row ?? null;
  }

  private eligibleNode(nodeId: string, row: NodeRow): boolean {
    if (row.kind !== 'chat' || row.deleted_at !== null || row.status === 'archived') return false;
    if (row.maintenance_job_id || row.scheduled_only_job_id) return false;
    return !isCheckinNodeId(nodeId) && !isAssistantNode(nodeId);
  }

  /** The candidate is still the conversation's latest word and nothing turned it off. */
  private stillCurrent(candidate: Candidate): boolean {
    if (this.deps.hub.isShuttingDown() || this.stopped.has(candidate.fromTurnId)) return false;
    if (!candidate.work && !this.userChatsOn()) return false;
    if (this.paused(candidate.agentOwner)) return false;
    const db = openDbOrNull();
    if (!db) return false;
    const latest = db.prepare('SELECT turn_id FROM turns WHERE node_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1')
      .get(candidate.nodeId) as { turn_id: string } | undefined;
    if (latest?.turn_id !== candidate.fromTurnId) return false;
    const row = this.nodeRow(candidate.nodeId, null);
    return !!row && this.eligibleNode(candidate.nodeId, row);
  }

  private check(candidate: Candidate): Check {
    if (!this.stillCurrent(candidate)) return 'drop';
    const { hub } = this.deps;
    if (hub.isBusy(candidate.chatId)) return 'wait';
    if (hub.getPendingPermission(candidate.chatId) || hub.getPendingUserInput(candidate.chatId)) return 'wait';
    return 'go';
  }

  private async begin(candidate: Candidate): Promise<void> {
    const turnId = autoContinueTurnId(candidate.fromTurnId);
    this.running.add(turnId);
    const meta = { nodeId: candidate.nodeId, fromTurnId: candidate.fromTurnId, turnId, reason: candidate.reason, n: candidate.n };
    try {
      const session = await this.deps.ensureSession({
        ownerUserId: candidate.agentOwner, workspaceId: candidate.workspaceId, nodeId: candidate.nodeId,
      });
      // Opening the session can take a while: the user may have written or stopped meanwhile.
      if (!session || this.check(candidate) === 'drop') {
        this.running.delete(turnId);
        if (!session) log.warn('chat', 'auto-continue skipped: no session', meta);
        return;
      }
      const source: AutoContinueSource = {
        n: candidate.n, of: AUTO_CONTINUE_LIMITS.IN_A_ROW, reason: candidate.reason, fromTurnId: candidate.fromTurnId,
      };
      const label = autoContinueLabel(source);
      const prompt = buildContinuationPrompt(this.transcript(candidate.nodeId), candidate.reason, 'auto');
      const displayText = `${label} Continue from where you stopped.`;
      const release = await this.deps.acquireRestoreLock(candidate.nodeId);
      const started = await startUnderRestoreLock(release, session, this.deps.isLiveSession, () => this.deps.hub.startRequestedSelfTurn({
        chatId: session.id,
        nodeId: candidate.nodeId,
        ownerUserId: candidate.ownerUserId,
        turnId,
        text: prompt ? `${label}\n\n${prompt}` : displayText,
        displayText,
        userMetadata: { autoContinue: source },
        session,
        shouldStart: () => this.stillCurrent(candidate),
      }));
      log.info('chat', 'auto-continue started', meta);
      void started.done.catch(() => {}).finally(() => this.running.delete(turnId));
    } catch (error) {
      this.running.delete(turnId);
      log.info('chat', 'auto-continue not started', { ...meta, error: errorMessage(error) });
    } finally {
      this.settleTimer();
    }
  }

  /** The conversation's latest messages, for the prompt's restore of a failed turn. */
  private transcript(nodeId: string): ContinuationMessage[] {
    const db = openDbOrNull();
    if (!db) return [];
    const rows = db.prepare('SELECT role, content, tool_calls, metadata FROM messages WHERE node_id = ? ORDER BY seq DESC LIMIT ?')
      .all(nodeId, TRANSCRIPT_MESSAGES) as Array<{ role: string; content: string | null; tool_calls: string | null; metadata: string | null }>;
    return rows.reverse().map((row) => {
      const metadata = parseMetadata(row.metadata);
      let toolCalls: ContinuationMessage['toolCalls'];
      try {
        const parsed = row.tool_calls ? JSON.parse(row.tool_calls) as unknown : null;
        toolCalls = Array.isArray(parsed)
          ? (parsed as Array<Record<string, unknown> | null>).filter((tool): tool is NonNullable<ContinuationMessage['toolCalls']>[number] & Record<string, unknown> =>
            !!tool && typeof tool.id === 'string' && typeof tool.status === 'string')
          : undefined;
      } catch {
        toolCalls = undefined;
      }
      return {
        role: row.role === 'assistant' ? 'assistant' : 'user',
        text: row.content ?? '',
        steered: metadata.steered === true,
        autoContinue: metadata.autoContinue !== undefined,
        toolCalls,
      };
    });
  }

  private userChatsOn(): boolean {
    try {
      return this.deps.userChatsOn();
    } catch {
      return false;
    }
  }

  private paused(owner: string): boolean {
    try {
      return this.deps.michiPaused(owner);
    } catch {
      return true;
    }
  }

  /** The interval runs while something waits or runs. */
  private settleTimer(): void {
    const needed = this.candidates.size > 0;
    if (needed && !this.cancelTimer) {
      const every = this.deps.every ?? ((tick, ms) => {
        const timer = setInterval(tick, ms);
        timer.unref?.();
        return () => clearInterval(timer);
      });
      this.cancelTimer = every(() => this.tick(), AUTO_CONTINUE_LIMITS.TICK_MS);
    } else if (!needed && this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
  }
}
