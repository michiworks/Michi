import {
  AgentRunStatus,
  approvalAttentionCopy,
  attentionLevelAllows,
  CHAT_STREAM_EVENTS,
  completionAttentionCopy,
  DEFAULT_COMPANION_NAME,
  companionPostRunId,
  failureAttentionCopy,
  parseThreadMessageSource,
  questionAttentionCopy,
  turnEndAttentionKind,
  type AgentRunDtoV1,
  type AttentionClaimResultV1,
  type AttentionKind,
  type AttentionLevel,
  type AttentionNotificationV1,
  type AttentionReason,
  type AttentionResolveReason,
  type AttentionTargetV1,
  type ChatStreamEvent,
  type CompanionTarget,
  type DurableMessageMetadata,
  type PaneTarget,
  type ScheduledJobRunEvent,
  type WorkflowApprovalDto,
  type WorkflowRunDtoV1,
  type WorkspaceStructureChangedEvent,
  type WorkspaceStructureOp,
} from 'michi-shared';
import { BACKEND_RESTARTED_ERROR } from '../turnPersistence.recipes';
import { NOTIFIER_GRACE_MS, type AppLauncher } from '../scheduledJobs/appLauncher';
import type { NodeCompletionSeen, PermissionAnswered } from '../attentionSignals';
import { log } from '../logger';
import {
  AttentionRepository,
  attentionOwnerOf,
  toAttentionNotification,
  toAttentionResolved,
  type NewAttention,
  type NodeAttentionFacts,
  type StoredAttention,
} from './attentionRepository';
import { AttentionFeed, attentionFeed as defaultFeed } from './attentionFeed';
import { AttentionWakeFacts } from './attentionWakeFacts';

/**
 * The server's attention decisions (Herdr's model: the server holds the
 * completion and seen facts; notifications are semantic events clients
 * present). Producers propose a fact; after `decisionDelayMs` the fact is
 * checked again and, unless it went stale or a focused window has its target
 * on screen, becomes the active record of its target's key. Records resolve
 * when answered, seen or stale, and expire after `maxAgeMs`; every change is
 * published on the owner's background feeds (attentionFeed.ts).
 *
 * It is the one place that decides whether to call the user (DESIGN P4):
 * every producer below proposes facts here, and nothing else notifies.
 *
 * Producers: chat turn events (permission and user input requests, a turn
 * that completed with an answer, a genuine failure; never a cancellation or a
 * backend restart), Agent Run watches in notify mode (agentRunNotifier), the
 * tool approvals workflow runs wait on (observeWorkflowRun): a Claude
 * workflow agent asking between turns, a Kiro workflow step. Those never
 * reach the chat as a permission request. A multi-model run's approvals are
 * copies of its branches' chat requests, which notify by themselves.
 * Scheduled Job runs (observeScheduledRun, from the scheduler's events): a
 * run that asks for an approval or input, and one that finished with its
 * job's Notify on, under `scheduled_run:<runId>`; the turns such a run sends,
 * and the end of each woken reply in a wake chain one began, make no chat
 * record of their own, and maintenance transcripts none at all. Michi itself
 * (proposeAgent, from services/companion/notices.ts): its Today's Needs you
 * (`agent:item:<itemId>`), its posts in its conversation (`agent:chat`) and
 * a conversation it delegated that finished (`agent:node:<nodeId>`); the
 * post turns themselves (a check-in's post, first-run narration) neither make
 * a chat record nor leave the conversation's record stale. That
 * conversation's records speak under the agent's name (`assistantName`).
 *
 * The desktop notifier. Electron main subscribes to the feed as the desktop
 * notifier (routes/attention.ts) and shows the records the user's level lets
 * through while no Michi window is open, claiming each first
 * (DESKTOP_NOTIFIER_WINDOW_ID): a window that opens later lists it but
 * raises no second OS notification. When a record the level lets through is
 * decided while no notifier has been connected for the grace, the app is
 * woken to show it (configureDesktopWake; the macOS background service only).
 *
 * Seen. A view mark (nodeCompletionSeen) resolves only a completion it
 * covers: marks reach the server seconds late, so one for an earlier
 * completion must not withdraw a later completion, approval or question. A
 * focused window showing the target resolves (and suppresses) records except
 * questions and workflow approvals: their card can be off screen in a
 * visible pane, so windows decide, and only an answer or the turn ending
 * (for a workflow approval, its leaving every run) resolves one.
 *
 * send_to_thread exchanges. While agents hand a task back and forth, only
 * the exchange's end is a completion to call the user to. No completion is
 * recorded for a turn that asked for a wake still open (its reply continues
 * the chain), nor for the target's turn for a message whose reply reaches
 * the sender by itself: sent with wake (a reply that cannot be delivered
 * still notifies), or sent while the sending turn is still running when the
 * target's turn ends (a `wait`, or wait_pane on that turn: nothing else
 * records a wait). The sender's reply turn that ends without asking for
 * another wake notifies as usual.
 *
 * Structure. Records whose target is trashed or archived resolve as stale,
 * follow a target moved to another workspace, and are deleted, whatever their
 * status, once it is purged: they carry thread titles and tool, question and
 * error text (structureChanged; reconciled at startup the same way).
 *
 * Keys: `node:<nodeId>`, `agent_run:<runId>`, `workflow:<nodeId>:<approval>`
 * (a node's chat turns do not end what its workflows wait on, and Claude
 * shows one approval on every running workflow of the chat),
 * `scheduled_run:<runId>` and `agent:…`, one active record per key. Facts:
 * `permission:<turn>:<request>`, `input:<turn>:<request>`,
 * `completion:<completion_seq>`, `failed:<turn>`, `run:<status>`,
 * `approval:<requestedAt>` (Claude numbers approvals per session),
 * `attention:<approval|input>:<at>` for a scheduled run, and the producer's own
 * for Michi's.
 */

/** Read-only presence: does a focused window show this target right now (panePresence.ts)? */
export interface AttentionPresence {
  isTargetVisibleInFocusedWindow(ownerUserId: string, target: PaneTarget): boolean;
}

export interface AttentionClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemClock: AttentionClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface AttentionServiceOptions {
  presence: AttentionPresence;
  repository?: AttentionRepository;
  feed?: AttentionFeed;
  /** The send_to_thread wake records the exchange rules read. */
  wakes?: AttentionWakeFacts;
  /** Re-reads a Run when its notification is decided; without it the notified snapshot is used. */
  getRun?: (ownerUserId: string, runId: string) => AgentRunDtoV1 | null;
  /** A turn whose completion notifies nobody: a multi-model branch's answer or review (its synthesis does). */
  isHandOffTurn?: (turnId: string) => boolean;
  /** The agent's name, read at decision time (the Companion's displayName); DEFAULT_COMPANION_NAME without it. */
  assistantName?: () => string;
  /** The agent's panel is open and focused in some window: its conversation's updates are seen there. */
  agentPanelFocused?: () => boolean;
  /** The user's notification level, for the desktop notifier and its wake (default `all`). */
  level?: () => AttentionLevel;
  clock?: AttentionClock;
  /** How long a fact must stay current before it becomes a record. */
  decisionDelayMs?: number;
  /** Active records older than this expire. */
  maxAgeMs?: number;
  /** Resolved and expired records are deleted after this. */
  retentionMs?: number;
  sweepIntervalMs?: number;
  onError?: (message: string, error: unknown) => void;
}

/** The window id a record is claimed under once Electron main, the desktop notifier, shows it (claimForDesktop). */
export const DESKTOP_NOTIFIER_WINDOW_ID = 'desktop-notifier';

/** The title of a record from the agent's own conversation, in the agent's name. */
function agentNoticeTitle(name: string, kind: 'approval' | 'question' | 'reply'): string {
  return kind === 'approval' ? `${name}: needs your approval` : kind === 'question' ? `${name}: has a question` : `${name} replied`;
}

/**
 * One fact of Michi's own (services/companion/notices.ts proposes them):
 * an item of its Today that needs the user (`needs_you`), or a post of its
 * own (`update`). `isCurrent` is asked again when it is decided.
 */
export interface AgentAttentionProposal {
  key: string;
  fact: string;
  kind: AttentionKind;
  reason: Extract<AttentionReason, 'needs_you' | 'update'>;
  title: string;
  body: string;
  /** The slot the target names (`chat`, `item:<id>`, `node:<id>`). */
  ref: string;
  /** Where a click takes the user. */
  open: CompanionTarget;
  isCurrent?: () => boolean;
}

export const ATTENTION_DECISION_DELAY_MS = 1_000;
export const ATTENTION_MAX_AGE_MS = 24 * 60 * 60_000;
const ATTENTION_RETENTION_MS = 7 * 24 * 60 * 60_000;
const ATTENTION_SWEEP_INTERVAL_MS = 10 * 60_000;
/** Bounds the per-node and per-turn memory (latest and running turns, message senders, scheduled turns). */
const MEMORY_LIMIT = 2_000;
/** Structure changes that can leave a record pointing at something trashed, archived, moved or gone. */
const REVALIDATING_OPS: ReadonlySet<WorkspaceStructureOp> = new Set<WorkspaceStructureOp>(['moved', 'archived', 'deleted', 'purged']);

interface Candidate {
  key: string;
  /** The record to create, read at decision time; null when the fact is no longer current. */
  build(): NewAttention | null;
  /** Called once the candidate is decided or replaced (Run watches await it). */
  settle(): void;
}

interface PendingDecision {
  candidate: Candidate;
  timer: unknown;
}

interface NodeFactSpec {
  fact: string;
  kind: AttentionKind;
  reason: AttentionReason;
  title: string;
  body: string;
}

/** A thread message's sender, as it ran when the message's turn began. */
interface MessageSender {
  nodeId: string;
  turnId: string;
}

function nodeKey(nodeId: string): string {
  return `node:${nodeId}`;
}

function runKey(runId: string): string {
  return `agent_run:${runId}`;
}

const WORKFLOW_KEY_PREFIX = 'workflow:';

function workflowApprovalKey(nodeId: string, approvalId: string): string {
  return `${WORKFLOW_KEY_PREFIX}${encodeURIComponent(nodeId)}:${encodeURIComponent(approvalId)}`;
}

function scheduledRunKey(runId: string): string {
  return `scheduled_run:${runId}`;
}

const AGENT_KEY_PREFIX = 'agent:';

function interactionFact(kind: 'permission' | 'input', turnId: string, requestId: number): string {
  return `${kind}:${encodeURIComponent(turnId)}:${requestId}`;
}


/** First-run narration's turn ids (services/metaAgent/firstRunNarration.ts). */
const NARRATION_TURN_PREFIX = 'mna-';

/**
 * A post Michi makes into the agent's conversation as a complete turn of its
 * own (chatHub.postSelfMessage): a check-in's post (`cmp-post-<runId>`) or
 * first-run narration. No user message, nothing to approve or answer, and no
 * reply to anyone: Michi's notices propose it as an update (proposeAgent).
 */
function isCompanionPost(data: Extract<ChatStreamEvent, { event: 'turn_start' }>['data']): boolean {
  return data.selfInitiated === true && !data.userText
    && (companionPostRunId(data.turnId) !== null || data.turnId.startsWith(NARRATION_TURN_PREFIX));
}

/** The completion count a `completion:<n>` fact names; null for any other fact. */
function completionSeqOf(fact: string): number | null {
  const match = /^completion:(\d+)$/.exec(fact);
  return match ? Number(match[1]) : null;
}

/** One pane as a string: what paneTargetOf names, to match records against a window's panes. */
function paneTargetId(target: PaneTarget): string | null {
  if (target.kind === 'node') return `node:${target.nodeId}`;
  if (target.kind === 'agent_run') return `agent_run:${target.runId}`;
  return null;
}

/** Whether a focused window showing the target means the user saw it (not a question or a workflow's approval: see the header). */
function seenWhenShown(record: Pick<StoredAttention, 'reason' | 'key'>): boolean {
  return record.reason !== 'question' && !record.key.startsWith(WORKFLOW_KEY_PREFIX);
}

/** A scheduled run's needs-input fact (observeScheduledRun). */
function scheduledAttentionFact(kind: 'approval' | 'input', at: number): string {
  return `attention:${kind}:${at}`;
}

/** The pane that shows a target, if one can: an `agent` record about its own conversation is asked about the panel instead. */
function paneTargetOf(target: AttentionTargetV1): PaneTarget | null {
  switch (target.type) {
    case 'node': return { kind: 'node', nodeId: target.nodeId };
    case 'agent_run': return { kind: 'agent_run', runId: target.runId };
    case 'scheduled_run': return target.nodeId ? { kind: 'node', nodeId: target.nodeId } : null;
    case 'agent': return target.open.kind === 'node' ? { kind: 'node', nodeId: target.open.nodeId } : null;
  }
}



/** Insertion-ordered map that forgets its oldest entries past `limit`. */
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MEMORY_LIMIT) map.delete(map.keys().next().value as string);
}

export class AttentionService {
  private readonly repository: AttentionRepository;
  private readonly feed: AttentionFeed;
  private readonly presence: AttentionPresence;
  private readonly wakes: AttentionWakeFacts;
  private readonly getRun?: (ownerUserId: string, runId: string) => AgentRunDtoV1 | null;
  private readonly isHandOffTurn?: (turnId: string) => boolean;
  private readonly assistantName?: () => string;
  private readonly agentPanelFocused?: () => boolean;
  private readonly level: () => AttentionLevel;
  private readonly clock: AttentionClock;
  private readonly decisionDelayMs: number;
  private readonly maxAgeMs: number;
  private readonly retentionMs: number;
  private readonly sweepIntervalMs: number;
  private readonly onError: (message: string, error: unknown) => void;

  private readonly pending = new Map<string, PendingDecision>();
  /** Active records by key, mirrored from the store so turn events need no read. */
  private readonly active = new Map<string, StoredAttention>();
  /** Permission and question facts still waiting for an answer, by turn. */
  private readonly openInteractions = new Map<string, Set<string>>();
  private readonly latestTurn = new Map<string, string>();
  /** The turn each node runs now: from its turn_start until its done or error. */
  private readonly runningTurns = new Map<string, string>();
  /** A thread message's turn → the sender's turn that was running when it began. */
  private readonly messageSenders = new Map<string, MessageSender>();
  private readonly scheduledTurns = new Map<string, boolean>();
  /** The turns of Michi's posts (isCompanionPost) until their done: their frames are no news about the conversation. */
  private readonly posts = new Map<string, true>();
  /** A scheduled run's thread → the run's key, while the run may wait on the user there (observeScheduledRun). */
  private readonly scheduledRunNodes = new Map<string, string>();
  /** How a decided record wakes the quit app (configureDesktopWake); null: it never does. */
  private desktopWake: { launcher: AppLauncher; graceMs: number; setTimer: (callback: () => void, delayMs: number) => () => void } | null = null;
  /** The one look again once the desktop notifier's grace is up; null while none is armed. */
  private cancelWakeCheck: (() => void) | null = null;
  /** Records decided since the look again was armed may wake the app when it fires. */
  private wakeCheckSince = 0;
  /** Approvals workflow runs wait on, by record key: the runs that show each. */
  private readonly workflowApprovals = new Map<string, Set<string>>();
  /** The approval keys each run showed when last observed. */
  private readonly workflowApprovalsByRun = new Map<string, Set<string>>();
  private sweepTimer: unknown = null;
  private started = false;
  private stopped = false;

  /** AgentRunNotifier for Agent Run watches in notify mode (agents/runs/ports.ts). It resolves
   *  once the notification is decided, so a watch is marked delivered after its record exists. */
  readonly agentRunNotifier = {
    notify: (ownerUserId: string, run: AgentRunDtoV1): Promise<void> => this.notifyAgentRun(ownerUserId, run),
  };

  constructor(options: AttentionServiceOptions) {
    this.presence = options.presence;
    this.repository = options.repository ?? new AttentionRepository();
    this.feed = options.feed ?? defaultFeed;
    this.wakes = options.wakes ?? new AttentionWakeFacts();
    this.getRun = options.getRun;
    this.isHandOffTurn = options.isHandOffTurn;
    this.assistantName = options.assistantName;
    this.agentPanelFocused = options.agentPanelFocused;
    this.level = options.level ?? (() => 'all');
    this.clock = options.clock ?? systemClock;
    this.decisionDelayMs = options.decisionDelayMs ?? ATTENTION_DECISION_DELAY_MS;
    this.maxAgeMs = options.maxAgeMs ?? ATTENTION_MAX_AGE_MS;
    this.retentionMs = options.retentionMs ?? ATTENTION_RETENTION_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? ATTENTION_SWEEP_INTERVAL_MS;
    this.onError = options.onError
      ?? ((message, error) => log.warn('chat', message, { error: error instanceof Error ? error.message : String(error) }));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Reconciles the records a previous process left, then serves the feed. */
  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      this.reconcile();
      this.sweep();
    } catch (error) {
      this.onError('attention startup reconciliation failed', error);
    }
    this.sweepTimer = this.clock.setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.feed.connect((ownerUserId) => this.snapshot(ownerUserId));
  }

  /**
   * Decides every pending fact now, while the database is still open (a Run
   * watch counts as delivered once its notification settles), and stops
   * observing. Turn errors raised by the shutdown itself are not recorded.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.sweepTimer !== null) this.clock.clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.configureDesktopWake(null);
    for (const entry of [...this.pending.values()]) {
      this.clock.clearTimeout(entry.timer);
      this.decide(entry);
    }
    this.feed.disconnect();
  }

  // ── Producers ────────────────────────────────────────────────────────────

  /** Chat turn events, as ChatHub broadcasts them (every owner, foreground and self turns). */
  observeChatEvent(event: ChatStreamEvent): void {
    if (this.stopped) return;
    try {
      this.handleChatEvent(event);
    } catch (error) {
      this.onError('attention could not observe a turn event', error);
    }
  }

  private handleChatEvent(event: ChatStreamEvent): void {
    // A post's own frames are no news about its conversation: they neither replace the reply's pending decision nor end it.
    const postTurnId = event.data.turnId;
    if (postTurnId && this.posts.has(postTurnId)) {
      if (event.event === CHAT_STREAM_EVENTS.done || event.event === CHAT_STREAM_EVENTS.error) this.posts.delete(postTurnId);
      return;
    }
    switch (event.event) {
      case CHAT_STREAM_EVENTS.turnStart: {
        const nodeId = event.data.nodeId;
        const turnId = event.data.turnId;
        if (!nodeId || !turnId) return;
        if (isCompanionPost(event.data)) {
          remember(this.posts, turnId, true);
          return;
        }
        remember(this.latestTurn, nodeId, turnId);
        remember(this.runningTurns, nodeId, turnId);
        this.noteThreadMessage(nodeId, turnId, event.data.userMetadata);
        // A new turn makes the previous turn's attention stale; it will report its own outcome.
        const active = this.active.get(nodeKey(nodeId));
        if (active) this.resolveRecord(active, 'stale');
        return;
      }
      case CHAT_STREAM_EVENTS.permissionRequest: {
        const { nodeId, turnId, requestId } = event.data;
        if (!nodeId || !turnId) return;
        const fact = interactionFact('permission', turnId, requestId);
        this.openInteraction(turnId, fact);
        this.proposeNodeFact(nodeId, turnId, (facts) => (this.isOpen(turnId, fact) ? {
          fact,
          kind: 'needs_input',
          reason: 'approval',
          ...approvalAttentionCopy(event.data.title),
          ...(facts.assistant ? { title: agentNoticeTitle(this.agentName(), 'approval') } : {}),
        } : null));
        return;
      }
      case CHAT_STREAM_EVENTS.userInputRequest: {
        const { nodeId, turnId, requestId } = event.data;
        if (!nodeId || !turnId) return;
        const fact = interactionFact('input', turnId, requestId);
        this.openInteraction(turnId, fact);
        const question = event.data.questions?.[0]?.question;
        this.proposeNodeFact(nodeId, turnId, (facts) => (this.isOpen(turnId, fact) ? {
          fact,
          kind: 'needs_input',
          reason: 'question',
          ...questionAttentionCopy(question),
          ...(facts.assistant ? { title: agentNoticeTitle(this.agentName(), 'question') } : {}),
        } : null));
        return;
      }
      case CHAT_STREAM_EVENTS.permissionResolved: {
        const { nodeId, turnId, requestId } = event.data;
        if (nodeId) this.scheduledRunAnswered(nodeId);
        if (nodeId && turnId) this.answerInteraction(nodeId, turnId, interactionFact('permission', turnId, requestId));
        return;
      }
      case CHAT_STREAM_EVENTS.userInputResolved: {
        const { nodeId, turnId, requestId } = event.data;
        if (nodeId) this.scheduledRunAnswered(nodeId);
        if (nodeId && turnId) this.answerInteraction(nodeId, turnId, interactionFact('input', turnId, requestId));
        return;
      }
      case CHAT_STREAM_EVENTS.done: {
        const { nodeId, turnId, stopReason } = event.data;
        if (!nodeId || !turnId) return;
        // Read as the turn ends: a sender still running now gets the reply by itself.
        const senderWaiting = this.senderAwaitsReply(turnId);
        this.turnEnded(nodeId, turnId);
        this.endInteractions(nodeId, turnId);
        const kind = turnEndAttentionKind(stopReason);
        if (!kind) return;
        if (kind === 'failed') {
          this.proposeFailure(nodeId, turnId, 'The agent stopped before completing the turn.');
          return;
        }
        this.proposeNodeFact(nodeId, turnId, (facts) => {
          // Only this turn's own completion counts, and only until a focused window saw it.
          if (facts.lastCompletedTurnId !== turnId || facts.seenCompletionSeq >= facts.completionSeq) return null;
          // A hand-off within a send_to_thread exchange: the exchange's end notifies instead.
          if (senderWaiting || this.isExchangeHandOff(nodeId, turnId) || this.isHandOffTurn?.(turnId)) return null;
          return {
            fact: `completion:${facts.completionSeq}`,
            kind: 'finished',
            reason: 'completed',
            ...completionAttentionCopy(facts.assistant ? agentNoticeTitle(this.agentName(), 'reply') : facts.title),
          };
        });
        return;
      }
      case CHAT_STREAM_EVENTS.error: {
        const { nodeId, turnId, code, message } = event.data;
        if (!nodeId || !turnId) return;
        this.messageSenders.delete(turnId);
        this.turnEnded(nodeId, turnId);
        this.endInteractions(nodeId, turnId);
        // A restart cut the turn short: that is not the turn failing.
        if (code === BACKEND_RESTARTED_ERROR) return;
        this.proposeFailure(nodeId, turnId, message);
        return;
      }
      default:
        return;
    }
  }

  private proposeFailure(nodeId: string, turnId: string, message: string): void {
    this.proposeNodeFact(nodeId, turnId, (facts) => ({
      fact: `failed:${encodeURIComponent(turnId)}`,
      kind: 'failed',
      reason: 'error',
      ...failureAttentionCopy(facts.assistant ? this.agentName() : facts.title, message),
    }));
  }

  /** The agent's name for its own conversation's records; the default name when there is none to read. */
  private agentName(): string {
    try {
      return this.assistantName?.().trim() || DEFAULT_COMPANION_NAME;
    } catch {
      return DEFAULT_COMPANION_NAME;
    }
  }

  /** Agent Run watches in notify mode: one record per Run that completed or failed. */
  notifyAgentRun(runOwnerUserId: string, run: AgentRunDtoV1): Promise<void> {
    if (run.status !== AgentRunStatus.Completed && run.status !== AgentRunStatus.Failed) return Promise.resolve();
    const ownerUserId = attentionOwnerOf(runOwnerUserId);
    if (!ownerUserId) return Promise.resolve();
    const key = runKey(run.id);
    return new Promise<void>((settle) => {
      this.propose({
        key,
        settle,
        build: () => {
          const current = this.getRun ? this.getRun(runOwnerUserId, run.id) : run;
          // Terminal statuses are final; a Run that is gone or changed is not reported, nor one
          // whose workspace is in the trash or archived.
          if (!current || current.status !== run.status || this.repository.workspaceState(current.workspaceId) !== 'live') return null;
          const completed = current.status === AgentRunStatus.Completed;
          const name = current.effectiveDefinition?.name?.trim() || 'Agent';
          return {
            ownerUserId,
            key,
            fact: `run:${current.status}`,
            kind: completed ? 'finished' : 'failed',
            reason: completed ? 'run_completed' : 'run_failed',
            title: `${name} ${completed ? 'completed' : 'failed'}`,
            body: current.resultBundle?.handoff.conclusion || current.task,
            target: { type: 'agent_run', runId: current.id, workspaceId: current.workspaceId },
            createdAt: this.clock.now(),
          };
        },
      });
    });
  }

  /**
   * A workflow run as WorkflowRunHub publishes each change. An approval no run
   * showed before becomes a needs-input record for the run's chat; it
   * resolves, as stale, once no run shows it any more: answered on a card or
   * in the chat, withdrawn, lapsed, or its runs ended (the snapshot does not
   * say which).
   */
  observeWorkflowRun(run: WorkflowRunDtoV1): void {
    if (this.stopped) return;
    try {
      this.handleWorkflowRun(run);
    } catch (error) {
      this.onError('attention could not observe a workflow run', error);
    }
  }

  private handleWorkflowRun(run: WorkflowRunDtoV1): void {
    const nodeId = run.runtime === 'michi' ? null : run.nodeId;
    const shown = new Set<string>();
    if (nodeId) {
      for (const approval of run.approvals ?? []) {
        const key = workflowApprovalKey(nodeId, approval.id);
        shown.add(key);
        const hosts = this.workflowApprovals.get(key);
        if (hosts) hosts.add(run.id);
        else this.proposeWorkflowApproval(key, nodeId, approval, run.id);
      }
    }
    for (const key of this.workflowApprovalsByRun.get(run.id) ?? []) {
      const hosts = this.workflowApprovals.get(key);
      if (shown.has(key) || !hosts) continue;
      hosts.delete(run.id);
      if (hosts.size > 0) continue;
      this.workflowApprovals.delete(key);
      const active = this.active.get(key);
      if (active) this.resolveRecord(active, 'stale');
    }
    if (shown.size > 0) this.workflowApprovalsByRun.set(run.id, shown);
    else this.workflowApprovalsByRun.delete(run.id);
  }

  private proposeWorkflowApproval(key: string, nodeId: string, approval: WorkflowApprovalDto, runId: string): void {
    const hosts = new Set([runId]);
    this.workflowApprovals.set(key, hosts);
    this.propose({
      key,
      settle: () => {},
      build: () => {
        if (this.workflowApprovals.get(key) !== hosts) return null;
        const facts = this.repository.nodeFacts(nodeId);
        if (!facts || facts.hidden) return null;
        return {
          ownerUserId: facts.ownerUserId,
          key,
          fact: `approval:${approval.requestedAt}`,
          kind: 'needs_input',
          reason: 'approval',
          title: 'Workflow approval needed',
          body: approval.title || 'A workflow step is waiting for your approval',
          target: { type: 'node', nodeId, workspaceId: facts.workspaceId },
          createdAt: this.clock.now(),
        };
      },
    });
  }

  /**
   * A Scheduled Job run's lifecycle event (the scheduler's event bus). A run
   * waiting on the user (an approval or input) is a needs-input record, whatever
   * its job's Notify; it resolves once the request is answered in the run's
   * thread or the run ends. A run that finished notifies only with Notify on,
   * succeeded or failed (a timeout is a failure); any other end leaves
   * nothing. Click opens the run, wherever its thread shows.
   */
  observeScheduledRun(event: ScheduledJobRunEvent): void {
    if (this.stopped) return;
    try {
      this.handleScheduledRun(event);
    } catch (error) {
      this.onError('attention could not observe a scheduled run', error);
    }
  }

  private handleScheduledRun(event: ScheduledJobRunEvent): void {
    const key = scheduledRunKey(event.runId);
    const target: AttentionTargetV1 = {
      type: 'scheduled_run', runId: event.runId, jobId: event.jobId, nodeId: event.nodeId, workspaceId: event.workspaceId,
    };
    if (event.phase === 'started') return;
    if (event.phase === 'attention') {
      const kind = event.attention === 'input' ? 'input' : 'approval';
      if (event.nodeId) remember(this.scheduledRunNodes, event.nodeId, key);
      this.proposeScheduled(key, target, {
        fact: scheduledAttentionFact(kind, event.at),
        kind: 'needs_input',
        reason: kind === 'input' ? 'question' : 'approval',
        title: event.jobName,
        body: kind === 'input' ? 'Needs your input: the scheduled run is waiting' : 'Needs your approval: the scheduled run is waiting',
      }, () => this.scheduledRunNodes.get(event.nodeId ?? '') === key);
      return;
    }
    if (event.nodeId && this.scheduledRunNodes.get(event.nodeId) === key) this.scheduledRunNodes.delete(event.nodeId);
    const succeeded = event.status === 'succeeded';
    const failed = event.status === 'failed' || event.status === 'timed_out';
    if (!event.notify || (!succeeded && !failed)) {
      // Nothing to say; whatever the run waited on is moot now.
      this.dropPending(key);
      const active = this.active.get(key);
      if (active) this.resolveRecord(active, 'stale');
      return;
    }
    this.proposeScheduled(key, target, {
      fact: `run:${event.status}`,
      kind: succeeded ? 'finished' : 'failed',
      reason: succeeded ? 'run_completed' : 'run_failed',
      title: event.jobName,
      body: succeeded
        ? event.summary || 'Scheduled job finished'
        : event.error ? `Failed: ${event.error}` : 'Scheduled job failed',
    });
  }

  private proposeScheduled(key: string, target: Extract<AttentionTargetV1, { type: 'scheduled_run' }>, spec: NodeFactSpec,
    isCurrent: () => boolean = () => true): void {
    this.propose({
      key,
      settle: () => {},
      build: () => {
        if (!isCurrent()) return null;
        const ownerUserId = this.repository.workspaceOwner(target.workspaceId);
        if (!ownerUserId || this.repository.workspaceState(target.workspaceId) !== 'live') return null;
        return { ownerUserId, key, ...spec, target, createdAt: this.clock.now() };
      },
    });
  }

  /** An approval or question was answered in a thread: a scheduled run's record of it is moot. */
  private scheduledRunAnswered(nodeId: string): void {
    const key = this.scheduledRunNodes.get(nodeId);
    if (!key) return;
    this.scheduledRunNodes.delete(nodeId);
    this.dropPending(key);
    const active = this.active.get(key);
    if (active?.kind === 'needs_input') this.resolveRecord(active, 'answered');
  }

  /**
   * A fact of Michi's own (services/companion/notices.ts): it becomes the
   * active record of its key, in the agent's (system) workspace, unless it is
   * no longer current when decided or the user is looking at it.
   */
  proposeAgent(proposal: AgentAttentionProposal, workspaceId: string, ownerUserId: string): void {
    if (this.stopped) return;
    if (!proposal.key.startsWith(AGENT_KEY_PREFIX)) throw new Error(`an agent record's key starts with ${AGENT_KEY_PREFIX}`);
    try {
      this.propose({
        key: proposal.key,
        settle: () => {},
        build: () => {
          if (proposal.isCurrent && !proposal.isCurrent()) return null;
          if (this.repository.workspaceState(workspaceId) === 'gone') return null;
          return {
            ownerUserId,
            key: proposal.key,
            fact: proposal.fact,
            kind: proposal.kind,
            reason: proposal.reason,
            title: proposal.title,
            body: proposal.body,
            target: { type: 'agent', ref: proposal.ref, open: proposal.open, workspaceId },
            createdAt: this.clock.now(),
          };
        },
      });
    } catch (error) {
      this.onError('attention could not take an agent notice', error);
    }
  }

  /** The active records of Michi's own whose keys start with `prefix` (which must start with `agent:`). */
  activeAgentRecords(prefix: string): Array<{ key: string; fact: string }> {
    if (!prefix.startsWith(AGENT_KEY_PREFIX)) return [];
    return [...this.active.values()].filter((record) => record.key.startsWith(prefix)).map((record) => ({ key: record.key, fact: record.fact }));
  }

  /** A fact of Michi's no longer holds (an item resolved, snoozed or changed): its pending decision and its record go. */
  resolveAgent(key: string): void {
    if (this.stopped || !key.startsWith(AGENT_KEY_PREFIX)) return;
    try {
      this.dropPending(key);
      const active = this.active.get(key);
      if (active) this.resolveRecord(active, 'stale');
    } catch (error) {
      this.onError('attention could not resolve an agent notice', error);
    }
  }

  // ── Resolution inputs ────────────────────────────────────────────────────

  /**
   * A focused window recorded the node's completions up to `seenCompletionSeq`
   * as seen (attentionSignals.ts). Only a completion record it covers
   * resolves: the mark can arrive after a later completion or a new turn's
   * request became the node's record.
   */
  nodeCompletionSeen(event: NodeCompletionSeen): void {
    if (this.stopped) return;
    try {
      const active = this.active.get(nodeKey(event.nodeId));
      const seq = active ? completionSeqOf(active.fact) : null;
      if (active && seq !== null && seq <= event.seenCompletionSeq) this.resolveRecord(active, 'seen');
    } catch (error) {
      this.onError('attention could not apply a seen mark', error);
    }
  }

  /**
   * The permission route answered an approval (attentionSignals.ts). Some
   * runtimes also echo a permission_resolved event; either one resolves it.
   */
  permissionAnswered(event: PermissionAnswered): void {
    if (this.stopped) return;
    try {
      // Request ids count per turn, so the answer is matched within this node's own turn only.
      const turnId = event.turnId ?? this.latestTurn.get(event.nodeId);
      if (turnId) {
        this.answerInteraction(event.nodeId, turnId, interactionFact('permission', turnId, event.requestId));
        return;
      }
      const active = this.active.get(nodeKey(event.nodeId));
      if (active?.fact.startsWith('permission:') && active.fact.endsWith(`:${event.requestId}`)) {
        this.resolveRecord(active, 'answered');
      }
    } catch (error) {
      this.onError('attention could not apply an answered approval', error);
    }
  }

  /**
   * A presence change for this owner: records whose target a focused window
   * now shows are seen (questions excepted, see the header). `targets` are
   * what the window that changed shows (panePresence.ts), the only targets
   * that can have come into view; without them every record of the owner is
   * checked.
   */
  presenceChanged(ownerUserId: string, targets?: readonly PaneTarget[]): void {
    if (this.stopped) return;
    try {
      for (const record of this.recordsShowing(targets)) {
        if (record.ownerUserId !== ownerUserId || !seenWhenShown(record)) continue;
        if (this.shownNow(record)) this.resolveRecord(record, 'seen');
      }
    } catch (error) {
      this.onError('attention could not apply a presence change', error);
    }
  }

  /**
   * One workspace_structure_changed frame (structureEvents.ts, subscribed in
   * server.ts): the active records of every workspace a trash, archive, move
   * or purge touched are checked against their targets again, and the
   * records of purged targets are deleted. A resync frame checks them all.
   */
  structureChanged(event: WorkspaceStructureChangedEvent): void {
    if (this.stopped) return;
    try {
      const touched = new Set<string>();
      const purgedIn = new Set<string>();
      for (const change of event.changes) {
        if (!REVALIDATING_OPS.has(change.op)) continue;
        touched.add(change.workspaceId);
        if (change.fromWorkspaceId) touched.add(change.fromWorkspaceId);
        // A deleted tree takes its nodes with it (nodes.tree_id cascades).
        if (change.op === 'purged' || (change.op === 'deleted' && change.entity === 'tree')) purgedIn.add(change.workspaceId);
      }
      if (!event.resync && touched.size === 0) return;
      for (const record of [...this.active.values()]) {
        if (!event.resync && !touched.has(record.target.workspaceId)) continue;
        try {
          this.revalidate(record);
        } catch (error) {
          this.onError('attention could not check a record against its target', error);
        }
      }
      if (event.resync) this.repository.deleteRecordsOfGoneTargets();
      else for (const workspaceId of purgedIn) this.repository.deleteRecordsOfGoneTargets(workspaceId);
    } catch (error) {
      this.onError('attention could not apply a structure change', error);
    }
  }

  // ── The desktop notifier ─────────────────────────────────────────────────

  /**
   * Where a decided record wakes the quit app (DESIGN-v2 §5.1: the macOS
   * background service runs the backend, and its launcher starts the app
   * hidden; Electron main then gets the record from its feed's snapshot);
   * null: never (the default, and every backend but the service's).
   */
  configureDesktopWake(config: { launcher: AppLauncher; graceMs?: number; setTimer?: (callback: () => void, delayMs: number) => () => void } | null): void {
    this.cancelWakeCheck?.();
    this.cancelWakeCheck = null;
    this.desktopWake = config ? {
      launcher: config.launcher,
      graceMs: config.graceMs ?? NOTIFIER_GRACE_MS,
      setTimer: config.setTimer ?? ((callback, delayMs) => {
        const handle = this.clock.setTimeout(callback, delayMs);
        return () => this.clock.clearTimeout(handle);
      }),
    } : null;
  }

  /** The level lets the record through to the desktop notifier (attentionLevelAllows); a level that cannot be read counts as `all`. */
  desktopAccepts(record: Pick<AttentionNotificationV1, 'kind' | 'reason'>): boolean {
    let level: AttentionLevel = 'all';
    try {
      level = this.level();
    } catch {
      level = 'all';
    }
    return attentionLevelAllows(level, record.kind, record.reason);
  }

  /** POST /attention/desktop/notifications/:id/claim: Electron main shows the record; null when it is not this owner's. */
  claimForDesktop(ownerUserId: string, id: string): AttentionClaimResultV1 | null {
    return this.claim(ownerUserId, id, DESKTOP_NOTIFIER_WINDOW_ID);
  }

  /**
   * A record went out: when no desktop notifier has been connected for the
   * grace and the level lets it through, the app is woken. Within the grace
   * the notifier may only be reconnecting (a backoff, a backend restart, the
   * first moments after boot): one look again when the grace is up wakes it
   * if a record decided since is still active and unclaimed then.
   */
  private wakeDesktopFor(record: StoredAttention): void {
    const wake = this.desktopWake;
    if (!wake || !this.desktopAccepts(record)) return;
    const absentFor = this.feed.desktopAbsentForMs();
    if (absentFor === 0) return;
    if (absentFor >= wake.graceMs) {
      this.launch(wake.launcher);
      return;
    }
    this.lookAgainForWake(wake, wake.graceMs - absentFor, record.createdAt);
  }

  private lookAgainForWake(wake: NonNullable<AttentionService['desktopWake']>, delayMs: number, since: number): void {
    if (this.cancelWakeCheck) return;
    this.wakeCheckSince = since;
    this.cancelWakeCheck = wake.setTimer(() => {
      this.cancelWakeCheck = null;
      if (this.desktopWake !== wake || this.stopped) return;
      const absentFor = this.feed.desktopAbsentForMs();
      if (absentFor === 0) return;
      // A notifier came and went meanwhile: its grace starts over.
      if (absentFor < wake.graceMs) {
        this.lookAgainForWake(wake, wake.graceMs - absentFor, this.wakeCheckSince);
        return;
      }
      // Read from the store: claims through the routes write only there.
      let waiting = false;
      try {
        waiting = this.repository.listAllActive().some((record) => record.createdAt >= this.wakeCheckSince
          && record.claimedByWindowId === null && this.desktopAccepts(record));
      } catch (error) {
        this.onError('attention could not look for a record to wake the app for', error);
      }
      if (waiting) this.launch(wake.launcher);
    }, Math.max(1, delayMs));
  }

  private launch(launcher: AppLauncher): void {
    try {
      launcher.wake();
    } catch (error) {
      this.onError('attention could not wake the app', error);
    }
  }

  // ── Delivery ─────────────────────────────────────────────────────────────

  snapshot(ownerUserId: string): AttentionNotificationV1[] {
    return this.repository.listActive(ownerUserId).map(toAttentionNotification);
  }

  /** POST /attention/notifications/:id/claim; null when the record is not this owner's. */
  claim(ownerUserId: string, id: string, windowId: string): AttentionClaimResultV1 | null {
    return this.repository.claim(ownerUserId, id, windowId, this.clock.now());
  }

  /** Expires old active records and deletes long-inactive ones. */
  sweep(): void {
    try {
      const now = this.clock.now();
      for (const record of this.repository.expireCreatedBefore(now - this.maxAgeMs, now)) {
        if (this.active.get(record.key)?.id === record.id) this.active.delete(record.key);
        this.feed.publishResolved(record.ownerUserId, toAttentionResolved(record));
      }
      this.repository.pruneInactiveBefore(now - this.retentionMs);
    } catch (error) {
      this.onError('attention sweep failed', error);
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * After a restart, questions and approvals cannot be answered any more (their
   * turns were interrupted), completions may have been seen, and targets may
   * have been trashed, archived, moved or purged. What is still true stays
   * active.
   */
  private reconcile(): void {
    this.repository.deleteRecordsOfGoneTargets();
    for (const record of this.repository.listAllActive()) {
      // Known as active first: a record whose check fails here is resolved by a later event.
      this.active.set(record.key, record);
      try {
        if (record.kind === 'needs_input') this.resolveRecord(record, 'stale');
        else this.revalidate(record);
      } catch (error) {
        this.onError('attention could not reconcile a record', error);
      }
    }
  }

  /**
   * Checks an active record against its target as it is now: a purged target
   * takes its records with it, a trashed or archived one (or another owner's)
   * leaves it stale, a seen completion is seen, and a move to another
   * workspace carries it along.
   */
  private revalidate(record: StoredAttention): void {
    // A Run's, a scheduled run's and Michi's own records live as long as their workspace.
    if (record.target.type !== 'node') {
      const state = this.repository.workspaceState(record.target.workspaceId);
      if (state === 'gone') this.forgetTarget(record);
      else if (state === 'hidden') this.resolveRecord(record, 'stale');
      return;
    }
    const facts = this.repository.nodeFacts(record.target.nodeId);
    if (!facts) {
      this.forgetTarget(record);
      return;
    }
    if (facts.hidden || facts.ownerUserId !== record.ownerUserId) {
      this.resolveRecord(record, 'stale');
      return;
    }
    const seq = completionSeqOf(record.fact);
    if (seq !== null && facts.seenCompletionSeq >= seq) {
      this.resolveRecord(record, 'seen');
      return;
    }
    if (facts.workspaceId !== record.target.workspaceId) this.followTarget(record, facts.workspaceId);
  }

  /** The target is gone: windows drop the record, and no row of the target stays. */
  private forgetTarget(record: StoredAttention): void {
    this.resolveRecord(record, 'stale');
    this.repository.deleteTargetRecords(record.target);
  }

  /** The target moved to another workspace of its owner: its records follow it. */
  private followTarget(record: StoredAttention, workspaceId: string): void {
    this.repository.moveTargetRecords(record.target, workspaceId);
    if (this.active.get(record.key)?.id === record.id) {
      this.active.set(record.key, { ...record, target: { ...record.target, workspaceId } });
    }
  }

  /** The active records these panes show (all, without a list). */
  private recordsShowing(targets: readonly PaneTarget[] | undefined): StoredAttention[] {
    if (!targets) return [...this.active.values()];
    const shown = new Set(targets.map(paneTargetId).filter((id): id is string => id !== null));
    return [...this.active.values()].filter((record) => {
      const pane = paneTargetOf(record.target);
      const id = pane ? paneTargetId(pane) : null;
      return id !== null && shown.has(id);
    });
  }

  /**
   * The user has the record's target in front of them now: a focused window
   * shows its pane, or (an update in the agent's own conversation) the
   * agent's panel has focus.
   */
  private shownNow(record: Pick<StoredAttention, 'ownerUserId' | 'target'>): boolean {
    const pane = paneTargetOf(record.target);
    if (pane) return this.presence.isTargetVisibleInFocusedWindow(record.ownerUserId, pane);
    if (record.target.type !== 'agent' || record.target.open.kind !== 'companion' || record.target.open.tab !== 'chat') return false;
    try {
      return this.agentPanelFocused?.() ?? false;
    } catch {
      return false;
    }
  }

  /** A thread message's turn began: remember the sender's turn that was running then, if any. */
  private noteThreadMessage(nodeId: string, turnId: string, metadata: DurableMessageMetadata | undefined): void {
    const source = parseThreadMessageSource(metadata?.threadMessage);
    // A reply to a wake is the sender's own continuation, not a message anyone waits on; nor is a
    // message a thread got from itself (a multi-model synthesis or addendum names its caller).
    if (!source || source.kind === 'reply' || source.fromNodeId === nodeId) return;
    const senderTurnId = this.runningTurns.get(source.fromNodeId);
    if (senderTurnId) remember(this.messageSenders, turnId, { nodeId: source.fromNodeId, turnId: senderTurnId });
  }

  /** The turn answered a thread message whose sending turn is still running: the sender receives the reply. */
  private senderAwaitsReply(turnId: string): boolean {
    const sender = this.messageSenders.get(turnId);
    if (!sender) return false;
    this.messageSenders.delete(turnId);
    return this.runningTurns.get(sender.nodeId) === sender.turnId;
  }

  private turnEnded(nodeId: string, turnId: string): void {
    if (this.runningTurns.get(nodeId) === turnId) this.runningTurns.delete(nodeId);
  }

  /**
   * The turn's completion hands the task on within a send_to_thread exchange:
   * it asked for a wake still open, it answers a message sent with wake, or
   * it is a woken reply in a chain a Scheduled Job's turn began (the
   * scheduler reports its runs). The sender waiting in its turn is read
   * when the turn ends (senderAwaitsReply).
   */
  private isExchangeHandOff(nodeId: string, turnId: string): boolean {
    if (this.wakes.registeredOpenWake(nodeId, turnId) || this.wakes.answersWake(turnId)) return true;
    const origin = this.wakes.chainOrigin(turnId);
    return origin !== null && this.isScheduledTurn(origin);
  }

  private openInteraction(turnId: string, fact: string): void {
    let facts = this.openInteractions.get(turnId);
    if (!facts) {
      facts = new Set();
      this.openInteractions.set(turnId, facts);
    }
    facts.add(fact);
  }

  private isOpen(turnId: string, fact: string): boolean {
    return this.openInteractions.get(turnId)?.has(fact) ?? false;
  }

  private answerInteraction(nodeId: string, turnId: string, fact: string): void {
    const facts = this.openInteractions.get(turnId);
    facts?.delete(fact);
    if (facts && facts.size === 0) this.openInteractions.delete(turnId);
    const active = this.active.get(nodeKey(nodeId));
    if (active?.fact === fact) this.resolveRecord(active, 'answered');
  }

  /** The turn ended: whatever it still waited for can no longer be answered. */
  private endInteractions(nodeId: string, turnId: string): void {
    const facts = this.openInteractions.get(turnId);
    this.openInteractions.delete(turnId);
    if (!facts) return;
    const active = this.active.get(nodeKey(nodeId));
    if (active && facts.has(active.fact)) this.resolveRecord(active, 'stale');
  }

  private proposeNodeFact(nodeId: string, turnId: string, describe: (facts: NodeAttentionFacts) => NodeFactSpec | null): void {
    const key = nodeKey(nodeId);
    this.propose({
      key,
      settle: () => {},
      build: () => {
        const facts = this.repository.nodeFacts(nodeId);
        if (!facts || facts.hidden) return null;
        const latest = this.latestTurn.get(nodeId);
        if (latest !== undefined && latest !== turnId) return null;
        if (this.isScheduledTurn(turnId)) return null;
        const spec = describe(facts);
        if (!spec) return null;
        return {
          ownerUserId: facts.ownerUserId,
          key,
          ...spec,
          target: { type: 'node', nodeId, workspaceId: facts.workspaceId },
          createdAt: this.clock.now(),
        };
      },
    });
  }

  private isScheduledTurn(turnId: string): boolean {
    const known = this.scheduledTurns.get(turnId);
    if (known !== undefined) return known;
    const scheduled = this.repository.turnIsScheduled(turnId);
    remember(this.scheduledTurns, turnId, scheduled);
    return scheduled;
  }

  /** The key's pending decision, if any, is dropped undecided. */
  private dropPending(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    this.clock.clearTimeout(entry.timer);
    entry.candidate.settle();
  }

  /** A newer candidate for a key replaces the pending one: only the latest fact is decided. */
  private propose(candidate: Candidate): void {
    const previous = this.pending.get(candidate.key);
    if (previous) {
      this.pending.delete(candidate.key);
      this.clock.clearTimeout(previous.timer);
      previous.candidate.settle();
    }
    const entry: PendingDecision = { candidate, timer: null };
    this.pending.set(candidate.key, entry);
    if (this.stopped) {
      this.decide(entry);
      return;
    }
    entry.timer = this.clock.setTimeout(() => this.decide(entry), this.decisionDelayMs);
  }

  private decide(entry: PendingDecision): void {
    const { candidate } = entry;
    if (this.pending.get(candidate.key) !== entry) return;
    this.pending.delete(candidate.key);
    try {
      const record = candidate.build();
      if (!record) return;
      if (seenWhenShown(record) && this.shownNow(record)) {
        // The user is looking at it: nothing to call them to, including an older record.
        const active = this.active.get(record.key);
        if (active && seenWhenShown(active)) this.resolveRecord(active, 'seen');
        return;
      }
      const result = this.repository.insertReplacing(record);
      if (!result) return;
      this.active.set(record.key, result.created);
      if (result.superseded) this.feed.publishResolved(record.ownerUserId, toAttentionResolved(result.superseded));
      this.feed.publishNotification(record.ownerUserId, toAttentionNotification(result.created));
      this.wakeDesktopFor(result.created);
    } catch (error) {
      this.onError('attention could not decide a notification', error);
    } finally {
      candidate.settle();
    }
  }

  /** The store first: if the write fails, the record stays known as active, so a later resolution retries it. */
  private resolveRecord(record: StoredAttention, reason: Exclude<AttentionResolveReason, 'expired'>): void {
    const resolved = this.repository.resolve(record.id, reason, this.clock.now());
    if (this.active.get(record.key)?.id === record.id) this.active.delete(record.key);
    if (resolved) this.feed.publishResolved(resolved.ownerUserId, toAttentionResolved(resolved));
  }
}
