import { randomUUID } from "node:crypto";
import {
  applyTurnEvent,
  CHAT_STREAM_EVENTS,
  createDurableTurn,
  extractBranchOverview,
  isActiveToolStatus,
  userInputInteractionId,
  normalizeUserInputQuestions,
  normalizeUserInputAnswers,
  threadMessageBody,
  COMPANION_CHECKIN_TURN_PREFIX,
  COMPANION_SEND_TURN_PREFIX,
  checkinRunId,
  companionCheckinTurnRunId,
  companionPostId,
  companionPostRunId,
  isCheckinNodeId,
  parseCompanionPostMetadata,
  extractTurnMetadata,
  finalizeTurnContent,
  TURN_ERROR_CODES,
  selfTurnAssistantId,
  userTurnAssistantId,
  type UserInputAnswer,
  type ChatStreamEvent,
  type SteerMessageOptions,
  type DurableMessageMetadata,
  type DurableTurnSnapshot,
} from "michi-shared";
import type { AgentSession, CompactResult, SteerResult, CancelAck, MaintenanceTurnContext, SkillTurnInvocation } from "./types";
import { getRuntime } from "./registry";
import type { NormalizedEvent } from "../services/chatEvents";
import { chatStreamErrorCode, createChatStreamError, toChatStreamEvent, withStreamErrorCode } from "../routes/chatStreamEvents";
import { decodeMichiHostEvent } from "./hostEvents";
import { beginTurn, checkpointTurn, finalizeTurn, getNode } from "../services/dbRepository";
import { BACKEND_RESTARTED_ERROR, BACKEND_RESTARTED_MESSAGE } from "../services/turnPersistence.recipes";
import { getDb } from "../services/db";
import { log as appLog } from "../services/logger";
import { ACPError } from "michi-runtime/internal/adapters/kiro/acpClient";
import { CANCEL_TIMEOUT_MS } from "../config/constants";
import { dbWorker, isDbWorkerReady } from "../services/dbWorkerClient";
import { RuntimeRecoveryRequiredError } from './runtimeLifecycle';
import { buildPageManifest } from '../services/pages/pageManifest';
import { assistantPurposeOf, isAssistantNode } from '../assistant/identity';
import { assistantCwd } from '../assistant/store';
import { prepareAssistantAttachments } from '../assistant/attachments';
import { ReportedRuntimeError } from 'michi-runtime/internal/contract/errors';
import { descriptorOf } from "michi-runtime/internal/core/descriptors";
import { discardBackgroundTurn } from "michi-runtime/internal/core/backgroundTurns";
import { chatNodeOf, isRunOwner } from './ownerMapping';
import { observeTurnTrust, recordUntrustedSource, type RecordSourceOptions, type TrustSource, type TurnRef } from '../services/turnTrust';
import { recordTypedText, releaseTypedText } from '../services/memory/typedText';
import { coreBeginAndFinalizeTurn } from '../services/turnPersistence.core';
import { mainThreadDb } from '../services/turnPersistence.mainAdapter';
import { memoryInjector as defaultMemoryInjector, type MemoryInjector, type PreparedMemoryContext } from './memoryInjection';

export interface HubSubscriber {
  send(ev: ChatStreamEvent): void;
  close(): void;
}

/** Window-scoped feed; internal consumers remain self-turn-only by default. */
export interface BackgroundSubscriber {
  send(chatId: string, ev: ChatStreamEvent, selfInitiated?: boolean): void;
  includeForeground?: boolean;
  gap?(chatId: string, durableCursor: BackgroundCursor): void;
  close(): void;
  /** Undefined in desktop mode; fixed authenticated owner in cloud mode. */
  ownerUserId?: string | null;
}

export interface BackgroundCursor {
  turnId: string;
  seq: number;
}

export interface BackgroundSubscribeOptions {
  cursors?: Readonly<Record<string, BackgroundCursor>>;
  /** Latest owner-scoped SQLite cursor, used to distinguish idle from a gap. */
  durableCursors?: Readonly<Record<string, BackgroundCursor>>;
}

interface LoggedEvent {
  seq: number;
  ev: ChatStreamEvent;
}

interface TurnLog {
  chatId: string;
  turnId: string;
  assistantId: string;
  nodeId: string;
  wireText: string;
  events: LoggedEvent[];
  status: "active" | "ended" | "error";
  nextSeq: number;
  snapshot: DurableTurnSnapshot;
  lastCheckpointAt: number;
  checkpointCount: number;
  selfInitiated: boolean;
  ownerUserId: string | null;
  /** See StartTurnArgs.humanOrigin. */
  humanOrigin?: boolean;
  /** The runtime the turn ran on, for TurnFinalizedEvent. */
  runtimeId?: string | null;
  /** onTurnFinalized listeners have been told about this turn. */
  finalizedNotified?: boolean;
  /** See StartTurnArgs.skill. */
  skill?: SkillTurnInvocation;
  /** See AgentTurnInput.titleSource. */
  titleSource?: { text: string; context?: string };
  /** Stops the runtime turn behind a self-turn (see StartSelfTurnArgs.cancel). */
  selfCancel?: () => Promise<CancelAck | void> | CancelAck | void;
  /** Permission handles remain transient. Keep unresolved interaction handles
   * so gap recovery can restore actionable UI alongside the durable transcript. */
  pendingPermission?: ChatStreamEvent;
  pendingUserInput?: ChatStreamEvent;
  /** Commit accepted input before done/error so queue flushing cannot resend it. */
  pendingSteers?: Set<Promise<unknown>>;
  /** Runtime completion and the cancel timeout share one durability boundary. */
  finalization?: Promise<void>;
  /**
   * done or error holds its seq while finalize commits, and goes out only
   * after it: append() drops anything later, so no event overtakes it.
   */
  terminalStamped?: boolean;
  /**
   * Set only inside the existing finishWithPersistenceError path, beside its
   * pre-existing effects (log.status = "error", the live broadcast event).
   * This is IN-MEMORY ONLY and does not survive a process restart — nothing
   * here is written to SQLite. After a restart this process never sees the
   * turn again (getSnapshot returns null for it), so a caller must fall back
   * to the database and report commitState=unknown rather than trusting a
   * stale in-memory conclusion. Do not treat the absence of this field after
   * a restart as proof the commit succeeded.
   */
  lastPersistenceError?: { message: string; recoverable: boolean; occurredAt: number };
  /**
   * DESIGN-v2 §3.2: no subscriber of any kind sees this turn, live or in a
   * replay, and getSnapshot does not report it: a Companion check-in in its
   * throwaway node, which no window may discover (a window installs any node
   * a frame names). Set by StartRequestedSelfTurnArgs.private and for every
   * turn of a check-in node.
   */
  private?: boolean;
  /** whenTurnSettled callers waiting for this turn to leave `active`. */
  settleWaiters?: Array<() => void>;
}

/** A node's completion facts (migration 0064), as a turn's `done` frame carries them. */
export interface NodeCompletionFacts {
  nodeCompletionSeq: number;
  nodeSeenCompletionSeq: number;
}

export interface TurnPersistence {
  begin(snapshot: DurableTurnSnapshot): void | Promise<void>;
  checkpoint(snapshot: DurableTurnSnapshot): void;
  finalize(snapshot: DurableTurnSnapshot): void | Promise<void>;
  /**
   * The node's completion facts as committed, read once its turn finalized.
   * `done` carries them so a window counts exactly what the server counted;
   * without this (a test harness) the frame carries none.
   */
  completionFacts?(nodeId: string): NodeCompletionFacts | null;
  /**
   * Writes a turn that is already terminal (a posted message) as begin and
   * finalize in ONE transaction (turnPersistence.core coreBeginAndFinalizeTurn).
   * `existing`: the turn, or its message, was already there and nothing was
   * written. Optional so test harnesses that never post need not provide it;
   * postSelfMessage refuses to run without it.
   */
  beginAndFinalize?(snapshot: DurableTurnSnapshot): PostSelfMessageResult | Promise<PostSelfMessageResult>;
}

const repositoryTurnPersistence: TurnPersistence = {
  begin: (snapshot) => {
    if (isDbWorkerReady()) {
      return dbWorker.beginTurn(snapshot).then(() => {});
    }
    beginTurn(snapshot);
  },
  checkpoint: (snapshot) => {
    // Defer the write so the current tick can finish broadcasting SSE events.
    // When the worker is ready, the write happens off-thread entirely.
    // Checkpoints are idempotent and non-critical — if one is skipped due to
    // process exit, finalize will persist the canonical terminal state.
    if (isDbWorkerReady()) {
      // Fire-and-forget: the worker handles the write off-thread.
      dbWorker.checkpointTurn(snapshot).catch((err) => {
        console.warn(`[turnPersistence] worker checkpoint failed for turn ${snapshot.turnId}:`, err);
      });
    } else {
      setImmediate(() => {
        try {
          checkpointTurn(snapshot);
        } catch (err) {
          console.warn(`[turnPersistence] deferred checkpoint failed for turn ${snapshot.turnId}:`, err);
        }
      });
    }
  },
  finalize: (snapshot) => {
    if (isDbWorkerReady()) {
      return dbWorker.finalizeTurn(snapshot).then(() => {});
    }
    finalizeTurn(snapshot);
  },
  // A read on this thread's connection sees what the worker committed.
  completionFacts: (nodeId) => {
    const node = getNode(nodeId);
    if (typeof node?.completion_seq !== 'number' || typeof node.seen_completion_seq !== 'number') return null;
    return { nodeCompletionSeq: node.completion_seq, nodeSeenCompletionSeq: node.seen_completion_seq };
  },
  // Always on the main thread's connection: the worker has no such call, and
  // a post waits for the conversation's previous turn to finalize first (its
  // late checkpoints then find that turn terminal and write nothing).
  beginAndFinalize: (snapshot) => coreBeginAndFinalizeTurn(mainThreadDb, snapshot).posted ? 'posted' : 'existing',
};

export interface StartTurnArgs {
  chatId: string;
  nodeId: string;
  text: string;
  displayText?: string;
  enableKiroSidecarTitle?: boolean;
  userMetadata?: DurableMessageMetadata;
  session: AgentSession;
  turnId?: string;
  ownerUserId?: string | null;
  /** The text came from a person (the composer route), not from an agent. */
  humanOrigin?: boolean;
  /** The skill this message runs, resolved by the route; the runtime receives it as AgentTurnInput.skill. */
  skill?: SkillTurnInvocation;
}

export interface SidecarTitleRequest {
  session: AgentSession;
  nodeId: string;
  /** The user's message as displayed, without mention expansion or attachments. */
  userText: string;
  /** Quoted/selected text the user is replying to, giving the title its subject. */
  contextText?: string;
}

/**
 * Produces a sidebar title while the main turn is still running. Resolves
 * `null` when the runtime has no cheap title path; the hub then relies on
 * the agent's own title sentinel.
 */
export type SidecarTitleGenerator = (request: SidecarTitleRequest) => Promise<string | null>;

const runtimeSidecarTitleGenerator: SidecarTitleGenerator = async ({ session, userText, contextText }) => {
  const runtime = getRuntime(session.runtimeId);
  if (!runtime?.generateTitle) return null;
  return runtime.generateTitle({ userText, contextText });
};

export interface StartedTurn {
  turnId: string;
  assistantId: string;
  done: Promise<void>;
}

/**
 * Read-only observation of a chat's most relevant turn, keyed by nodeId.
 * This is a LOCAL type owned by this task (P1-5) — the shared pane-inspection
 * DTO mapping happens elsewhere (P1-2), which maps this shape onto its own
 * contract rather than this file importing one.
 *
 * `inMemoryStatus` and `durableStatus` are DIFFERENT enums with DIFFERENT
 * meanings (see TurnLog.status vs DurableTurnSnapshot.status) — conflating
 * them is exactly how a failed commit gets reported as a success.
 * `inMemoryStatus` is this process's view of the TurnLog; `durableStatus` is
 * the last snapshot.status this process computed, which is NOT the same as
 * "committed to SQLite" — see lastPersistenceError and the restart note on
 * getSnapshot below.
 */
export interface ChatObservationSnapshot {
  chatId: string;
  nodeId: string;
  turnId: string;
  assistantId: string;
  /** TurnLog['status'] — this process's in-memory view of the turn. */
  inMemoryStatus: "active" | "ended" | "error";
  /** log.snapshot.status — the durable-shaped status as last computed by
   * applyTurnEvent in this process. NOT proof of a committed SQLite row;
   * see lastPersistenceError and the restart-honesty note on getSnapshot. */
  durableStatus: DurableTurnSnapshot["status"];
  stopReason?: string;
  error?: string;
  /** Structurally-copied DurableTurnSnapshot — safe for the caller to hold
   * and mutate without affecting ChatHub's own state. */
  snapshot: DurableTurnSnapshot;
  /** Last ASSIGNED seq for this turn (log.nextSeq - 1), in the same shape as
   * BackgroundCursor so a snapshot-then-subscribe handoff can use it as the
   * native watermark without inventing a second cursor shape. -1 when no
   * event has been assigned a seq yet. */
  cursor: { turnId: string; seq: number };
  startedAt: number;
  completedAt?: number;
  /** True when a permission or user-input card is currently unresolved.
   * Only a boolean + a human-readable reason are exposed — never the raw
   * ChatStreamEvent, which may carry permission options / executable
   * actions (design §10 forbids those from reaching an observer). */
  pendingInteraction: { waiting: false } | { waiting: true; reason: string };
  /** Wall-clock time cancel() was invoked for this turn, or null if no
   * cancellation has been requested. Cleared once the turn ends (naturally
   * or via force-finish) or is evicted before it started. */
  cancelRequestedAt: number | null;
  /** Set only by the existing finishWithPersistenceError path. IN-MEMORY
   * ONLY — see the doc-comment on TurnLog.lastPersistenceError. null does
   * NOT mean "committed successfully"; it only means this process never
   * recorded a persistence failure for this turn (which is also true for a
   * turn this process never saw at all, e.g. after a restart). */
  lastPersistenceError: { message: string; recoverable: boolean; occurredAt: number } | null;
  selfInitiated: boolean;
}

export interface StartSelfTurnArgs {
  chatId: string;
  nodeId: string;
  /**
   * Stops the runtime's own turn when the user presses Stop and no session
   * is attached (see session). Without either, Stop only force-finishes the
   * turn in Michi after the cancel timeout.
   */
  cancel?: () => Promise<CancelAck | void> | CancelAck | void;
  ownerUserId?: string | null;
  events: AsyncIterableIterator<NormalizedEvent>;
  /** The manager attaches the native owner so Stop also interrupts work
   * initiated while the runtime was idle. */
  session?: AgentSession;
}

export interface StartRequestedSelfTurnArgs {
  chatId: string;
  nodeId: string;
  ownerUserId?: string | null;
  turnId: string;
  text: string;
  session: AgentSession;
  /** When non-empty, the turn keeps a visible, persisted user message with
   * this text (cross-thread messages). Keep it equivalent to `text` so
   * history reconstruction matches what the runtime received. Retries with
   * the same turnId must pass the same value. */
  displayText?: string;
  userMetadata?: DurableMessageMetadata;
  /** Trusted, server-created maintenance plan bindings for an isolated scheduled session. */
  maintenanceContext?: MaintenanceTurnContext;
  /**
   * Asked once, when the turn's place in the chat's queue comes up, before
   * anything is saved: false withdraws it (the start rejects and nothing is
   * shown or sent). Not asked for a turn that already began.
   */
  shouldStart?: () => boolean;
  /**
   * DESIGN-v2 §3.2: no window ever sees the turn (TurnLog.private): it is
   * broadcast to nobody and left out of every replay. A Companion check-in
   * (W2-G1a) passes it; every turn of a check-in node is private anyway.
   */
  private?: true;
  /**
   * The turn's Michi Memory block as the caller built it, sent as it is
   * without asking the memory injector: a Companion check-in's resident pack
   * (contextBuilder consumer 'checkin', built as it starts); null for none.
   * Omitted: the injector's, as for any turn.
   */
  memoryContext?: string | null;
}

export interface StartedRequestedSelfTurn extends StartedTurn {
  existing: boolean;
}

/** A Stop for one turn (ChatHub.cancel): the running turn, or one that has not started. */
export interface CancelRequest {
  chatId: string;
  turnId: string;
}

/** A message a person steered into a turn (ChatHub.steer); always typed by a person. */
export interface FinalizedTurnSteer {
  messageId: string;
  text: string;
  quotedText: string | null;
  createdAt: number;
}

/**
 * A turn reached its terminal state (ChatHub.onTurnFinalized): after its
 * done or error frame was committed and broadcast, or after its terminal
 * commit failed (persisted false; the turn's begin rows, and so the user's
 * message, were committed before the runtime saw it).
 */
export interface TurnFinalizedEvent {
  chatId: string;
  nodeId: string;
  turnId: string;
  workspaceId: string;
  /** As the route or server caller gave it; null on the desktop. */
  ownerUserId: string | null;
  /** A person typed userText in the composer (StartTurnArgs.humanOrigin). */
  humanOrigin: boolean;
  selfInitiated: boolean;
  /** The user message as displayed: '' when the turn has none. */
  userText: string;
  userMessageId: string | null;
  userMessageAt: number | null;
  /** Text the user selected and replied to. */
  quotedText: string | null;
  steers: FinalizedTurnSteer[];
  /** The visible reply. */
  assistantText: string;
  /** 'ended' after a committed done; 'error' after an error or a failed commit. */
  status: 'ended' | 'error';
  /** The durable outcome; 'error' when the terminal commit failed. */
  outcome: DurableTurnSnapshot['status'];
  /** False when the terminal commit failed. */
  persisted: boolean;
  runtimeId: string | null;
  completedAt: number;
}

/**
 * A message Michi posts into a conversation as a turn of its own, complete
 * before anyone sees it (DESIGN-v2 §3.3): a check-in's post (W2-G1a
 * services/companion/posts.ts) or first-run narration. It has no user
 * message and no runtime session.
 */
export interface PostSelfMessageArgs {
  /** The conversation: an assistant conversation that is not a check-in node (`main`). */
  chatId: string;
  nodeId: string;
  /**
   * The turn's id, which makes the post idempotent. A check-in's post is
   * `cmp-post-<runId>` (companionPostId) for turn and message alike; never a
   * check-in's own turn id (`cmp-<runId>`) nor a follow-up's (`cms-<runId>`).
   */
  turnId: string;
  /** The assistant message's id; defaults to turnId (first-run narration passes its `mna-*` id). */
  messageId?: string;
  /**
   * The message's text; FOLLOW-UP sentinels in it become the conversation's
   * chips (sent as a follow_ups frame). TITLE and BRANCH-OVERVIEW sentinels
   * are removed before anything is sent or stored (postVisibleText).
   */
  text: string;
  /**
   * The assistant message's stored metadata. `companionPost` (validated with
   * parseCompanionPostMetadata, stored as parsed) requires both ids to be
   * the post id of its run, and a post id requires it; any other field (such
   * as first-run narration's `metaAgentNarration`) is stored as given. Only
   * `companionPost` travels on the live turn_start (assistantMetadata).
   */
  metadata?: DurableMessageMetadata & Record<string, unknown>;
  /** The conversation's chips after the post, overriding any in the text. */
  followUps?: string[];
  /**
   * Recorded as the turn's untrusted source before it is written (turn_trust,
   * so memory extraction never follows it). A post defaults to
   * `{tool:'companion_post', detail:'checkin'}`; `runtimeId` defaults to 'michi'.
   * Never carried to the conversation's later turns (w4-fix D25).
   */
  untrusted?: { tool: string; detail?: string; runtimeId?: string };
  ownerUserId?: string | null;
  /**
   * Asked once, when the post's place in the conversation's queue comes up,
   * right before anything is written: false withdraws it (`withdrawn`). A
   * check-in's post goes out only while what its memory pack showed holds.
   */
  shouldPost?: () => boolean;
}

/**
 * `existing`: the turn (or its message) was already there; `withdrawn`:
 * shouldPost said no. Nothing was written or broadcast for either.
 */
export type PostSelfMessageResult = 'posted' | 'existing' | 'withdrawn';

/** A post that passed postSelfMessage's checks: what it stores and records. */
interface PreparedPost {
  messageId: string;
  metadata: DurableMessageMetadata | undefined;
  untrusted: PostSelfMessageArgs['untrusted'];
  /** The text every window is sent and the message stores (postVisibleText). */
  text: string;
  /** The chips after the post: PostSelfMessageArgs.followUps, else the text's own. */
  followUps: string[];
}

/**
 * A post's text as every window receives it and its message stores it: the
 * finalized content (finalizeTurnContent), taken again until no title,
 * branch-overview or follow-up sentinel is left that a window could read
 * from it. An open window's `done` reducer reads all three from the text it
 * streamed and saves the title and branch overview to the node, so the text
 * a post streams must carry none (its chips travel as a follow_ups frame).
 * One pass removes every bracketed sentinel; each further pass removes at
 * most a prose title line or what an earlier removal joined together, so the
 * bound is generous. null when the text still carries one: refuse the post.
 */
function postVisibleText(text: string): string | null {
  const bound = 4 + (text.match(/[[\n]/g)?.length ?? 0);
  let visible = text;
  for (let pass = 0; pass < bound; pass += 1) {
    const next = finalizeTurnContent(visible);
    const left = extractTurnMetadata(next);
    if (next === visible && !left.title && !left.branchOverview && !left.followUps) return visible;
    visible = next;
  }
  return null;
}

/** Assistant purposes that are closed: never a conversation a post lands in (§2.2; W2-E renames them to 'checkin'). */
const CLOSED_ASSISTANT_PURPOSES: ReadonlySet<string> = new Set(['companion', 'checkin']);

/** What whenTurnSettled reports: the turn's committed terminal status, or null when unknown. */
export type SettledTurnStatus = Exclude<DurableTurnSnapshot['status'], 'active'>;

/**
 * A turn chatHub refuses to start because of the node it is for or the id it
 * carries (DESIGN-v2 §2.5); nothing was written. `checkin_node`: a check-in
 * node runs only its own private check-in turn, and nothing is ever posted
 * into one; `reserved_turn_id`: the id is a check-in's (`cmp-`) or a
 * follow-up's (`cms-`) and this is not its node, or a user turn carries one;
 * `not_main_node`: only an assistant conversation that is neither a check-in
 * node nor recorded closed (meta purpose 'companion') takes posts;
 * `invalid_post`: the post's ids and its `companionPost` do not agree, or its
 * text is nothing but sentinels. W2-E's routes answer `checkin_node` with 409.
 */
export type TurnGuardCode = 'checkin_node' | 'reserved_turn_id' | 'not_main_node' | 'invalid_post';

export class TurnGuardError extends Error {
  constructor(readonly code: TurnGuardCode, message: string) {
    super(message);
    this.name = 'TurnGuardError';
  }
}

/** Turn-id prefixes only the backend's own Companion paths may use (a user turn never does). */
function hasReservedTurnPrefix(turnId: string): boolean {
  return turnId.startsWith(COMPANION_CHECKIN_TURN_PREFIX) || turnId.startsWith(COMPANION_SEND_TURN_PREFIX);
}

interface DurableTurnIdentity {
  turnId: string;
  nodeId: string;
  assistantId: string;
  status: "active" | "completed" | "cancelled" | "error";
}

export const ENDED_LOG_RETENTION_MS = 60_000;
export const TURN_CHECKPOINT_INTERVAL_MS = 1_500;

const STRUCTURAL_EVENTS = new Set<ChatStreamEvent['event']>([
  CHAT_STREAM_EVENTS.plan,
  CHAT_STREAM_EVENTS.toolCall,
  CHAT_STREAM_EVENTS.image,
  CHAT_STREAM_EVENTS.title,
  CHAT_STREAM_EVENTS.followUps,
  CHAT_STREAM_EVENTS.branchOverview,
  CHAT_STREAM_EVENTS.steerAccepted,
  CHAT_STREAM_EVENTS.userInputRequest,
  CHAT_STREAM_EVENTS.userInputResolved,
  CHAT_STREAM_EVENTS.usageSummary,
  CHAT_STREAM_EVENTS.warning,
]);

/** The runtime reported a non-empty branch overview (set_branch_overview), so the turn need not derive one. */
function reportsBranchOverview(ev: NormalizedEvent): boolean {
  if (ev.kind !== "host_event" || ev.type !== "branch_overview") return false;
  const product = decodeMichiHostEvent(ev);
  return product?.type === "branch_overview" && product.payload.overview.trim().length > 0;
}

/** The user's message as shown and the text it quotes, for titles; none for an empty message. */
function titleSourceOf(args: StartTurnArgs): { text: string; context?: string } | undefined {
  const text = (args.displayText ?? args.text).trim();
  if (!text) return undefined;
  const context = args.userMetadata?.quotedText?.trim();
  return context ? { text, context } : { text };
}

/** What a turn stops with on a runtime_error event; ReportedRuntimeError keeps its code. */
function runtimeEventError(ev: Extract<NormalizedEvent, { kind: "runtime_error" }>): Error {
  return ev.recoveryRequired ? new RuntimeRecoveryRequiredError(ev.error) : new ReportedRuntimeError(ev);
}

/**
 * The wire error codes a runtime_error code may set: the error kinds Michi's
 * UI shows a banner for. Other wire codes (turn_active, turn_persistence_failed
 * and the like) change what the client does, so a runtime's own code never
 * reaches them.
 */
const RUNTIME_ERROR_KINDS: ReadonlySet<string> = new Set(["connection", "auth", "generic"]);

export class ChatHub {
  private readonly turns = new Map<string, TurnLog>();
  /** Recently completed logs kept in order so reconnect can cross turn ids. */
  private readonly retainedTurns = new Map<string, TurnLog[]>();
  private readonly subscribers = new Map<string, Set<HubSubscriber>>();
  private readonly backgroundSubscribers = new Set<BackgroundSubscriber>();
  private readonly activeSessions = new Map<string, AgentSession>();
  private readonly activeTurnCompletions = new Map<string, Promise<void>>();
  private readonly selfTurnQueues = new Map<string, Promise<void>>();
  private readonly pendingSelfTurns = new Set<string>();
  private readonly requestedSelfTurnCompletions = new Map<string, Promise<void>>();
  /** Turn-scoped cancellation prevents a delayed Stop for turn A from
   * cancelling turn B on the same chat. Entries may also reserve a
   * client-minted turn id when cancel wins the race against POST /message. */
  private readonly cancelledTurnIds = new Set<string>();
  /** Parallel to cancelledTurnIds, recording when cancellation was requested
   * so a read-only observer can derive a "cancelling" activity state and
   * apply a cancel-timeout rule without a dedicated ChatHub state machine.
   * Written/cleared at every site that adds/removes from cancelledTurnIds —
   * never read by cancel()/finish*() themselves, so it cannot perturb the
   * existing cancellation behaviour. */
  private readonly cancelRequestedAt = new Map<string, number>();
  /** Force-finish timers keyed by chatId. Cleared when the turn ends naturally. */
  private readonly cancelTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly cancelListeners = new Set<(request: CancelRequest) => void>();
  private shuttingDown = false;
  private readonly retentionMs: number;
  private readonly persistence: TurnPersistence;
  private readonly checkpointIntervalMs: number;
  private readonly workspaceIdForNode: (nodeId: string) => string | null;
  private readonly lookupDurableTurn: (turnId: string) => DurableTurnIdentity | null;
  private readonly titleGenerator: SidecarTitleGenerator | null;
  private readonly nodeTitle: (nodeId: string) => string | null;
  private readonly pageManifestBuilder: typeof buildPageManifest;
  private readonly memoryInjector: Pick<MemoryInjector, 'prepare' | 'forget'> | null;
  private readonly turnFinalizedListeners = new Set<(turn: TurnFinalizedEvent) => void>();
  private readonly isAssistantNode: (nodeId: string) => boolean;
  private readonly assistantPurposeOf: (nodeId: string) => string;
  private readonly recordUntrusted: (ref: TurnRef, source: TrustSource, options?: RecordSourceOptions) => void;

  constructor(opts: {
    retentionMs?: number;
    persistence?: TurnPersistence;
    checkpointIntervalMs?: number;
    workspaceIdForNode?: (nodeId: string) => string | null;
    lookupDurableTurn?: (turnId: string) => DurableTurnIdentity | null;
    /** `null` disables sidecar title generation (tests, agent-run-only hubs). */
    titleGenerator?: SidecarTitleGenerator | null;
    nodeTitle?: (nodeId: string) => string | null;
    /** Injectable so focused turn tests can verify model-only context wiring. */
    pageManifestBuilder?: typeof buildPageManifest;
    /**
     * Michi Memory for the turns this hub sends (agents/memoryInjection).
     * `null` sends none; a hub built with injected persistence (a test
     * harness) sends none unless the test passes one.
     */
    memoryInjector?: Pick<MemoryInjector, 'prepare' | 'forget'> | null;
    /** Whether a node is an assistant conversation (assistant/identity); injectable for harness tests. */
    isAssistantNode?: (nodeId: string) => boolean;
    /** An assistant conversation's recorded purpose (assistant/identity); injectable for harness tests. */
    assistantPurposeOf?: (nodeId: string) => string;
    /** turnTrust.recordUntrustedSource; injectable for harness tests. */
    recordUntrustedSource?: (ref: TurnRef, source: TrustSource, options?: RecordSourceOptions) => void;
  } = {}) {
    this.isAssistantNode = opts.isAssistantNode ?? isAssistantNode;
    this.assistantPurposeOf = opts.assistantPurposeOf ?? assistantPurposeOf;
    this.recordUntrusted = opts.recordUntrustedSource ?? recordUntrustedSource;
    this.retentionMs = opts.retentionMs ?? ENDED_LOG_RETENTION_MS;
    this.persistence = opts.persistence ?? repositoryTurnPersistence;
    this.checkpointIntervalMs = opts.checkpointIntervalMs ?? TURN_CHECKPOINT_INTERVAL_MS;
    this.workspaceIdForNode = opts.workspaceIdForNode
      ?? ((nodeId) => getNode(nodeId)?.workspace_id ?? null);
    this.pageManifestBuilder = opts.pageManifestBuilder ?? buildPageManifest;
    this.memoryInjector = opts.memoryInjector === undefined
      ? (opts.persistence ? null : defaultMemoryInjector)
      : opts.memoryInjector;
    // A hub built with injected persistence is a test harness; it must not
    // reach into the runtime registry unless the test asks for it.
    this.titleGenerator = opts.titleGenerator === undefined
      ? (opts.persistence ? null : runtimeSidecarTitleGenerator)
      : opts.titleGenerator;
    this.nodeTitle = opts.nodeTitle ?? ((nodeId) => getNode(nodeId)?.title ?? null);
    this.lookupDurableTurn = opts.lookupDurableTurn ?? ((turnId) => {
      const row = getDb().prepare(`SELECT turn_id, node_id, assistant_message_id, status
        FROM turns WHERE turn_id = ?`).get(turnId) as {
          turn_id: string;
          node_id: string;
          assistant_message_id: string;
          status: DurableTurnIdentity['status'];
        } | undefined;
      return row ? {
        turnId: row.turn_id,
        nodeId: row.node_id,
        assistantId: row.assistant_message_id,
        status: row.status,
      } : null;
    });
  }

  /** Mark intentional teardown before disposing runtime sessions. Their exit
   * errors must retain the restart reason in the durable receipt. */
  prepareForShutdown(): void {
    this.shuttingDown = true;
  }

  /** prepareForShutdown has run: this process is going away. */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * Called for every Stop cancel() takes, with the turn it names: running,
   * or not yet started (a reserved cancellation). Explicit cancellation
   * only: a renderer disconnecting calls nothing. Listeners run
   * synchronously; one that throws is logged and skipped.
   */
  onCancel(listener: (request: CancelRequest) => void): () => void {
    this.cancelListeners.add(listener);
    return () => { this.cancelListeners.delete(listener); };
  }

  /**
   * Called once for every turn that reaches a terminal state: done
   * (completed or cancelled, including the cancel timeout's force-finish),
   * error, or a failed terminal commit (persisted false). Listeners run
   * synchronously after the terminal frame is broadcast; one that throws is
   * logged and skipped, never the turn's failure. A post (postSelfMessage)
   * ran nothing and is not reported.
   */
  onTurnFinalized(listener: (turn: TurnFinalizedEvent) => void): () => void {
    this.turnFinalizedListeners.add(listener);
    return () => { this.turnFinalizedListeners.delete(listener); };
  }

  private notifyTurnFinalized(chatId: string, log: TurnLog, persisted: boolean): void {
    if (log.finalizedNotified) return;
    log.finalizedNotified = true;
    releaseTypedText(log.nodeId, log.turnId);
    if (this.turnFinalizedListeners.size === 0) return;
    const { snapshot } = log;
    const user = snapshot.userMessage;
    const event: TurnFinalizedEvent = {
      chatId,
      nodeId: log.nodeId,
      turnId: log.turnId,
      workspaceId: snapshot.workspaceId,
      ownerUserId: log.ownerUserId,
      humanOrigin: log.humanOrigin === true,
      selfInitiated: log.selfInitiated,
      userText: user?.content ?? '',
      userMessageId: user?.id ?? null,
      userMessageAt: user?.createdAt ?? null,
      quotedText: user?.metadata?.quotedText ?? null,
      steers: (snapshot.steeredMessages ?? []).map((message) => ({
        messageId: message.id,
        text: message.content,
        quotedText: message.metadata?.quotedText ?? null,
        createdAt: message.createdAt,
      })),
      assistantText: snapshot.assistantMessage.content || this.rawAnswer(log),
      status: log.status === 'ended' ? 'ended' : 'error',
      outcome: persisted ? snapshot.status : 'error',
      persisted,
      runtimeId: log.runtimeId ?? null,
      completedAt: snapshot.completedAt ?? Date.now(),
    };
    for (const listener of this.turnFinalizedListeners) {
      try {
        listener(event);
      } catch (err) {
        appLog.warn('chat', 'turn finalized listener failed', { chatId, turnId: log.turnId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private notifyCancel(chatId: string, turnId: string): void {
    for (const listener of this.cancelListeners) {
      try {
        listener({ chatId, turnId });
      } catch (err) {
        appLog.warn('chat', 'cancel listener failed', { chatId, turnId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  isActive(chatId: string): boolean {
    return this.turns.get(chatId)?.status === "active";
  }

  isOwnerTurnActive(chatId: string): boolean {
    return this.activeSessions.has(chatId);
  }

  /** A backend-requested or runtime self-turn is queued or running for this
   * chat. startTurn rejects while this holds, so callers can report a busy
   * chat as `turn_active` instead of a begin failure. */
  hasPendingSelfTurn(chatId: string): boolean {
    return this.pendingSelfTurns.has(chatId);
  }

  /** A turn still holds this chat's session: it runs, or its runtime cleanup
   * has not ended. Releasing, reloading or replacing the session waits. */
  holdsSession(chatId: string): boolean {
    return this.isActive(chatId) || this.isOwnerTurnActive(chatId);
  }

  /** holdsSession, or a self-turn is queued or running: startTurn rejects. */
  isBusy(chatId: string): boolean {
    return this.holdsSession(chatId) || this.hasPendingSelfTurn(chatId);
  }

  activeOwnerTurnId(chatId: string): string | undefined {
    return this.activeSessions.has(chatId) ? this.turns.get(chatId)?.turnId : undefined;
  }

  activeDurableTurnIds(): ReadonlySet<string> {
    return new Set([...this.turns.values()]
      .filter((turn) => turn.status === 'active')
      .map((turn) => turn.turnId));
  }

  requestedTurnStatus(turnId: string): DurableTurnIdentity['status'] | null {
    return this.lookupDurableTurn(turnId)?.status ?? null;
  }

  resolveActiveInvocationAnchor(input: {
    runtimeSessionId: string | null;
    nodeId: string;
    ownerUserId: string;
    runtimeToolCallId: string | null;
  }): { turnId: string; messageId: string; toolCallId: string | null } | null {
    const candidates = [...new Set([input.runtimeSessionId, input.nodeId].filter((value): value is string => !!value))];
    for (const chatId of candidates) {
      const log = this.turns.get(chatId);
      if (!log || log.status !== 'active' || log.nodeId !== input.nodeId) continue;
      if (log.ownerUserId !== null && log.ownerUserId !== input.ownerUserId) continue;
      return {
        turnId: log.turnId,
        messageId: log.assistantId,
        toolCallId: input.runtimeToolCallId,
      };
    }
    return null;
  }

  /**
   * Read-only observation entry point. Does NOT stamp an event, touch
   * nextSeq, checkpoint, notify subscribers, or delete from any map — a
   * turn streaming concurrently is completely unaffected by this call.
   *
   * Lookup order (COMMON decision 1): this.turns.get(nodeId) first — verified
   * that routes/michi.ts:1417 starts foreground turns with
   * `chatId: nodeId, nodeId`, so chatId===nodeId in that path but is NOT a
   * type-enforced invariant elsewhere (resolveActiveInvocationAnchor above
   * treats them as separate candidates). Falls back to scanning
   * this.turns.values() for log.nodeId === nodeId, then this.retainedTurns,
   * preferring an active log over an ended one, and the most recently ended
   * one otherwise.
   *
   * Returns null when this ChatHub instance (this process) has no in-memory
   * knowledge of the node. null means exactly that — NOT "no turn ever
   * existed for this node". In particular, after a process restart every
   * turn this process previously knew about is gone (ChatHub has no
   * boot-time reconstruction), so getSnapshot correctly returns null for a
   * turn that may well have committed successfully to SQLite before the
   * restart. The caller is responsible for falling back to the database and
   * reporting commitState=unknown in that case — this method must not be
   * used to conclude a turn failed or never happened.
   */
  getSnapshot(nodeId: string): ChatObservationSnapshot | null {
    const direct = this.turns.get(nodeId);
    const log = direct && direct.nodeId === nodeId && !direct.private ? direct : this.findLogByNodeId(nodeId);
    if (!log) return null;
    return this.toObservationSnapshot(log);
  }

  /** Private turns (TurnLog.private) are never observed: a pane or tool cannot read a check-in through them. */
  private findLogByNodeId(nodeId: string): TurnLog | null {
    let bestActive: TurnLog | null = null;
    for (const candidate of this.turns.values()) {
      if (candidate.nodeId !== nodeId || candidate.private) continue;
      if (candidate.status === "active") return candidate;
      if (!bestActive) bestActive = candidate;
    }
    if (bestActive) return bestActive;
    let bestEnded: TurnLog | null = null;
    for (const candidates of this.retainedTurns.values()) {
      for (const candidate of candidates) {
        if (candidate.nodeId !== nodeId || candidate.private) continue;
        if (!bestEnded || candidate.snapshot.startedAt > bestEnded.snapshot.startedAt) {
          bestEnded = candidate;
        }
      }
    }
    return bestEnded;
  }

  private toObservationSnapshot(log: TurnLog): ChatObservationSnapshot {
    const pendingInteraction: ChatObservationSnapshot["pendingInteraction"] = log.pendingPermission
      ? { waiting: true, reason: this.permissionReason(log.pendingPermission) }
      : log.pendingUserInput
        ? { waiting: true, reason: this.userInputReason(log.pendingUserInput) }
        : { waiting: false };
    return {
      chatId: log.chatId,
      nodeId: log.nodeId,
      turnId: log.turnId,
      assistantId: log.assistantId,
      inMemoryStatus: log.status,
      durableStatus: log.snapshot.status,
      stopReason: log.snapshot.stopReason,
      error: log.snapshot.error,
      snapshot: structuredClone(log.snapshot),
      cursor: { turnId: log.turnId, seq: log.nextSeq - 1 },
      startedAt: log.snapshot.startedAt,
      completedAt: log.snapshot.completedAt,
      pendingInteraction,
      cancelRequestedAt: this.cancelRequestedAt.get(log.turnId) ?? null,
      lastPersistenceError: log.lastPersistenceError
        ? { ...log.lastPersistenceError }
        : null,
      selfInitiated: log.selfInitiated,
    };
  }

  private permissionReason(event: ChatStreamEvent): string {
    return event.event === CHAT_STREAM_EVENTS.permissionRequest && event.data.title
      ? event.data.title
      : "waiting for permission";
  }

  private userInputReason(event: ChatStreamEvent): string {
    if (event.event === CHAT_STREAM_EVENTS.userInputRequest) {
      const first = event.data.questions?.[0]?.question;
      if (first) return first;
    }
    return "waiting for user input";
  }

  async startTurn(args: StartTurnArgs): Promise<StartedTurn> {
    // DESIGN-v2 §2.5: a check-in node runs only its own private check-in
    // turn, and the Companion's turn ids are the backend's alone, so a
    // client-minted id can never pass for (or squat on) a post or a check-in.
    if (isCheckinNodeId(args.nodeId)) {
      throw new TurnGuardError('checkin_node', `check-in node ${args.nodeId} takes no ordinary turns`);
    }
    if (args.turnId !== undefined && hasReservedTurnPrefix(args.turnId)) {
      throw new TurnGuardError('reserved_turn_id', `turn id ${args.turnId} is reserved for Michi's own turns`);
    }
    if (this.isBusy(args.chatId)) {
      throw new Error('a turn is already active for this chat');
    }
    // Claim the chat before the first await: a self-turn that starts while
    // this turn persists its first rows must wait for it, not begin beside
    // it (the later log would replace this one and leave it unfinished).
    let settleStart!: (completion?: Promise<void>) => void;
    const starting = new Promise<void>((resolve) => { settleStart = (completion) => resolve(completion); });
    this.activeTurnCompletions.set(args.chatId, starting);
    // In the same step, let a turn the runtime started on its own (and has
    // not shown yet) give way, so it cannot begin showing behind this turn.
    const releaseClaim = args.session.claimTurn?.();
    try {
      const started = await this.beginTurn(args, (done) => settleStart(done.catch(() => {})));
      void started.done.then(() => releaseClaim?.(), () => releaseClaim?.());
      return started;
    } catch (error) {
      if (this.activeTurnCompletions.get(args.chatId) === starting) this.activeTurnCompletions.delete(args.chatId);
      settleStart();
      releaseClaim?.();
      throw error;
    }
  }

  private async beginTurn(args: StartTurnArgs, started: (done: Promise<void>) => void): Promise<StartedTurn> {
    const turnId = args.turnId ?? randomUUID();
    if (this.cancelledTurnIds.delete(turnId)) {
      this.cancelRequestedAt.delete(turnId);
      throw new Error(`turn ${turnId} was cancelled before it started`);
    }
    const assistantId = userTurnAssistantId(args.nodeId, turnId);
    const log = this.createLog({
      chatId: args.chatId,
      turnId,
      assistantId,
      nodeId: args.nodeId,
      wireText: args.text,
      displayText: args.displayText ?? args.text,
      userMetadata: args.userMetadata,
      selfInitiated: false,
      ownerUserId: args.ownerUserId ?? null,
    });
    if (args.humanOrigin) log.humanOrigin = true;
    log.runtimeId = args.session.runtimeId;
    if (args.skill) log.skill = args.skill;
    const titleSource = titleSourceOf(args);
    if (titleSource) log.titleSource = titleSource;
    // The durable provisional rows are the prerequisite for both runtime
    // execution and the visible turn_start frame.
    const persistStartedAt = Date.now();
    await this.persistence.begin(log.snapshot);
    logInfo('turn begin committed', log, {
      durationMs: Date.now() - persistStartedAt,
      runtimeId: args.session.runtimeId,
      nativeSessionId: args.session.nativeSessionId ?? args.session.id,
    });
    this.turns.set(args.chatId, log);
    this.activeSessions.set(args.chatId, args.session);
    // What a person typed backs the memory tools' writes in a turn that reads outside content (services/memory/typedText.ts).
    if (log.humanOrigin) recordTypedText(log.nodeId, turnId, log.snapshot.userMessage?.content ?? '');
    this.append(args.chatId, log, {
      event: CHAT_STREAM_EVENTS.turnStart,
      data: {
        turnId,
        assistantId,
        nodeId: args.nodeId,
        userText: args.displayText ?? args.text,
        ...(args.userMetadata ? { userMetadata: args.userMetadata } : {}),
        startedAt: log.snapshot.startedAt,
      },
    }, false);
    if (!this.cancelledTurnIds.has(turnId)) this.maybeGenerateTitle(args, log);
    const done = this.runTurn(args.chatId, log, args.session);
    this.activeTurnCompletions.set(args.chatId, done);
    started(done);
    void done.then(() => {
      if (this.activeTurnCompletions.get(args.chatId) === done) {
        this.activeTurnCompletions.delete(args.chatId);
      }
    }, () => {
      if (this.activeTurnCompletions.get(args.chatId) === done) {
        this.activeTurnCompletions.delete(args.chatId);
      }
    });
    return { turnId, assistantId, done };
  }

  subscribe(
    chatId: string,
    sub: HubSubscriber,
    opts: { fromTurnId?: string; fromSeq?: number } = {},
  ): () => void {
    const set = this.subscribersFor(chatId);
    set.add(sub);
    // Generic internal subscribers retain historical all-turn semantics.
    // Public foreground routes use subscribeTurn() below, which is strictly
    // foreground-only and pinned to a concrete turn id.
    const logs = this.replayableLogs(chatId).filter((log) => !log.private);
    if (logs.length > 0) {
      const matchingIndex = opts.fromTurnId
        ? logs.findIndex((log) => log.turnId === opts.fromTurnId)
        : -1;
      const startIndex = matchingIndex >= 0 ? matchingIndex : logs.length - 1;
      for (let index = startIndex; index < logs.length; index += 1) {
        const log = logs[index];
        const fromSeq = index === matchingIndex ? opts.fromSeq ?? 0 : 0;
        for (const { seq, ev } of log.events) {
          if (seq >= fromSeq) sub.send(ev);
        }
      }
    }
    return () => {
      set.delete(sub);
      if (set.size === 0) this.subscribers.delete(chatId);
    };
  }

  subscribeBackground(
    sub: BackgroundSubscriber,
    opts: BackgroundSubscribeOptions = {},
  ): () => void {
    const cursors = opts.cursors ?? {};
    const durableCursors = opts.durableCursors ?? {};
    const chatIds = new Set([
      ...this.retainedTurns.keys(),
      ...this.turns.keys(),
      ...Object.keys(cursors),
    ]);
    const gaps: Array<{ chatId: string; cursor: BackgroundCursor }> = [];
    const replayPlans: Array<{
      chatId: string;
      logs: TurnLog[];
      replayCursor?: BackgroundCursor;
      startIndex: number;
    }> = [];
    for (const chatId of chatIds) {
      // retainedTurns is append-only oldest→newest. Current is newer than a
      // retained predecessor; preserve that order so reconnect never sends a
      // prior turn after a later turn has advanced the reducer watermark.
      // Private turns (a check-in) are never replayed to anyone.
      const logs = this.replayableLogs(chatId).filter((log) => !log.private);
      const cursor = cursors[chatId];
      let replayCursor = cursor;
      let startIndex = 0;
      if (cursor) {
        const matchingIndex = logs.findIndex((log) => log.turnId === cursor.turnId);
        if (matchingIndex < 0) {
          const durable = durableCursors[chatId];
          const durableIsNotAhead = durable
            && durable.turnId === cursor.turnId
            && durable.seq <= cursor.seq;
          if (!durable || durableIsNotAhead) continue;
          gaps.push({ chatId, cursor: durable });

          // SQLite is authoritative through durable.seq. Continue with any
          // newer in-memory frames after the frontend has installed that
          // snapshot. If the durable turn itself has already left the ring,
          // there is no safe tail to replay.
          const durableIndex = logs.findIndex((log) => log.turnId === durable.turnId);
          if (durableIndex < 0) continue;
          startIndex = durableIndex;
          replayCursor = durable;
        } else {
          startIndex = matchingIndex;
        }
      }
      replayPlans.push({ chatId, logs, replayCursor, startIndex });
    }

    // Gap is a graph/state barrier, not merely another chat event. Emit every
    // barrier before any ordinary replay frame so a newly discovered child is
    // installed by the frontend before that child's turn/interaction frames
    // can arrive. This also makes cross-chat replay independent of Map
    // insertion order.
    for (const { chatId, cursor } of gaps) {
      sub.gap?.(chatId, cursor);
    }

    for (const { chatId, logs, replayCursor, startIndex } of replayPlans) {
      if (replayCursor) {
        const cursorLog = logs.find((log) =>
          log.turnId === replayCursor!.turnId
          && (log.selfInitiated || sub.includeForeground)
          && log.status === 'active'
          && (sub.ownerUserId === undefined || sub.ownerUserId === log.ownerUserId),
        );
        if (cursorLog) {
          for (const event of this.pendingInteractionRecovery(cursorLog, replayCursor.seq)) {
            sub.send(chatId, event, cursorLog.selfInitiated);
          }
        }
      }
      for (let index = startIndex; index < logs.length; index += 1) {
        const log = logs[index];
        if (!log.selfInitiated && !sub.includeForeground) continue;
        if (sub.ownerUserId !== undefined && sub.ownerUserId !== log.ownerUserId) continue;
        const fromSeq = replayCursor && index === startIndex ? replayCursor.seq + 1 : 0;
        for (const { seq, ev } of log.events) {
          if (seq >= fromSeq) sub.send(chatId, ev, log.selfInitiated);
        }
      }
    }
    // Replay is synchronous; registering only after it succeeds avoids
    // leaking a subscriber when its writer throws before a detach callback can
    // be returned to the route.
    this.backgroundSubscribers.add(sub);
    return () => this.backgroundSubscribers.delete(sub);
  }

  /** Attach to exactly one foreground turn. Used by /message resumption. */
  subscribeTurn(
    chatId: string,
    turnId: string,
    sub: HubSubscriber,
    fromSeq = 0,
  ): (() => void) | null {
    const log = this.replayableLogs(chatId).find((candidate) =>
      candidate.turnId === turnId && !candidate.selfInitiated,
    );
    if (!log) return null;
    const guarded: HubSubscriber = {
      send: (event) => {
        if (event.data.turnId === turnId) sub.send(event);
      },
      close: () => sub.close(),
    };
    const set = this.subscribersFor(chatId);
    set.add(guarded);
    for (const { seq, ev } of log.events) {
      if (seq >= fromSeq) guarded.send(ev);
    }
    if (log.status !== 'active') guarded.close();
    return () => {
      set.delete(guarded);
      if (set.size === 0) this.subscribers.delete(chatId);
    };
  }

  /**
   * A runtime self-turn this hub still holds. subscribeTurn() refuses it: the background feed delivers it.
   * A private turn (a check-in) is delivered to nobody, so it is never reported here either.
   */
  isSelfTurn(chatId: string, turnId: string): boolean {
    return this.replayableLogs(chatId).some((log) => log.turnId === turnId && log.selfInitiated && !log.private);
  }

  private replayableLogs(chatId: string): TurnLog[] {
    const retained = this.retainedTurns.get(chatId) ?? [];
    const current = this.turns.get(chatId);
    if (!current || retained.includes(current)) return [...retained];
    return [...retained, current];
  }

  cancel(chatId: string, requestedTurnId?: string): boolean {
    const log = this.turns.get(chatId);
    if (!log || log.status !== "active") {
      if (requestedTurnId) {
        this.reserveCancellation(requestedTurnId);
        this.notifyCancel(chatId, requestedTurnId);
      }
      return false;
    }
    const turnId = requestedTurnId ?? log.turnId;
    if (turnId !== log.turnId) {
      // Stop for a send still waiting behind the active turn (409 turn_active):
      // the active turn keeps running, and the waiting one must never start.
      this.reserveCancellation(turnId);
      this.notifyCancel(chatId, turnId);
      return false;
    }
    this.cancelledTurnIds.add(log.turnId);
    this.cancelRequestedAt.set(log.turnId, Date.now());
    this.append(chatId, log, {
      event: CHAT_STREAM_EVENTS.cancelPhase,
      data: {
        phase: "requested",
        source: "michi_simulated",
        confidence: "projected",
        nativeMethod: "cancel",
      },
    });
    const session = this.activeSessions.get(chatId);
    void Promise.resolve(session ? session.cancel() : log.selfCancel?.()).then((ack) => {
      const current = this.turns.get(chatId);
      if (!current || current.turnId !== log.turnId || current.status !== "active") return;
      if (ack && typeof ack === "object" && ack.acknowledged === true) {
        this.append(chatId, current, {
          event: CHAT_STREAM_EVENTS.cancelPhase,
          data: {
            phase: "acknowledged",
            // Provenance comes from the runtime, not from the fact that an ack
            // arrived. Kiro's ACP notify and Claude's confirmed process death
            // are `inferred`; only Codex/Pi have a real interrupt response.
            source: ack.source ?? "native",
            confidence: ack.confidence ?? "native",
            nativeMethod: ack.nativeMethod ?? "cancel",
          },
        });
      }
    }).catch(() => {});
    // Start a force-finish timer: if the streaming generator does not end
    // within the deadline, force the turn into a terminal state so the chat
    // is never stuck on "Cancel requested" indefinitely.
    this.scheduleCancelTimeout(chatId, log);
    this.notifyCancel(chatId, log.turnId);
    return true;
  }

  /** A Stop that beat its turn's start: startTurn refuses that id until retention ends. */
  private reserveCancellation(turnId: string): void {
    this.cancelledTurnIds.add(turnId);
    this.cancelRequestedAt.set(turnId, Date.now());
    const expiry = setTimeout(() => {
      this.cancelledTurnIds.delete(turnId);
      this.cancelRequestedAt.delete(turnId);
    }, this.retentionMs);
    expiry.unref?.();
  }

  /**
   * Cancel the active turn and wait for it to finish (with a timeout).
   * Returns once the turn is no longer active, either because it ended
   * naturally, was force-finished by the timeout, or was not active to
   * begin with.
   */
  async cancelAndWait(chatId: string, timeoutMs = CANCEL_TIMEOUT_MS): Promise<void> {
    const log = this.turns.get(chatId);
    if (!log || log.status !== "active") return;
    const turnId = log.turnId;
    this.cancel(chatId, turnId);

    // Wait for the active turn to complete (or the force-finish timer to fire).
    const done = this.activeTurnCompletions.get(chatId)
      ?? this.selfTurnQueues.get(chatId);
    if (!done) return;
    await Promise.race([
      done.catch(() => {}),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    // If the turn is still active after the race, the force-finish timer
    // from cancel() will handle it. Either way, the caller can proceed.
  }

  private scheduleCancelTimeout(chatId: string, log: TurnLog): void {
    // Clear any previous timer for this chat (idempotent cancel).
    const prev = this.cancelTimers.get(chatId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(async () => {
      this.cancelTimers.delete(chatId);
      const current = this.turns.get(chatId);
      if (!current || current.turnId !== log.turnId || current.status !== "active") return;
      appLog.warn('chat', 'cancel timeout: force-finishing stuck turn', {
        turnId: log.turnId,
        nodeId: log.nodeId,
        elapsedMs: Date.now() - (log.snapshot.startedAt ?? 0),
      });
      try {
        await this.finishWithDone(chatId, current, 'cancelled');
      } catch (err) {
        appLog.warn('chat', 'cancel timeout force-finish failed', {
          turnId: log.turnId,
          nodeId: log.nodeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (this.turns.get(chatId) !== current) return;
      // Clean up the active session reference so isActive() returns false.
      this.activeSessions.delete(chatId);
      for (const sub of this.subscribers.get(chatId) ?? []) {
        try { sub.close(); } catch { /* ignore */ }
      }
      this.scheduleEvict(chatId, current);
    }, CANCEL_TIMEOUT_MS);
    timer.unref?.();
    this.cancelTimers.set(chatId, timer);
  }

  private clearCancelTimer(chatId: string): void {
    const timer = this.cancelTimers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      this.cancelTimers.delete(chatId);
    }
  }

  async steer(chatId: string, text: string, options: SteerMessageOptions = {}): Promise<SteerResult & {
    message?: Extract<ChatStreamEvent, { event: 'steer_accepted' }>['data'];
  }> {
    const session = this.activeSessions.get(chatId);
    const log = this.turns.get(chatId);
    if (!session?.steer || !log || log.status !== 'active' || log.finalization) {
      return { accepted: false, reason: 'invisible' };
    }
    const steer = session.steer.bind(session);
    const operation = (async () => {
      const result = await steer(text);
      if (result.accepted) {
        if (!log.finalizedNotified) recordTypedText(log.nodeId, log.turnId, options.displayText ?? text);
        const message = {
          text: options.displayText ?? text,
          pending: result.pending ?? true,
          messageId: `u-steer-${randomUUID()}`,
          createdAt: Date.now(),
          userMetadata: options.userMetadata,
          queueId: options.queueId,
          assistantId: log.assistantId,
          turnId: log.turnId,
        };
        this.append(chatId, log, {
          event: CHAT_STREAM_EVENTS.steerAccepted,
          data: {
            ...message,
            source: "native",
            confidence: "native",
            nativeMethod: "steer",
          },
        });
        return { ...result, message };
      }
      return result;
    })();
    (log.pendingSteers ??= new Set()).add(operation);
    try { return await operation; }
    finally { log.pendingSteers.delete(operation); }
  }

  /**
   * Compaction is normally requested *between* turns, so this must not require
   * an active turn — it previously did, which made the whole path unreachable
   * in the one state users actually invoke it from. Stream events are only
   * appended when a turn is live to carry them; an idle compaction still runs
   * and reports its result through the HTTP response.
   */
  async compact(
    chatId: string,
    instructions?: string,
    idleSession?: AgentSession,
  ): Promise<CompactResult> {
    // activeSessions only holds a session for the duration of a turn, so an
    // idle compaction has to be handed the live session by the caller (which
    // resolves it from sessionRegistry). Prefer the in-turn session when both
    // are present — they are the same object during a turn.
    const session = this.activeSessions.get(chatId) ?? idleSession;
    if (!session?.compact) return { started: false, detail: "unsupported" };
    const result = await session.compact(instructions);
    // The summary may leave out the memory block: send it again next turn.
    if (result.started) this.forgetInjectedMemory(session);
    const log = this.turns.get(chatId);
    const live = log && log.status === "active" ? log : null;
    if (result.started && live) {
      this.append(chatId, live, {
        event: CHAT_STREAM_EVENTS.compactionStart,
        data: {
          detail: instructions ?? result.detail,
          source: "native",
          confidence: "native",
          nativeMethod: "compact",
        },
      });
      // Runtimes whose compact call resolves on completion (Kiro) have no
      // follow-up event to close the lifecycle, so emit the end here. Codex
      // leaves `completed` unset and its translator emits compaction_end.
      if (result.completed) {
        this.append(chatId, live, {
          event: CHAT_STREAM_EVENTS.compactionEnd,
          data: {
            detail: result.detail,
            source: "native",
            confidence: "native",
            nativeMethod: "compact",
          },
        });
      }
    }
    return result;
  }

  /**
   * The session may no longer hold the Michi Memory block it was sent (a
   * runtime command such as /clear or /compact ran on it): its next turn
   * carries the block again.
   */
  forgetInjectedMemory(session: AgentSession): void {
    this.memoryInjector?.forget(session);
  }

  /**
   * The Michi Memory block for a turn about to be sent, or null. A turn
   * that starts with "/" may be a command the runtime runs only when it
   * leads the prompt (and that may reset its context), so it carries no
   * block and the next turn sends one again.
   */
  private prepareMemory(session: AgentSession, log: TurnLog): PreparedMemoryContext | null {
    if (!this.memoryInjector) return null;
    // A skill turn's text is what followed the skill's name, never a runtime command.
    if (!log.skill && log.wireText.trimStart().startsWith('/')) {
      this.memoryInjector.forget(session);
      return null;
    }
    const visible = log.snapshot.userMessage?.content ?? '';
    return this.memoryInjector.prepare({
      session,
      ownerUserId: log.ownerUserId,
      workspaceId: log.snapshot.workspaceId,
      nodeId: log.nodeId,
      turnId: log.turnId,
      // What selects related notes: the user's words, a scheduled job's prompt or a delivered
      // message's body (without its thread-message framing); never the wire text, which can
      // carry context prefixes and mention expansions.
      query: log.humanOrigin ? visible : threadMessageBody(visible),
      scheduledJob: !!log.snapshot.userMessage?.metadata?.scheduledJobId,
    });
  }

  /** Follows a runtime event for the memory block: a compaction drops it, a completed turn delivers it. */
  private trackMemory(session: AgentSession | undefined, memory: PreparedMemoryContext | null, log: TurnLog, ev: NormalizedEvent): void {
    if (!session) return;
    if (ev.kind === 'compaction_start' || ev.kind === 'compaction_end') this.forgetInjectedMemory(session);
    else if (ev.kind === 'turn_end') this.memoryDelivered(memory, log, ev.stopReason);
  }

  private memoryDelivered(memory: PreparedMemoryContext | null, log: TurnLog, stopReason: string | undefined): void {
    if (!memory || stopReason === 'error' || stopReason === 'cancelled' || this.cancelledTurnIds.has(log.turnId)) return;
    memory.delivered();
  }

  /**
   * Clears the pending permission and tells every window (and the
   * multi-model approval mirror) with a permission_resolved frame. Only ACP
   * echoes one itself; a duplicate is a no-op downstream (matched by id).
   */
  resolvePermission(chatId: string, requestId: number): void {
    const log = this.turns.get(chatId);
    const pending = log?.pendingPermission;
    if (!log || pending?.event !== CHAT_STREAM_EVENTS.permissionRequest || pending.data.requestId !== requestId) return;
    log.pendingPermission = undefined;
    this.append(chatId, log, { event: CHAT_STREAM_EVENTS.permissionResolved, data: { requestId } });
  }

  getPendingPermission(chatId: string) {
    const event = this.turns.get(chatId)?.pendingPermission;
    return event?.event === CHAT_STREAM_EVENTS.permissionRequest ? event.data : null;
  }

  getPendingUserInput(chatId: string) {
    const event = this.turns.get(chatId)?.pendingUserInput;
    return event?.event === CHAT_STREAM_EVENTS.userInputRequest ? event.data : null;
  }

  resolveUserInput(chatId: string, requestId: number, answers: UserInputAnswer[] = [], skipped = answers.length === 0): void {
    const log = this.turns.get(chatId);
    const pending = log?.pendingUserInput;
    if (!log || pending?.event !== CHAT_STREAM_EVENTS.userInputRequest || pending.data.requestId !== requestId) return;
    this.append(chatId, log, { event: CHAT_STREAM_EVENTS.userInputResolved, data: {
      requestId, interactionId: pending.data.interactionId,
      answers: normalizeUserInputAnswers(pending.data.questions, answers), outcome: skipped ? 'skipped' : 'answered',
    } });
  }

  startSelfTurn(args: StartSelfTurnArgs): void {
    this.pendingSelfTurns.add(args.chatId);
    const previous = this.selfTurnQueues.get(args.chatId) ?? Promise.resolve();
    const queued = previous
      .catch(() => {})
      .then(async () => {
        // A Claude idle callback can race a user submission. Let the user
        // turn finish before consuming the self-turn iterator, so its log is
        // never overwritten and the two turn histories remain serial.
        const activeForeground = this.activeTurnCompletions.get(args.chatId);
        if (activeForeground) await activeForeground.catch(() => {});
        await this.beginSelfTurn(args);
      })
      .catch(async (err) => {
        // Claude's idle pump has already claimed the first runtime frame and
        // waits for this iterator to finish. If durable setup fails (for
        // example the node was deleted), drain the claimed turn so the pump's
        // single EventQueue waiter and runtime mutex are always released.
        // A runtime that can stop its turn does so first: nobody will see
        // it, so nothing it asks for (approvals) could be answered.
        await discardBackgroundTurn(args);
        appLog.warn('chat', 'self turn discarded before durable begin', {
          nodeId: args.nodeId,
          errorClass: err instanceof Error ? err.name : 'Error',
          error: err instanceof Error ? err.message : String(err),
        });
      });
    this.selfTurnQueues.set(args.chatId, queued);
    this.releaseSelfTurnQueueWhenSettled(args.chatId, queued);
  }

  /** Once the chat's last queued self turn settles, the chat has none pending. */
  private releaseSelfTurnQueueWhenSettled(chatId: string, queued: Promise<void>): void {
    const release = () => {
      if (this.selfTurnQueues.get(chatId) === queued) {
        this.selfTurnQueues.delete(chatId);
        this.pendingSelfTurns.delete(chatId);
      }
    };
    void queued.then(release, release);
  }

  /**
   * Starts a backend-requested Parent continuation with a caller-supplied
   * durable turn id. Committing that identity happens before the runtime
   * iterator is consumed. A retry returns the existing terminal turn, or
   * resumes an active turn that survived a crash but is absent in memory.
   */
  async startRequestedSelfTurn(args: StartRequestedSelfTurnArgs): Promise<StartedRequestedSelfTurn> {
    this.assertRequestedTurnAllowed(args);
    const durable = this.lookupDurableTurn(args.turnId);
    if (durable) {
      this.assertRequestedTurnIdentity(durable, args);
      if (durable.status !== 'active') {
        return { turnId: durable.turnId, assistantId: durable.assistantId, done: Promise.resolve(), existing: true };
      }
      const inMemory = this.turns.get(args.chatId);
      const completion = this.requestedSelfTurnCompletions.get(args.turnId);
      if (inMemory?.turnId === args.turnId && completion) {
        return { turnId: durable.turnId, assistantId: durable.assistantId, done: completion, existing: true };
      }
    }

    this.pendingSelfTurns.add(args.chatId);
    // Queued now, this turn will prompt the session: a turn the runtime
    // starts on its own meanwhile must give way rather than queue behind it
    // (its prompt would then wait for that turn). See startTurn.
    const releaseClaim = args.session.claimTurn?.();
    const previous = this.selfTurnQueues.get(args.chatId) ?? Promise.resolve();
    let started!: StartedRequestedSelfTurn;
    const began = new Promise<void>((resolve, reject) => {
      const queued = previous
        .catch(() => {})
        .then(async () => {
          const activeForeground = this.activeTurnCompletions.get(args.chatId);
          if (activeForeground) await activeForeground.catch(() => {});
          await this.runRequestedSelfTurn(args, (value) => { started = value; resolve(); });
        })
        .finally(() => releaseClaim?.())
        .catch((error) => {
          reject(error);
        });
      this.selfTurnQueues.set(args.chatId, queued);
      this.releaseSelfTurnQueueWhenSettled(args.chatId, queued);
    });
    await began;
    return started;
  }

  /**
   * Posts a message into an assistant conversation as a complete turn of its
   * own (DESIGN-v2 §3.3): a check-in's post (`cmp-post-<runId>`, W2-G1a) or
   * first-run narration (`mna-*`). In order:
   * - queued like a self turn (hasPendingSelfTurn holds, so a user send gets
   *   409 turn_active and retries) and behind any turn running there, so it
   *   never lands under a reply still streaming; when its place comes up,
   *   shouldPost may still withdraw it (`withdrawn`);
   * - the untrusted source is recorded first (turn_trust is not keyed on the
   *   turn row, so a failed write below leaves at most a stray mark, never an
   *   unmarked post);
   * - the turn is written as begin + finalize in ONE transaction with no user
   *   message (TurnPersistence.beginAndFinalize): chips, watermark and node
   *   status go through the normal finalize projection, and a crash leaves
   *   either the whole post or nothing, never an active conversation;
   * - only after the commit, `turn_start{selfInitiated, assistantMetadata}` →
   *   `chunk` → (`follow_ups`) → `done` go to the log and every window.
   * Idempotent per turnId: `existing` when it was posted before (or its
   * message already exists in this conversation), with nothing written or
   * broadcast. Throws TurnGuardError for a node or id it may not post with;
   * a post never sets the conversation's title or branch overview.
   */
  async postSelfMessage(args: PostSelfMessageArgs): Promise<PostSelfMessageResult> {
    const prepared = this.preparePost(args);
    const durable = this.lookupDurableTurn(args.turnId);
    if (durable) {
      this.assertPostIdentity(durable, args, prepared.messageId);
      return 'existing';
    }
    this.pendingSelfTurns.add(args.chatId);
    const previous = this.selfTurnQueues.get(args.chatId) ?? Promise.resolve();
    const posting = previous
      .catch(() => {})
      .then(async () => {
        const activeForeground = this.activeTurnCompletions.get(args.chatId);
        if (activeForeground) await activeForeground.catch(() => {});
        return this.commitPost(args, prepared);
      });
    const queued = posting.then(() => {}, () => {});
    this.selfTurnQueues.set(args.chatId, queued);
    void queued.then(() => {
      if (this.selfTurnQueues.get(args.chatId) === queued) {
        this.selfTurnQueues.delete(args.chatId);
        this.pendingSelfTurns.delete(args.chatId);
      }
    });
    return posting;
  }

  /** postSelfMessage's checks, before anything is queued or written; the metadata to store. */
  private preparePost(args: PostSelfMessageArgs): PreparedPost {
    const messageId = args.messageId ?? args.turnId;
    if (!args.text.trim()) throw new TurnGuardError('invalid_post', 'a post needs text');
    if (isCheckinNodeId(args.nodeId) || isCheckinNodeId(args.chatId)) {
      throw new TurnGuardError('checkin_node', `nothing is posted into check-in node ${args.nodeId}`);
    }
    if (!this.isAssistantNode(args.nodeId)) {
      throw new TurnGuardError('not_main_node', `node ${args.nodeId} is not an assistant conversation`);
    }
    // A closed conversation (the MVP Companion's, meta purpose 'companion') is not the main one either.
    if (CLOSED_ASSISTANT_PURPOSES.has(this.assistantPurposeOf(args.nodeId))) {
      throw new TurnGuardError('not_main_node', `node ${args.nodeId} is a closed assistant conversation, not the main one`);
    }
    const text = postVisibleText(args.text);
    if (!text) {
      throw new TurnGuardError('invalid_post', text === null
        ? `post ${args.turnId} still names the conversation after its sentinels are removed`
        : 'a post needs text besides its sentinels');
    }
    // Of the Companion's ids, a post may use only a post id (`cmp-post-<runId>`).
    const reservedForOthers = (id: string) => id.startsWith(COMPANION_SEND_TURN_PREFIX)
      || (id.startsWith(COMPANION_CHECKIN_TURN_PREFIX) && companionPostRunId(id) === null);
    if (reservedForOthers(args.turnId) || reservedForOthers(messageId)) {
      throw new TurnGuardError('reserved_turn_id', `post ${args.turnId} uses a check-in's or a follow-up's id`);
    }
    const hasPost = args.metadata?.companionPost !== undefined;
    const post = hasPost ? parseCompanionPostMetadata(args.metadata!.companionPost) : undefined;
    if (hasPost && !post) throw new TurnGuardError('invalid_post', `post ${args.turnId} carries malformed companionPost metadata`);
    const postRun = companionPostRunId(args.turnId) ?? companionPostRunId(messageId);
    if ((post || postRun !== null) && !(post
      && args.turnId === companionPostId(post.runId) && messageId === companionPostId(post.runId))) {
      // A post id without its metadata would replay its text in full (§2.8 T2), and metadata under another id would hide which run it is.
      throw new TurnGuardError('invalid_post', `post ${args.turnId} must carry the companionPost of run ${postRun ?? post?.runId} under that run's post id`);
    }
    const metadata = args.metadata ? { ...args.metadata, ...(post ? { companionPost: post } : {}) } : undefined;
    const untrusted = args.untrusted ?? (post ? { tool: 'companion_post', detail: 'checkin' } : undefined);
    const given = args.followUps?.map((value) => value.trim()).filter(Boolean) ?? [];
    const followUps = given.length ? given : extractTurnMetadata(args.text).followUps ?? [];
    return { messageId, metadata, untrusted, text, followUps };
  }

  private assertPostIdentity(durable: DurableTurnIdentity, args: PostSelfMessageArgs, messageId: string): void {
    if (durable.nodeId !== args.nodeId || durable.assistantId !== messageId) {
      throw new TurnGuardError('invalid_post', `post ${args.turnId} was reused with a different durable identity`);
    }
  }

  /** postSelfMessage once its queue position is reached: write, then show. */
  private async commitPost(args: PostSelfMessageArgs, prepared: PreparedPost): Promise<PostSelfMessageResult> {
    const raced = this.lookupDurableTurn(args.turnId);
    if (raced) {
      this.assertPostIdentity(raced, args, prepared.messageId);
      return 'existing';
    }
    if (args.shouldPost && !args.shouldPost()) return 'withdrawn';
    const write = this.persistence.beginAndFinalize;
    if (!write) throw new Error('this hub cannot post: its persistence has no beginAndFinalize');
    const log = this.createLog({
      chatId: args.chatId,
      turnId: args.turnId,
      assistantId: prepared.messageId,
      nodeId: args.nodeId,
      wireText: '',
      displayText: '',
      selfInitiated: true,
      ownerUserId: args.ownerUserId ?? null,
    });
    if (prepared.metadata) {
      log.snapshot = { ...log.snapshot, assistantMessage: { ...log.snapshot.assistantMessage, metadata: prepared.metadata } };
    }
    const companionPost = prepared.metadata?.companionPost;
    const { followUps } = prepared;
    const frames = [
      {
        event: CHAT_STREAM_EVENTS.turnStart,
        data: {
          turnId: args.turnId,
          assistantId: prepared.messageId,
          nodeId: args.nodeId,
          userText: '',
          selfInitiated: true,
          startedAt: log.snapshot.startedAt,
          ...(companionPost ? { assistantMetadata: { companionPost } } : {}),
        },
      },
      // The visible text only: a window reads a title, branch overview or chips from what it streamed.
      { event: CHAT_STREAM_EVENTS.chunk, data: { text: prepared.text } },
      ...(followUps.length ? [{ event: CHAT_STREAM_EVENTS.followUps, data: { followUps } }] : []),
      { event: CHAT_STREAM_EVENTS.done, data: { stopReason: 'end_turn', persisted: true, completedAt: Date.now() } },
    ] as ChatStreamEvent[];
    for (const frame of frames) {
      const stamped = this.stamp(log, frame);
      log.snapshot = applyTurnEvent(log.snapshot, stamped.ev);
      log.events.push(stamped);
    }
    // Only the chips project onto the conversation: a post never names it
    // or journals its branch overview (its streamed text carries neither).
    const chips = log.snapshot.nodeMetadata.followUps;
    log.snapshot = { ...log.snapshot, nodeMetadata: chips !== undefined ? { followUps: chips } : {} };
    if (prepared.untrusted) {
      // The post's own record only: its text never reaches the conversation's native session (§2.8 T2), so the
      // session's later turns carry nothing from it (w4-fix D25); a turn that reads or replies to it records that itself.
      this.recordUntrusted({ nodeId: args.nodeId, turnId: args.turnId }, {
        tool: prepared.untrusted.tool,
        runtimeId: prepared.untrusted.runtimeId ?? 'michi',
        ...(prepared.untrusted.detail ? { detail: prepared.untrusted.detail } : {}),
      }, { carry: false });
    }
    const outcome = await write(log.snapshot);
    if (outcome === 'existing') return 'existing';
    // Its `done` carries the node's committed completion facts, as persistDone's does: a post adds
    // none (coreBeginAndFinalizeTurn), and a window without them would count the post itself.
    log.events = log.events.map((entry) => this.withCompletionFacts(entry, args.nodeId));
    log.status = 'ended';
    this.turns.set(args.chatId, log);
    logInfo('post committed', log, { chars: prepared.text.length });
    for (const { ev } of log.events) this.broadcast(args.chatId, log, ev);
    this.scheduleEvict(args.chatId, log);
    return 'posted';
  }

  /** The body of a requested self-turn once its queue position is reached. */
  private async runRequestedSelfTurn(
    args: StartRequestedSelfTurnArgs,
    onStarted: (started: StartedRequestedSelfTurn) => void,
  ): Promise<void> {
    const existing = this.lookupDurableTurn(args.turnId);
    if (existing) this.assertRequestedTurnIdentity(existing, args);
    else if (args.shouldStart && !args.shouldStart()) {
      throw new Error(`requested turn ${args.turnId} was withdrawn before it started`);
    }
    const assistantId = existing?.assistantId ?? selfTurnAssistantId(args.nodeId, args.turnId);
    const displayText = args.displayText ?? '';
    const keepUserMessage = displayText.length > 0;
    const log = this.createLog({
      chatId: args.chatId,
      turnId: args.turnId,
      assistantId,
      nodeId: args.nodeId,
      wireText: args.text,
      displayText,
      userMetadata: keepUserMessage ? args.userMetadata : undefined,
      selfInitiated: true,
      keepUserMessage,
      ownerUserId: args.ownerUserId ?? null,
    });
    log.runtimeId = args.session.runtimeId;
    if (args.private === true || isCheckinNodeId(args.nodeId)) log.private = true;
    await this.persistence.begin(log.snapshot);
    this.turns.set(args.chatId, log);
    this.activeSessions.set(args.chatId, args.session);
    this.append(args.chatId, log, {
      event: CHAT_STREAM_EVENTS.turnStart,
      data: {
        turnId: args.turnId,
        assistantId,
        nodeId: args.nodeId,
        userText: displayText,
        selfInitiated: true,
        startedAt: log.snapshot.startedAt,
        ...(keepUserMessage && args.userMetadata ? { userMetadata: args.userMetadata } : {}),
      },
    } as ChatStreamEvent, false);
    const cancelledTurnIds = this.cancelledTurnIds;
    const pageContext = keepUserMessage && !args.maintenanceContext ? this.pageManifestBuilder({
      workspaceId: log.snapshot.workspaceId, nodeId: log.nodeId, ownerUserId: log.ownerUserId,
      now: Date.now(), turnId: log.turnId,
    }) : '';
    // Pages maintenance gets no Michi Memory; a turn whose caller brings its
    // own (a check-in's) sends that; every other requested turn runs in an
    // ordinary chat.
    const memory = args.maintenanceContext || args.memoryContext !== undefined ? null : this.prepareMemory(args.session, log);
    const memoryContext = args.maintenanceContext ? null : args.memoryContext ?? memory?.text ?? null;
    const events = (async function* (): AsyncIterableIterator<NormalizedEvent> {
      // Stop can reserve this id while begin() commits, or arrive from
      // a synchronous turn_start subscriber. Never dispatch that work.
      if (cancelledTurnIds.has(log.turnId)) {
        yield { kind: 'turn_end', stopReason: 'cancelled' };
        return;
      }
      yield* args.session.send(args.text, {
        assistantMessageId: assistantId,
        ...(log.snapshot.userMessage?.id ? { userMessageId: log.snapshot.userMessage.id } : {}),
        ...(memoryContext ? { memoryContext } : {}),
        ...(pageContext ? { pageContext } : {}),
        ...(args.maintenanceContext ? { maintenanceContext: args.maintenanceContext } : {}),
        turnId: log.turnId,
      });
    })();
    const done = this.runSelfTurn(args.chatId, log, events, args.session, memory);
    this.requestedSelfTurnCompletions.set(args.turnId, done);
    void done.then(
      () => this.requestedSelfTurnCompletions.delete(args.turnId),
      () => this.requestedSelfTurnCompletions.delete(args.turnId),
    );
    onStarted({ turnId: args.turnId, assistantId, done, existing: !!existing });
    await done;
  }

  /**
   * DESIGN-v2 §2.5, fail closed: a `cmp-` turn id (a check-in's own turn,
   * and so also a post's `cmp-post-`) runs only on a check-in node, and a
   * check-in node runs only its own run's check-in turn (`cmp-<runId>` on
   * `n-cmph-<runId>`), so a hidden note can never reach the conversation; a
   * `cms-` turn (a follow-up the agent sends) runs only outside the
   * assistant's workspace, so it never lands in V or a check-in.
   */
  private assertRequestedTurnAllowed(args: StartRequestedSelfTurnArgs): void {
    const checkinNode = isCheckinNodeId(args.nodeId);
    if (args.turnId.startsWith(COMPANION_CHECKIN_TURN_PREFIX) && !checkinNode) {
      throw new TurnGuardError('reserved_turn_id', `turn ${args.turnId} is a check-in's and runs only on its check-in node`);
    }
    if (checkinNode) {
      const runId = companionCheckinTurnRunId(args.turnId);
      if (!runId || runId !== checkinRunId(args.nodeId)) {
        throw new TurnGuardError('checkin_node', `check-in node ${args.nodeId} runs only its own check-in turn`);
      }
    }
    if (args.turnId.startsWith(COMPANION_SEND_TURN_PREFIX) && (checkinNode || this.isAssistantNode(args.nodeId))) {
      throw new TurnGuardError('reserved_turn_id', `follow-up turn ${args.turnId} cannot run in the assistant's own conversations`);
    }
  }

  private assertRequestedTurnIdentity(durable: DurableTurnIdentity, args: StartRequestedSelfTurnArgs): void {
    const expectedAssistantId = selfTurnAssistantId(args.nodeId, args.turnId);
    if (durable.nodeId !== args.nodeId || durable.assistantId !== expectedAssistantId) {
      throw new Error(`requested Parent turn ${args.turnId} was reused with a different durable identity`);
    }
  }

  private async beginSelfTurn(args: StartSelfTurnArgs): Promise<void> {
    // A turn the runtime starts on its own in a check-in's session would run
    // unrequested and unwatched: startSelfTurn stops and drains it instead.
    if (isCheckinNodeId(args.nodeId)) {
      throw new TurnGuardError('checkin_node', `check-in node ${args.nodeId} takes no turns the runtime starts on its own`);
    }
    if (args.session && (
      args.session.id !== args.chatId
      || chatNodeOf(args.session.owner) !== args.nodeId
    )) {
      throw new Error('self turn runtime does not match its chat node owner');
    }
    const turnId = randomUUID();
    const assistantId = selfTurnAssistantId(args.nodeId, turnId);
    const log = this.createLog({
      chatId: args.chatId,
      turnId,
      assistantId,
      nodeId: args.nodeId,
      wireText: '',
      displayText: '',
      selfInitiated: true,
      ownerUserId: args.ownerUserId ?? null,
    });
    if (args.cancel) log.selfCancel = args.cancel;
    log.runtimeId = args.session?.runtimeId ?? null;
    const persistStartedAt = Date.now();
    await this.persistence.begin(log.snapshot);
    logInfo('self turn begin committed', log, { durationMs: Date.now() - persistStartedAt });
    this.turns.set(args.chatId, log);
    if (args.session) this.activeSessions.set(args.chatId, args.session);
    this.append(args.chatId, log, {
      event: CHAT_STREAM_EVENTS.turnStart,
      data: {
        turnId,
        assistantId,
        nodeId: args.nodeId,
        userText: '',
        selfInitiated: true,
        startedAt: log.snapshot.startedAt,
      },
    } as ChatStreamEvent, false);
    await this.runSelfTurn(args.chatId, log, args.events, args.session);
  }

  private createLog(input: {
    chatId: string;
    turnId: string;
    assistantId: string;
    nodeId: string;
    wireText: string;
    displayText: string;
    userMetadata?: DurableMessageMetadata;
    selfInitiated: boolean;
    keepUserMessage?: boolean;
    ownerUserId: string | null;
  }): TurnLog {
    const workspaceId = this.workspaceIdForNode(input.nodeId);
    if (!workspaceId) throw new Error(`node ${input.nodeId} does not exist`);
    const startedAt = Date.now();
    return {
      chatId: input.chatId,
      turnId: input.turnId,
      assistantId: input.assistantId,
      nodeId: input.nodeId,
      wireText: input.wireText,
      events: [],
      status: "active",
      nextSeq: 0,
      snapshot: createDurableTurn({
        turnId: input.turnId,
        assistantId: input.assistantId,
        nodeId: input.nodeId,
        workspaceId,
        displayUserText: input.displayText,
        userMetadata: input.userMetadata,
        selfInitiated: input.selfInitiated,
        keepUserMessage: input.keepUserMessage,
        startedAt,
      }),
      lastCheckpointAt: startedAt,
      checkpointCount: 0,
      selfInitiated: input.selfInitiated,
      ownerUserId: input.ownerUserId,
    };
  }

  private async runSelfTurn(
    chatId: string,
    log: TurnLog,
    events: AsyncIterableIterator<NormalizedEvent>,
    session?: AgentSession,
    memory: PreparedMemoryContext | null = null,
  ): Promise<void> {
    try {
      await this.pumpTurnEvents(chatId, log, events, session, memory);
    } catch (err) {
      await this.failTurn(chatId, log, err);
    } finally {
      this.cancelledTurnIds.delete(log.turnId);
      this.cancelRequestedAt.delete(log.turnId);
      if (this.turns.get(chatId) === log) {
        this.clearCancelTimer(chatId);
        if (session && this.activeSessions.get(chatId) === session) this.activeSessions.delete(chatId);
      }
      this.scheduleEvict(chatId, log);
    }
  }

  /**
   * Folds a turn's runtime events into its log until the turn ends, and ends
   * it as end_turn (or cancelled) when the stream stops without turn_end.
   * Stops reading once the log is no longer the chat's active one.
   */
  private async pumpTurnEvents(
    chatId: string,
    log: TurnLog,
    events: AsyncIterable<NormalizedEvent>,
    session: AgentSession | undefined,
    memory: PreparedMemoryContext | null,
  ): Promise<void> {
    let branchOverviewPublished = false;
    for await (const ev of events) {
      if (log.status !== 'active' || this.turns.get(chatId) !== log) break;
      if (log.finalization) { await log.finalization; break; }
      if (reportsBranchOverview(ev)) branchOverviewPublished = true;
      observeTurnTrust({ nodeId: log.nodeId, turnId: log.turnId }, session?.runtimeId, ev);
      if (ev.kind === "runtime_error") throw runtimeEventError(ev);
      this.trackMemory(session, memory, log, ev);
      if (ev.kind === "turn_end") {
        if (!branchOverviewPublished) {
          branchOverviewPublished = this.publishBranchOverview(chatId, log);
        }
        await this.finishWithDone(
          chatId,
          log,
          this.cancelledTurnIds.has(log.turnId) ? 'cancelled' : ev.stopReason,
        );
        break;
      }
      const wire = toChatStreamEvent(ev);
      if (wire) this.append(chatId, log, wire);
    }
    if (log.finalization) await log.finalization;
    if (log.status === 'active' && this.turns.get(chatId) === log) {
      if (!branchOverviewPublished) this.publishBranchOverview(chatId, log);
      this.memoryDelivered(memory, log, 'end_turn');
      await this.finishWithDone(
        chatId,
        log,
        this.cancelledTurnIds.has(log.turnId) ? 'cancelled' : 'end_turn',
      );
    }
  }

  /** A turn that threw: a Stop's runtime error is a graceful cancellation, unless the runtime needs recovery. */
  private async failTurn(chatId: string, log: TurnLog, err: unknown): Promise<void> {
    if (this.cancelledTurnIds.has(log.turnId) && !(err instanceof RuntimeRecoveryRequiredError)) {
      await this.finishWithDone(chatId, log, 'cancelled');
    } else {
      await this.finishWithError(chatId, log, err);
    }
  }

  private subscribersFor(chatId: string): Set<HubSubscriber> {
    let set = this.subscribers.get(chatId);
    if (!set) {
      set = new Set();
      this.subscribers.set(chatId, set);
    }
    return set;
  }

  private stamp(log: TurnLog, ev: ChatStreamEvent): { seq: number; ev: ChatStreamEvent } {
    const seq = log.nextSeq++;
    if (ev.event === CHAT_STREAM_EVENTS.userInputRequest) {
      const interactionId = ev.data.interactionId ?? `${userInputInteractionId(log.turnId, ev.data.requestId)}:${seq}`;
      ev = { ...ev, data: { ...ev.data, interactionId, questions: normalizeUserInputQuestions(interactionId, ev.data.questions) } };
    } else if (ev.event === CHAT_STREAM_EVENTS.userInputResolved) {
      const pending = log.pendingUserInput;
      const requestId = ev.data.requestId;
      const prior = [...log.snapshot.assistantMessage.blocks].reverse().find(block => block.kind === 'user-input' && block.requestId === requestId);
      const priorInteractionId = prior?.kind === 'user-input' ? prior.interaction?.interactionId : undefined;
      const interactionId = ev.data.interactionId ?? (pending?.event === CHAT_STREAM_EVENTS.userInputRequest && pending.data.requestId === ev.data.requestId
        ? pending.data.interactionId : undefined) ?? priorInteractionId ?? userInputInteractionId(log.turnId, ev.data.requestId);
      ev = { ...ev, data: { ...ev.data, interactionId } };
    }
    return {
      seq,
      ev: {
        ...ev,
        data: {
          ...ev.data,
          observedAt: ev.data.observedAt ?? Date.now(),
          chatId: log.chatId,
          nodeId: log.nodeId,
          turnId: log.turnId,
          seq,
          assistantId: log.assistantId,
          source: ev.data.source ?? "michi_simulated",
          confidence: ev.data.confidence ?? "projected",
        },
      } as ChatStreamEvent,
    };
  }

  private append(
    chatId: string,
    log: TurnLog,
    ev: ChatStreamEvent,
    checkpoint = true,
  ): void {
    if (log.terminalStamped) return;
    const stamped = this.stamp(log, ev);
    log.snapshot = applyTurnEvent(log.snapshot, stamped.ev);
    log.events.push(stamped);
    this.trackPendingInteraction(log, stamped.ev);
    this.broadcast(chatId, log, stamped.ev);
    if (checkpoint) this.maybeCheckpoint(log, stamped.ev);
  }

  private trackPendingInteraction(log: TurnLog, event: ChatStreamEvent): void {
    if (event.event === CHAT_STREAM_EVENTS.permissionRequest) {
      log.pendingPermission = event;
    } else if (event.event === CHAT_STREAM_EVENTS.permissionResolved) {
      if (log.pendingPermission?.event === CHAT_STREAM_EVENTS.permissionRequest && log.pendingPermission.data.requestId === event.data.requestId) log.pendingPermission = undefined;
    } else if (event.event === CHAT_STREAM_EVENTS.userInputRequest) {
      log.pendingUserInput = event;
    } else if (
      event.event === CHAT_STREAM_EVENTS.userInputResolved
      && log.pendingUserInput?.event === CHAT_STREAM_EVENTS.userInputRequest
      && log.pendingUserInput.data.requestId === event.data.requestId
      && (!event.data.interactionId || log.pendingUserInput.data.interactionId === event.data.interactionId)
    ) {
      log.pendingUserInput = undefined;
    } else if (event.event === CHAT_STREAM_EVENTS.done || event.event === CHAT_STREAM_EVENTS.error) {
      log.pendingPermission = undefined;
      log.pendingUserInput = undefined;
    }
  }

  private pendingInteractionRecovery(log: TurnLog, throughSeq: number): ChatStreamEvent[] {
    return [log.pendingPermission, log.pendingUserInput].flatMap((event) => {
      if (!event) return [];
      if (typeof event.data.seq === 'number' && event.data.seq > throughSeq) return [];
      // An unsequenced recovery frame deliberately does not advance the
      // durable cursor. It restores transient UI state while normal tail
      // replay continues from durable.seq + 1.
      return [{
        ...event,
        data: { ...event.data, seq: undefined },
      } as ChatStreamEvent];
    });
  }

  private maybeCheckpoint(log: TurnLog, event: ChatStreamEvent): void {
    const now = Date.now();
    const immediate = STRUCTURAL_EVENTS.has(event.event)
      || (event.event === CHAT_STREAM_EVENTS.toolCallUpdate && !isActiveToolStatus(event.data.status));
    if (!immediate && now - log.lastCheckpointAt < this.checkpointIntervalMs) return;
    log.lastCheckpointAt = now;
    try {
      this.persistence.checkpoint(log.snapshot);
      log.checkpointCount += 1;
    } catch (err) {
      appLog.warn('chat', 'turn checkpoint failed; continuing to finalization', {
        turnId: log.turnId,
        nodeId: log.nodeId,
        eventCount: log.events.length,
        checkpointCount: log.checkpointCount,
        errorClass: err instanceof Error ? err.name : 'Error',
      });
    }
  }

  private broadcast(chatId: string, log: TurnLog, event: ChatStreamEvent): void {
    // A private turn reaches no subscriber at all, background or direct.
    if (log.private) return;
    for (const sub of this.backgroundSubscribers) {
      if (!log.selfInitiated && !sub.includeForeground) continue;
      try {
        if (sub.ownerUserId !== undefined && sub.ownerUserId !== log.ownerUserId) continue;
        sub.send(chatId, event, log.selfInitiated);
      } catch {
        // A broken background window must not stop the central runner.
      }
    }
    for (const sub of this.subscribers.get(chatId) ?? []) {
      try {
        sub.send(event);
      } catch {
        // A broken subscriber must not stop the central runner or persistence.
      }
    }
  }

  private rawAnswer(log: TurnLog): string {
    return log.snapshot.assistantMessage.blocks
      .map((block) => block.kind === 'answer' ? block.rawText : '')
      .join('');
  }

  private publishBranchOverview(chatId: string, log: TurnLog): boolean {
    const overview = extractBranchOverview(this.rawAnswer(log));
    if (!overview) return false;
    this.append(chatId, log, {
      event: CHAT_STREAM_EVENTS.branchOverview,
      data: { overview },
    });
    return true;
  }

  private emitCancelSettled(chatId: string, log: TurnLog): void {
    if (!this.cancelledTurnIds.has(log.turnId)) return;
    if (log.events.some((entry) =>
      entry.ev.event === CHAT_STREAM_EVENTS.cancelPhase && entry.ev.data.phase === "settled"
    )) return;
    this.append(chatId, log, {
      event: CHAT_STREAM_EVENTS.cancelPhase,
      data: {
        phase: "settled",
        source: "michi_simulated",
        confidence: "projected",
        nativeMethod: "cancel",
      },
    }, false);
  }

  private finalizeOnce(log: TurnLog, finalize: () => Promise<void>): Promise<void> {
    if (log.finalization) return log.finalization;
    if (log.status !== 'active') return Promise.resolve();
    log.finalization = Promise.resolve().then(finalize);
    return log.finalization;
  }

  private finishWithDone(chatId: string, log: TurnLog, stopReason?: string): Promise<void> {
    return this.finalizeOnce(log, () => this.persistDone(chatId, log, stopReason));
  }

  private async persistDone(chatId: string, log: TurnLog, stopReason?: string): Promise<void> {
    await Promise.allSettled(log.pendingSteers ?? []);
    this.emitCancelSettled(chatId, log);
    const stamped = this.stamp(log, {
      event: CHAT_STREAM_EVENTS.done,
      data: { stopReason, persisted: true, completedAt: Date.now() },
    });
    log.terminalStamped = true;
    const terminalSnapshot = applyTurnEvent(log.snapshot, stamped.ev);
    // This is the durability boundary: successful done is not observable until
    // the transaction containing messages + node metadata + turn receipt commits.
    const persistStartedAt = Date.now();
    try {
      await this.persistence.finalize(terminalSnapshot);
    } catch (err) {
      this.finishWithPersistenceError(chatId, log, err);
      return;
    }
    const committed = this.withCompletionFacts(stamped, log.nodeId);
    log.snapshot = terminalSnapshot;
    log.events.push(committed);
    this.trackPendingInteraction(log, committed.ev);
    log.status = "ended";
    logInfo('turn finalized', log, {
      durationMs: Date.now() - persistStartedAt,
      status: terminalSnapshot.status,
      payloadBytes: Buffer.byteLength(JSON.stringify(terminalSnapshot)),
    });
    this.broadcast(chatId, log, committed.ev);
    this.markSettled(log);
    this.notifyTurnFinalized(chatId, log, true);
  }

  /**
   * The finalized `done` with the node's committed completion facts, so every
   * window (live or replaying) holds the server's count, whether or not it
   * watched the reply stream. Without facts the frame goes out as it was.
   */
  private withCompletionFacts(entry: { seq: number; ev: ChatStreamEvent }, nodeId: string): { seq: number; ev: ChatStreamEvent } {
    const ev = entry.ev;
    if (ev.event !== CHAT_STREAM_EVENTS.done) return entry;
    let facts: NodeCompletionFacts | null = null;
    try {
      facts = this.persistence.completionFacts?.(nodeId) ?? null;
    } catch {
      // The receipt committed; only the facts are missing from the frame.
    }
    return facts ? { ...entry, ev: { ...ev, data: { ...ev.data, ...facts } } } : entry;
  }

  private finishWithError(chatId: string, log: TurnLog, err: unknown): Promise<void> {
    return this.finalizeOnce(log, () => this.persistError(chatId, log, err));
  }

  private async persistError(chatId: string, log: TurnLog, err: unknown): Promise<void> {
    const interruptedByShutdown = this.shuttingDown;
    await Promise.allSettled(log.pendingSteers ?? []);
    let message = err instanceof Error ? err.message : String(err);
    // Surface the rpcData detail so the user sees the real reason (e.g.
    // "The model you've selected is temporarily unavailable") instead of the
    // opaque JSON-RPC envelope message (e.g. "Internal error").
    if (err instanceof ACPError && err.rpcData != null) {
      const detail =
        typeof err.rpcData === "string"
          ? err.rpcData
          : JSON.stringify(err.rpcData);
      if (detail && !message.includes(detail.slice(0, 40))) {
        message = detail;
      }
    }
    // AcpAgentSession tags connection/auth/generic on the thrown error so the UI
    // can show a class-appropriate banner (retry vs. re-login vs. raw). Failing
    // that, a runtime_error event's own code is used if it is one of those
    // kinds. Absent for unclassified errors — the UI falls back to a plain
    // error tail. Whether the runtime called the failure retryable is not
    // sent: `recoverable` means the turn's output could not be saved, which
    // is a different thing.
    const acpErrorKind = (err as { acpErrorKind?: string })?.acpErrorKind;
    const reportedKind = err instanceof ReportedRuntimeError && err.code !== undefined && RUNTIME_ERROR_KINDS.has(err.code)
      ? err.code
      : undefined;
    const code = interruptedByShutdown ? BACKEND_RESTARTED_ERROR : chatStreamErrorCode(err) ?? acpErrorKind ?? reportedKind;
    if (interruptedByShutdown) {
      message = BACKEND_RESTARTED_MESSAGE;
    }
    try {
      this.emitCancelSettled(chatId, log);
      const stamped = this.stamp(log, {
        event: CHAT_STREAM_EVENTS.error,
        data: { message, completedAt: Date.now(), ...(code ? { code } : {}) },
      });
      log.terminalStamped = true;
      const terminalSnapshot = applyTurnEvent(log.snapshot, stamped.ev);
      // Keep the durable restart marker used by startup recovery and replay;
      // the live event above carries the human-readable explanation.
      if (interruptedByShutdown) terminalSnapshot.error = BACKEND_RESTARTED_ERROR;
      await this.persistence.finalize(terminalSnapshot);
      log.snapshot = terminalSnapshot;
      log.events.push(stamped);
      this.trackPendingInteraction(log, stamped.ev);
      log.status = "error";
      this.broadcast(chatId, log, stamped.ev);
      this.markSettled(log);
    } catch (persistErr) {
      this.finishWithPersistenceError(chatId, log, persistErr);
      return;
    }
    this.notifyTurnFinalized(chatId, log, true);
  }

  private finishWithPersistenceError(chatId: string, log: TurnLog, err: unknown): void {
    const persistError = err instanceof Error ? err : new Error(String(err));
    log.status = "error";
    // Dedicated field beside the existing effects above/below (status, log,
    // broadcast) — none of those are altered. This is the only durable-ish
    // record of the failure and it is IN-MEMORY ONLY; see the TurnLog field
    // doc-comment for why it must never be treated as surviving a restart.
    log.lastPersistenceError = {
      message: persistError.message,
      recoverable: true,
      occurredAt: Date.now(),
    };
    appLog.error('chat', 'turn persistence finalize failed', {
      turnId: log.turnId,
      nodeId: log.nodeId,
      eventCount: log.events.length,
      checkpointCount: log.checkpointCount,
      errorClass: persistError.name,
    });
    const persistenceError = this.stamp(log, createChatStreamError(
      `Turn output was produced but could not be committed: ${persistError.message}`,
    ));
    persistenceError.ev = {
      ...persistenceError.ev,
      data: {
        ...persistenceError.ev.data,
        code: TURN_ERROR_CODES.persistenceFailed,
        recoverable: true,
        completedAt: Date.now(),
      },
    } as ChatStreamEvent;
    log.events.push(persistenceError);
    this.trackPendingInteraction(log, persistenceError.ev);
    this.broadcast(chatId, log, persistenceError.ev);
    this.markSettled(log);
    this.notifyTurnFinalized(chatId, log, false);
  }

  /** The turn left `active`: release whenTurnSettled's waiters. */
  private markSettled(log: TurnLog): void {
    const waiters = log.settleWaiters;
    log.settleWaiters = undefined;
    for (const waiter of waiters ?? []) waiter();
  }

  /** The in-memory log of a turn, current or retained, or null. */
  private findLogByTurnId(turnId: string): TurnLog | null {
    for (const log of this.turns.values()) if (log.turnId === turnId) return log;
    for (const logs of this.retainedTurns.values()) {
      for (const log of logs) if (log.turnId === turnId) return log;
    }
    return null;
  }

  /**
   * Resolves once the turn has settled, with the terminal status that was
   * committed for it: `completed` means it ran to its normal end (DESIGN-v2
   * §3.5: what the next turn was told counts as delivered only then).
   * Null when the outcome is unknown: no such turn, a turn this process
   * does not hold that is still active in the database (another process's,
   * or one a crash interrupted), or one whose final write failed. A turn
   * already over answers from memory or the database at once. Never rejects;
   * a turn stuck after Stop settles when the cancel timeout force-finishes it.
   */
  async whenTurnSettled(turnId: string): Promise<SettledTurnStatus | null> {
    const log = this.findLogByTurnId(turnId);
    if (log) {
      if (log.status === 'active') {
        await new Promise<void>((resolve) => { (log.settleWaiters ??= []).push(resolve); });
      }
      if (log.lastPersistenceError) return null;
      const status = log.snapshot.status;
      return status === 'active' ? null : status;
    }
    const durable = this.lookupDurableTurn(turnId);
    return durable && durable.status !== 'active' ? durable.status : null;
  }

  /**
   * Kick off sidecar title generation for an untitled chat node. Runs beside
   * the main turn and never awaits it: whichever title arrives first wins
   * because both the durable projection (`setTitleIfEmpty`) and the renderer
   * lock the first non-blank title. A result that lands after the turn ended
   * is dropped — the agent's sentinel or the stored first sentence covers it.
   */
  private maybeGenerateTitle(args: StartTurnArgs, log: TurnLog): void {
    const runtime = getRuntime(args.session.runtimeId);
    if (runtime && descriptorOf(runtime).topology.hostTitleRequiresOptIn === true && args.enableKiroSidecarTitle !== true) return;
    const generator = this.titleGenerator;
    if (!generator) return;
    if (isRunOwner(args.session.owner)) return;
    const source = titleSourceOf(args);
    if (!source) return;
    const { text: userText, context: contextText } = source;
    let existing: string | null;
    try {
      existing = this.nodeTitle(log.nodeId);
    } catch {
      return;
    }
    if (existing && existing.trim().length > 0) return;

    const startedAt = Date.now();
    let pending: Promise<string | null>;
    try {
      pending = Promise.resolve(generator({ session: args.session, nodeId: log.nodeId, userText, contextText }));
    } catch (err) {
      pending = Promise.reject(err);
    }
    void pending.then((title) => {
      const trimmed = title?.trim() ?? '';
      if (!trimmed) return;
      if (this.turns.get(args.chatId) !== log || log.status !== 'active') {
        logInfo('sidecar title arrived after turn ended; dropped', log, {
          durationMs: Date.now() - startedAt,
          runtimeId: args.session.runtimeId,
        });
        return;
      }
      if (log.snapshot.nodeMetadata.title) return;
      this.append(args.chatId, log, {
        event: CHAT_STREAM_EVENTS.title,
        data: { title: trimmed },
      });
      logInfo('sidecar title applied', log, {
        durationMs: Date.now() - startedAt,
        runtimeId: args.session.runtimeId,
        titleChars: trimmed.length,
      });
    }, (err: unknown) => {
      appLog.warn('chat', 'sidecar title generation failed', {
        turnId: log.turnId,
        nodeId: log.nodeId,
        runtimeId: args.session.runtimeId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async runTurn(chatId: string, log: TurnLog, session: AgentSession): Promise<void> {
    try {
      // Stop may arrive while the provisional rows are committing, before
      // activeSessions is installed. Preserve that cancellation before send().
      if (this.cancelledTurnIds.has(log.turnId)) {
        await this.finishWithDone(chatId, log, 'cancelled');
        return;
      }
      const pageContext = this.pageManifestBuilder({
        workspaceId: log.snapshot.workspaceId,
        nodeId: log.nodeId,
        ownerUserId: log.ownerUserId,
        now: Date.now(),
        turnId: log.turnId,
      });
      const memory = this.prepareMemory(session, log);
      const uploaded = log.snapshot.userMessage?.metadata?.attachments;
      const input = uploaded?.length && isAssistantNode(log.nodeId)
        ? prepareAssistantAttachments(log.wireText, uploaded, assistantCwd())
        : { text: log.wireText, attachments: uploaded };
      await this.pumpTurnEvents(chatId, log, session.send(input.text, {
        attachments: input.attachments,
        assistantMessageId: log.assistantId,
        userMessageId: log.snapshot.userMessage?.id,
        ...(memory ? { memoryContext: memory.text } : {}),
        ...(pageContext ? { pageContext } : {}),
        turnId: log.turnId,
        ...(log.humanOrigin ? { humanOrigin: true } : {}),
        ...(log.skill ? { skill: log.skill } : {}),
        ...(log.titleSource ? { titleSource: log.titleSource } : {}),
      }), session, memory);
    } catch (err) {
      await this.failTurn(chatId, log, err);
    } finally {
      this.cancelledTurnIds.delete(log.turnId);
      this.cancelRequestedAt.delete(log.turnId);
      // A timed-out cancellation can finish after the next turn has started.
      // Only the current turn owns chat-scoped timers, sessions and subscribers.
      if (this.turns.get(chatId) === log) {
        this.clearCancelTimer(chatId);
        this.activeSessions.delete(chatId);
        for (const sub of this.subscribers.get(chatId) ?? []) {
          try {
            sub.close();
          } catch {
            // ignore subscriber teardown failures
          }
        }
      }
      this.scheduleEvict(chatId, log);
    }
  }

  private scheduleEvict(chatId: string, log: TurnLog): void {
    const retained = this.retainedTurns.get(chatId) ?? [];
    if (!retained.includes(log)) {
      retained.push(log);
      this.retainedTurns.set(chatId, retained);
    }
    const timer = setTimeout(() => {
      if (this.turns.get(chatId) === log) this.turns.delete(chatId);
      const remaining = (this.retainedTurns.get(chatId) ?? []).filter((entry) => entry !== log);
      if (remaining.length > 0) this.retainedTurns.set(chatId, remaining);
      else this.retainedTurns.delete(chatId);
    }, this.retentionMs);
    timer.unref?.();
  }
}

function logInfo(
  message: string,
  turn: TurnLog,
  extra: Record<string, unknown>,
): void {
  appLog.info('chat', message, {
    turnId: turn.turnId,
    nodeId: turn.nodeId,
    eventCount: turn.events.length,
    checkpointCount: turn.checkpointCount,
    ...extra,
  });
}

export const chatHub = new ChatHub();
