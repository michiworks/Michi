/**
 * The agent's check-ins (DESIGN-v2 §3.1, §3.3, §3.4): the CompanionTurnRunner
 * the coordinator drives. Every check-in runs on its own:
 *
 *  1. the user's rules read fresh (unreadable: nothing runs, fail closed);
 *  2. a throwaway node S = `n-cmph-<runId>` in the assistant's workspace
 *     (checkinNode.ts), recorded on the run before it exists;
 *  3. a fresh ephemeral native session for S (chatManager.openEphemeralSession:
 *     the closed profile, V's runtime and model, S's own cwd), its runtime,
 *     native id and cwd recorded on the run so a restart can discard it;
 *  4. the note composed from the material (prompts.ts), and the Michi Memory
 *     it reads built (checkinNode.ts startCheckinMemory: the resident pack,
 *     Saved by the user and Preferences and conventions from trusted
 *     sources; no recall, and a check-in has no memory tools);
 *  5. chatHub.startRequestedSelfTurn on S as `cmp-<runId>`, private (no window
 *     sees it), that pack its memory context;
 *  6. the turn awaited, at most the hidden-turn timeout; the user typing to
 *     the agent (preempt) or Stop cuts it short;
 *  7. its outcome read from S's message and its changes from storage;
 *  8. what goes into the conversation V (posts.ts): its reply when it spoke,
 *     else Michi's receipt when it changed something (§3.4); nothing when it
 *     was quiet and changed nothing. When the user wrote in V after the
 *     check-in began, its reply is not posted (superseded: Activity keeps its
 *     length, never its text), only the receipt of its changes. When what
 *     its memory pack showed changed meanwhile (D5), it is withdrawn:
 *     nothing is posted, what it changed is undone, and even a quiet one
 *     leaves its material to the next check-in;
 *  9. finally S's session discarded (its native record too: `deferred`
 *     leaves the run pending for boot cleanup, `unsupported` records that its
 *     runtime keeps it, final; neither is recorded as gone) and S purged with
 *     every row that names it, before the run records its record gone.
 *     A stopped turn that is still running after settleWaitMs keeps S, and
 *     its receipt is posted, S purged, once that turn ended.
 *
 * V is never busy because of a check-in: only the post's one transaction
 * makes it active. Outcomes: spoke / quiet / superseded / skipped (a
 * catch-up, another check-in, V busy, chatHub already had the turn) /
 * preempted (the user typed, or Stop) / error (no session, the launch check
 * failing closed included, Michi Memory that could not be read, a failed or
 * timed-out turn, a post that failed or was withdrawn: its material waits
 * for the next check-in, which reads memory again). At most one check-in
 * runs at a time.
 */

import {
  COMPANION_LIMITS,
  companionCheckinTurnId,
  extractTurnMetadata,
  type CompanionBriefDto,
  type CompanionCardDto,
  type CompanionItemDto,
  type CompanionItemSubtype,
} from 'michi-shared';
import type {
  PostSelfMessageArgs,
  PostSelfMessageResult,
  SettledTurnStatus,
  StartedRequestedSelfTurn,
  StartRequestedSelfTurnArgs,
} from '../../agents/chatHub';
import { isMetaAgentGuardError } from '../../agents/metaAgentGuard';
import type { AgentSession } from '../../agents/types';
import { resolveAssistantBinding } from '../../assistant/binding';
import { currentAssistantNodeId, ensureAssistant } from '../../assistant/store';
import { LOCAL_AGENT_OWNER_ID } from '../agentOwner';
import type { EphemeralDiscardResult, EphemeralSessionRecord } from '../chatManager';
import { getDb } from '../db';
import { getWorkspace } from '../dbRepository';
import { log } from '../logger';
import { stripSentinelsStreamingSafe } from '../messageSerialization';
import { recordUntrustedSource } from '../turnTrust';
import { settleAbandonedStarts } from './cards';
import { checkinMemoryHolds, createCheckinNode, purgeCheckinNode, startCheckinMemory, type CheckinNode } from './checkinNode';
import { checkinWritesOf, forgetCheckinWrites } from './checkinWrites';
import { atLocalClock, localDateKey, systemCompanionClock } from './clock';
import type { CompanionEventBus } from './delivery';
import { CompanionCheckinWithdrawn, checkinRunChanges, mergeCheckinChanges, postCompanionMessage } from './posts';
import { composeCompanionTurn, type CompanionItemFeedback } from './prompts';
import {
  COMPANION_NATIVE_KEPT_NOTE,
  COMPANION_OWNER,
  briefForDate,
  cardDto,
  getCompanionMetaNumber,
  getItem,
  isCompanionItemHidden,
  isCompanionItemSubtype,
  listDemotedSubtypes,
  listPendingCards,
  listUnreportedCards,
  markCardsReported,
  markRunDiscarded,
  markRunNativeKept,
  readCompanionRules,
  recordRunSession,
  setRunReplyChars,
  userWroteInConversation,
} from './repository';
import { companionSourcesOff, getCompanionSettings } from './settings';
import { beginCompanionHiddenTurn, endCompanionHiddenTurn } from './tools';
import { recentConversationExcerpt } from './turnContext';
import type {
  CompanionClock,
  CompanionMessageNotifier,
  CompanionTurnOutcome,
  CompanionTurnRequest,
  CompanionTurnRunner,
} from './types';

/** The slice of ChatHub a check-in needs. */
export interface CompanionTurnChatHub {
  startRequestedSelfTurn(args: StartRequestedSelfTurnArgs): Promise<StartedRequestedSelfTurn>;
  requestedTurnStatus(turnId: string): 'active' | 'completed' | 'cancelled' | 'error' | null;
  cancel(chatId: string, requestedTurnId?: string): boolean;
  isActive(chatId: string): boolean;
  isOwnerTurnActive(chatId: string): boolean;
  hasPendingSelfTurn(chatId: string): boolean;
  postSelfMessage(args: PostSelfMessageArgs): Promise<PostSelfMessageResult>;
  whenTurnSettled(turnId: string): Promise<SettledTurnStatus | null>;
}

/** The slice of ChatManager a check-in needs: S's one ephemeral session. */
export interface CompanionTurnChatManager {
  openEphemeralSession(input: { ownerUserId: string; workspaceId: string; nodeId: string }): Promise<AgentSession>;
  discardEphemeralSession(input: { ownerUserId: string; nodeId: string; recorded?: EphemeralSessionRecord }): Promise<EphemeralDiscardResult>;
}

/** The conversation V: the assistant's current one, which the user talks in and the check-ins post into. */
export interface CompanionConversationRef {
  workspaceId: string;
  nodeId: string;
}

export interface CompanionTurnRunnerDeps {
  chatHub: CompanionTurnChatHub;
  chatManager: CompanionTurnChatManager;
  /** The single notification gate (delivery.ts); hears every post. */
  notifier?: CompanionMessageNotifier | null;
  /** Change events after a post (default: the process's companionEvents). */
  events?: Pick<CompanionEventBus, 'emitChanged'>;
  clock?: CompanionClock;
  /** A check-in still running after this long is cancelled (default COMPANION_LIMITS.hiddenTurnTimeoutMs). */
  timeoutMs?: number;
  /** How long preempt() waits for the check-in to stop (default 5 s). */
  preemptWaitMs?: number;
  /** How long a stopped check-in's turn may take to wind down before its session is discarded (default 5 s). */
  settleWaitMs?: number;
  /** V, created on first use (default assistant/store ensureAssistant). */
  ensureConversation?: () => CompanionConversationRef;
  /** V's node, or null before it exists (default assistant/store currentAssistantNodeId). */
  currentNodeId?: () => string | null;
  /** A persisted message and the chips its turn left (default: the messages table, and the node's follow_ups chatHub stores from it). */
  readMessage?: (nodeId: string, messageId: string) => { content: string; followUps?: string[] } | null;
  /** Why a durable turn failed (default: the turns table). */
  turnError?: (turnId: string) => string | null;
  /** What discarding S's native record needs once S's row is gone (default: its binding row and cwd). */
  sessionRecord?: (nodeId: string, session: AgentSession) => EphemeralSessionRecord | null;
}

/** A check-in's chat turn id in its node (`cmp-<runId>`). */
export const companionTurnId = companionCheckinTurnId;

const PREEMPT_WAIT_MS = 5_000;
const SETTLE_WAIT_MS = 5_000;
const MESSAGE_TEXT_CHARS = 200;
/** How much of the text a quiet check-in also wrote its Activity detail keeps. */
const STRAY_TEXT_CHARS = 120;
/** The note on a run whose runtime would not remove its native record (`unsupported`): it is not gone, and retrying does not help (D11). */
export { COMPANION_NATIVE_KEPT_NOTE };
/** The note on a run whose turn was still running after it was stopped: its receipt waits for it to end. */
export const COMPANION_STILL_RUNNING_NOTE = 'It was still running when stopped; what it changed is posted once it ends';
/** The detail of a run whose result was withdrawn (D5): nothing of its own posted, what it changed undone. */
export const COMPANION_WITHDRAWN_NOTE = 'Withdrawn: Michi Memory changed while it ran';

/**
 * Check-ins whose turn would not stop in time, by run id: this process still
 * waits for each to end before it posts its receipt and lets S go
 * (G1a-review #6). Boot cleanup leaves them alone (cleanup.ts).
 */
const windingDown = new Set<string>();

/** This process still waits for check-in run `runId`'s turn to end before it posts what it changed and purges S. */
export function isCheckinWindingDown(runId: string): boolean {
  return windingDown.has(runId);
}

/** The outcome with `note` after its detail. */
function withNote(outcome: CompanionTurnOutcome, note: string): CompanionTurnOutcome {
  return { ...outcome, detail: outcome.detail ? `${outcome.detail} · ${note}` : note };
}

/** `text` on one line, cut to `max` characters with an ellipsis. */
function clipped(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

function defaultConversation(): CompanionConversationRef {
  const info = ensureAssistant();
  return { workspaceId: info.workspaceId, nodeId: info.nodeId };
}

function defaultReadMessage(nodeId: string, messageId: string): { content: string; followUps?: string[] } | null {
  const row = getDb().prepare('SELECT content FROM messages WHERE id = ? AND node_id = ?').get(messageId, nodeId) as { content: string | null } | undefined;
  if (!row) return null;
  return { content: row.content ?? '', followUps: storedFollowUps(nodeId, messageId) };
}

/** The chips chatHub took from a finished reply (its finalize stores them on the node, out of the text). */
export function storedFollowUps(nodeId: string, messageId: string): string[] {
  const row = getDb().prepare('SELECT follow_ups FROM nodes WHERE id = ? AND follow_ups_source_message_id = ?').get(nodeId, messageId) as { follow_ups: string | null } | undefined;
  if (!row?.follow_ups) return [];
  try {
    const parsed: unknown = JSON.parse(row.follow_ups);
    return Array.isArray(parsed) ? parsed.filter((label): label is string => typeof label === 'string' && label.trim() !== '') : [];
  } catch {
    return [];
  }
}

function defaultTurnError(turnId: string): string | null {
  const row = getDb().prepare('SELECT error FROM turns WHERE turn_id = ?').get(turnId) as { error: string | null } | undefined;
  return row?.error ?? null;
}

/** S's binding as it opened: the runtime, native id and cwd, so a restart can discard the native record without S's row. */
function defaultSessionRecord(nodeId: string, session: AgentSession): EphemeralSessionRecord | null {
  const row = getDb().prepare('SELECT runtime_id, acp_session_id FROM nodes WHERE id = ?').get(nodeId) as { runtime_id: string | null; acp_session_id: string | null } | undefined;
  let binding: ReturnType<typeof resolveAssistantBinding> = null;
  try {
    binding = resolveAssistantBinding(nodeId);
  } catch {
    binding = null;
  }
  const cwd = binding?.sessionOptions.cwd;
  if (!cwd) return null;
  return {
    runtimeId: row?.runtime_id ?? session.runtimeId,
    nativeSessionId: row?.acp_session_id ?? session.nativeSessionId ?? null,
    cwd,
    profileHash: session.runtimeProfileHash ?? binding?.profileHash ?? null,
  };
}

/** What the user sees of a reply: its text without Michi's sentinels. */
function visibleText(content: string): string {
  return stripSentinelsStreamingSafe(content).trim();
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function sessionFailure(error: unknown): string {
  return isMetaAgentGuardError(error)
    ? `The check-in did not run: its session offered tools outside its allow-list (${message(error)})`
    : `The check-in's session could not open: ${message(error)}`;
}

interface ActiveTurn {
  turnId: string;
  /** Set once a session is open: from then on a stop cancels the chat turn. */
  chatId: string | null;
  stop: 'timeout' | 'preempt' | null;
  /** Resolves on the first stop. */
  stopped: Promise<void>;
  signalStop(): void;
  /** Resolves when run() returns. */
  finished: Promise<void>;
  markFinished(): void;
}

function newActiveTurn(turnId: string): ActiveTurn {
  let signalStop!: () => void;
  let markFinished!: () => void;
  const stopped = new Promise<void>((resolve) => { signalStop = resolve; });
  const finished = new Promise<void>((resolve) => { markFinished = resolve; });
  return { turnId, chatId: null, stop: null, stopped, signalStop, finished, markFinished };
}

type Raced<T> = { kind: 'value'; value: T } | { kind: 'error'; error: unknown } | { kind: 'stopped' };

/** The promise's settlement, or the turn's stop, whichever comes first. */
function raceStop<T>(promise: Promise<T>, turn: ActiveTurn): Promise<Raced<T>> {
  return Promise.race<Raced<T>>([
    promise.then((value) => ({ kind: 'value' as const, value }), (error: unknown) => ({ kind: 'error' as const, error })),
    turn.stopped.then(() => ({ kind: 'stopped' as const })),
  ]);
}

async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([promise.then(() => {}, () => {}), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); timer.unref?.(); })]);
  if (timer) clearTimeout(timer);
}

/**
 * Items the note names that are not open any more (resolved, dismissed):
 * those of its changes, and `alsoIds` (earlier brief cards'). Never one out
 * of sight (its source is off, B15): the note reads it as an unknown item.
 */
function otherItemsOf(request: CompanionTurnRequest, alsoIds: readonly string[] = []): Map<string, CompanionItemDto> {
  const open = new Set(request.material.open.map((item) => item.id));
  const others = new Map<string, CompanionItemDto>();
  for (const id of [...request.material.changes.map((event) => event.itemId), ...alsoIds]) {
    if (open.has(id) || others.has(id)) continue;
    const item = getItem(id);
    if (item && !isCompanionItemHidden(item)) others.set(item.id, item);
  }
  return others;
}

/** How many days back a brief looks for the briefs before it and the user's thumbs on them. */
const PAST_BRIEF_DAYS = 7;
/** How long a thumb counts in the brief's informational tally (conv-1). */
const FEEDBACK_TALLY_MS = 30 * 24 * 60 * 60_000;

/** The briefs of the days before `now`'s, newest first: each day's own when there is one, else Michi's fallback. */
function pastBriefs(now: number): CompanionBriefDto[] {
  const briefs: CompanionBriefDto[] = [];
  for (let days = 1; days <= PAST_BRIEF_DAYS; days += 1) {
    const brief = briefForDate(localDateKey(atLocalClock(now, '12:00', -days)));
    if (brief) briefs.push(brief);
  }
  return briefs;
}

/**
 * The user's thumbs by kind for the brief (conv-1), informational only: of
 * the last 30 days, on the version they rated, thumbs up and `too_noisy`
 * (counted from the subtype's last demotion undo, as the demotion counts
 * them). Never already_handled, not_relevant, too_early or too_late: those
 * are about one item or one version (R2.7), not a kind; the deterministic
 * demotion stays the only kind-level rule.
 */
function itemFeedbackByKind(now: number): CompanionItemFeedback[] {
  const rows = getDb().prepare(`SELECT subtype, feedback, feedback_reason AS reason, feedback_at AS at FROM companion_items
      WHERE owner_user_id = ? AND (feedback = 'up' OR (feedback = 'down' AND feedback_reason = 'too_noisy'))
        AND feedback_version = version AND COALESCE(feedback_at, 0) >= ?`)
    .all(COMPANION_OWNER, now - FEEDBACK_TALLY_MS) as Array<{ subtype: string; feedback: string; reason: string | null; at: number | null }>;
  const kinds = new Map<CompanionItemSubtype, { up: number; down: number; reasons: Record<string, number> }>();
  for (const row of rows) {
    if (!isCompanionItemSubtype(row.subtype)) continue;
    if (row.feedback === 'down' && (row.at ?? 0) <= (getCompanionMetaNumber(`companion:noisy_reset:${row.subtype}`) ?? -1)) continue;
    const kind = kinds.get(row.subtype) ?? { up: 0, down: 0, reasons: {} };
    if (row.feedback === 'up') kind.up += 1;
    else {
      kind.down += 1;
      kind.reasons.too_noisy = (kind.reasons.too_noisy ?? 0) + 1;
    }
    kinds.set(row.subtype, kind);
  }
  return [...kinds].sort(([a], [b]) => a.localeCompare(b)).map(([subtype, kind]) => ({ subtype, ...kind }));
}

function workspaceNamesOf(request: CompanionTurnRequest): Map<string, string> {
  const names = new Map<string, string>();
  for (const report of request.material.reports) {
    const id = report.delegation.workspaceId;
    const name = names.has(id) ? null : getWorkspace(id)?.name;
    if (name) names.set(id, name);
  }
  return names;
}

/** The items a check-in's material was about: the notification gate judges its post by them. */
function itemIdsOf(request: CompanionTurnRequest): string[] {
  return [...new Set(request.material.changes.filter((event) => event.kind !== 'baseline').map((event) => event.itemId))];
}

/** How a check-in's turn ended, before anything is posted: the outcome and, when it spoke, its visible reply and chips. */
interface TurnResult {
  outcome: CompanionTurnOutcome;
  reply: string | null;
  followUps?: string[];
}

export function createCompanionTurnRunner(deps: CompanionTurnRunnerDeps): CompanionTurnRunner {
  const clock = deps.clock ?? systemCompanionClock;
  const timeoutMs = deps.timeoutMs ?? COMPANION_LIMITS.hiddenTurnTimeoutMs;
  const preemptWaitMs = deps.preemptWaitMs ?? PREEMPT_WAIT_MS;
  const settleWaitMs = deps.settleWaitMs ?? SETTLE_WAIT_MS;
  const ensureConversation = deps.ensureConversation ?? defaultConversation;
  const currentNodeId = deps.currentNodeId ?? currentAssistantNodeId;
  const readMessage = deps.readMessage ?? defaultReadMessage;
  const turnError = deps.turnError ?? defaultTurnError;
  const sessionRecord = deps.sessionRecord ?? defaultSessionRecord;
  let active: ActiveTurn | null = null;

  const busy = (nodeId: string) => deps.chatHub.isActive(nodeId) || deps.chatHub.isOwnerTurnActive(nodeId) || deps.chatHub.hasPendingSelfTurn(nodeId);

  function stopTurn(turn: ActiveTurn, reason: 'timeout' | 'preempt'): void {
    if (turn.stop) return;
    turn.stop = reason;
    if (turn.chatId) {
      // A turn still queued keeps the id reserved as cancelled, so it ends the moment it begins.
      try { deps.chatHub.cancel(turn.chatId, turn.turnId); } catch (error) {
        log.warn('chat', 'companion check-in cancel failed', { turnId: turn.turnId, error: message(error) });
      }
    }
    turn.signalStop();
  }

  function stoppedResult(turn: ActiveTurn, turnId?: string): TurnResult {
    const ids = turnId ? { turnId } : {};
    if (turn.stop === 'preempt') return { outcome: { outcome: 'preempted', detail: 'The user started typing; this waits for the next check-in', ...ids }, reply: null };
    return { outcome: { outcome: 'error', detail: `Stopped: it ran longer than ${Math.round(timeoutMs / 60_000) || 1} min`, ...ids }, reply: null };
  }

  /**
   * A completed turn is quiet when it ended with an accepted nothing_to_do,
   * or when nothing visible is left of its reply (sentinels and whitespace
   * aside); it spoke otherwise. A narrated "Let me check CR-1 first." around
   * the call is not a message for the user; a clipped copy of such stray
   * text stays in the Activity detail.
   */
  function completedResult(request: CompanionTurnRequest, nodeId: string, turnId: string, messageId: string): TurnResult {
    const { quietNote, quietEnd } = endCompanionHiddenTurn(turnId);
    const status = deps.chatHub.requestedTurnStatus(turnId);
    if (status === 'error') return { outcome: { outcome: 'error', detail: turnError(turnId) || 'The runtime reported an error', turnId }, reply: null };
    if (status === 'cancelled') return { outcome: { outcome: 'preempted', detail: 'Stopped before it finished', turnId }, reply: null };
    if (status !== 'completed') return { outcome: { outcome: 'error', detail: 'The turn ended without a result', turnId }, reply: null };
    const stored = readMessage(nodeId, messageId);
    const visible = stored ? visibleText(stored.content) : '';
    if (!visible || quietEnd) {
      const reason = quietNote ? `Quiet: ${quietNote}` : 'Nothing worth a message';
      if (!visible) return { outcome: { outcome: 'quiet', detail: reason, turnId }, reply: null };
      log.warn('chat', 'companion quiet check-in also wrote text; it is not posted', { runId: request.runId, kind: request.kind, chars: visible.length });
      return { outcome: { outcome: 'quiet', detail: `${reason} · it also wrote: "${clipped(visible, STRAY_TEXT_CHARS)}"`, turnId }, reply: null };
    }
    return {
      outcome: { outcome: 'spoke', messageText: Array.from(visible).slice(0, MESSAGE_TEXT_CHARS).join(''), turnId },
      reply: visible,
      // Stored apart from the text once chatHub finalized it; still in it otherwise.
      followUps: stored!.followUps?.length ? stored!.followUps : extractTurnMetadata(stored!.content).followUps ?? [],
    };
  }

  /** Marks the note's card results reported, and S's turn as one that read collector material. */
  function delivered(cards: readonly CompanionCardDto[], nodeId: string, turnId: string, runtimeId: string): void {
    try {
      markCardsReported(cards.map((card) => card.id), clock.now());
    } catch (error) {
      log.warn('chat', 'companion card results not marked reported', { turnId, error: message(error) });
    }
    try {
      recordUntrustedSource({ nodeId, turnId }, { tool: 'companion_note', runtimeId, detail: 'collector material in a check-in note' });
    } catch (error) {
      log.warn('chat', 'companion turn trust record failed', { turnId, error: message(error) });
    }
  }

  /** Steps 3-7: S's session, the note, the turn and how it ended. */
  async function converse(request: CompanionTurnRequest, turn: ActiveTurn, node: CheckinNode, conversation: CompanionConversationRef): Promise<TurnResult> {
    const opened = await raceStop(deps.chatManager.openEphemeralSession({
      ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: node.workspaceId, nodeId: node.nodeId,
    }), turn);
    if (opened.kind === 'stopped') return stoppedResult(turn);
    if (opened.kind === 'error') return { outcome: { outcome: 'error', detail: sessionFailure(opened.error) }, reply: null };
    const session = opened.value;
    try {
      const record = sessionRecord(node.nodeId, session);
      if (record) recordRunSession(request.runId, { ...record, profileHash: record.profileHash ?? null });
    } catch (error) {
      log.warn('chat', 'companion check-in session not recorded', { runId: request.runId, error: message(error) });
    }

    // A conversation a stopped Michi left starting has its card failed now, so this check-in or the next is told.
    try {
      settleAbandonedStarts(clock.now());
    } catch (error) {
      log.warn('chat', 'companion abandoned conversation starts not settled', { error: message(error) });
    }
    const cardResults = request.material.cardResults.length > 0 ? request.material.cardResults : listUnreportedCards().map(cardDto);
    const brief = request.kind === 'brief';
    // The brief learns from the briefs before it: the user's thumbs on their cards and on items of each kind.
    const briefs = brief ? pastBriefs(request.material.now) : [];
    const settings = getCompanionSettings();
    const text = composeCompanionTurn({
      kind: request.kind,
      material: { ...request.material, cardResults },
      otherItems: otherItemsOf(request, briefs.flatMap((past) => past.cards.flatMap((card) => card.itemIds))),
      heartbeatMinutes: settings.heartbeat.intervalMinutes,
      // §3.6: what the user and the agent said in V lately (their words and its replies only); conv-3: what Michi does not watch.
      recentConversation: recentConversationExcerpt(conversation.nodeId),
      offSources: companionSourcesOff(settings),
      demotedSubtypes: brief ? listDemotedSubtypes() : [],
      workspaceNames: workspaceNamesOf(request),
      pastBriefs: briefs,
      itemFeedback: brief ? itemFeedbackByKind(request.material.now) : [],
      waitingCards: listPendingCards(request.material.now).map(cardDto),
    });
    let memoryContext: string | null;
    try {
      memoryContext = startCheckinMemory(request.runId);
    } catch (error) {
      return { outcome: { outcome: 'error', detail: `Michi Memory could not be read, so the check-in did not run: ${message(error)}` }, reply: null };
    }
    if (turn.stop) return stoppedResult(turn);
    turn.chatId = session.id;
    beginCompanionHiddenTurn(turn.turnId, { kind: request.kind, runId: request.runId });
    const starting = deps.chatHub.startRequestedSelfTurn({
      chatId: session.id,
      nodeId: node.nodeId,
      ownerUserId: null,
      turnId: turn.turnId,
      text,
      session,
      // No window ever sees a check-in (§3.1 step 5).
      private: true,
      memoryContext,
    });
    starting.then((started) => { started.done.catch(() => {}); }, () => {});

    const began = await raceStop(starting, turn);
    if (began.kind === 'stopped') return stoppedResult(turn, turn.turnId);
    if (began.kind === 'error') return { outcome: { outcome: 'error', detail: `The turn could not start: ${message(began.error)}`, turnId: turn.turnId }, reply: null };
    const started = began.value;
    // chatHub already had this turn: it was handled, and has nothing to report again.
    if (started.existing) return { outcome: { outcome: 'skipped', detail: 'Already handled', turnId: started.turnId }, reply: null };
    delivered(cardResults, node.nodeId, started.turnId, session.runtimeId);

    const ended = await raceStop(started.done, turn);
    if (ended.kind === 'stopped') return stoppedResult(turn, started.turnId);
    return completedResult(request, node.nodeId, started.turnId, started.assistantId);
  }

  /**
   * Step 8: what the check-in leaves in V. Its reply when it spoke and the
   * user has not written since it began; Michi's receipt whenever it changed
   * the user's things and has no reply to post (quiet, superseded, stopped or
   * failed: "stopped early"). Neither, its changes undone, once what its
   * memory pack showed no longer holds, only the receipt of a follow-up it
   * sent itself, which cannot be taken back; a quiet one's silence is
   * withdrawn then too, so its material waits for the next check-in (an
   * error run: COMPANION_WITHDRAWN_NOTE).
   */
  async function settle(request: CompanionTurnRequest, conversation: CompanionConversationRef, result: TurnResult, startedAt: number): Promise<CompanionTurnOutcome> {
    if (result.outcome.outcome === 'skipped') return result.outcome;
    const withdrawn: CompanionTurnOutcome = { outcome: 'error', detail: COMPANION_WITHDRAWN_NOTE, turnId: result.outcome.turnId };
    let outcome: CompanionTurnOutcome = result.outcome;
    let reply = result.reply;
    let changes: ReturnType<typeof checkinRunChanges> = [];
    try {
      changes = mergeCheckinChanges(checkinRunChanges(request.runId, startedAt), checkinWritesOf(companionTurnId(request.runId)));
    } catch (error) {
      log.warn('chat', 'companion check-in changes not read', { runId: request.runId, error: message(error) });
    }
    if (reply !== null && userWroteInConversation(conversation.nodeId, startedAt)) {
      // The user went first (§3.3): the reply is not posted, and only its length is kept.
      const chars = Array.from(reply).length;
      setRunReplyChars(request.runId, chars);
      outcome = { outcome: 'superseded', detail: `Your message came first, so its reply (${chars} characters) was not posted`, turnId: outcome.turnId };
      reply = null;
    }
    const stoppedEarly = outcome.outcome === 'error' || outcome.outcome === 'preempted';
    if (reply === null && changes.length === 0) return outcome.outcome === 'quiet' && !checkinMemoryHolds(request.runId) ? withdrawn : outcome;
    try {
      const post = await postCompanionMessage({
        runId: request.runId, kind: request.kind, nodeId: conversation.nodeId, text: reply, changes, stoppedEarly, itemIds: itemIdsOf(request),
        ...(reply !== null && result.followUps?.length ? { followUps: result.followUps } : {}),
      }, { chatHub: deps.chatHub, clock, notifier: deps.notifier, events: deps.events });
      return post ? { ...outcome, postedMessageId: post.messageId } : outcome;
    } catch (error) {
      if (error instanceof CompanionCheckinWithdrawn) return withdrawn;
      log.warn('chat', 'companion check-in not posted', { runId: request.runId, kind: request.kind, error: message(error) });
      return { outcome: 'error', detail: `${outcome.detail ? `${outcome.detail} · ` : ''}Its message could not be posted: ${message(error)}`, turnId: outcome.turnId };
    }
  }

  /**
   * Step 9: S's session and native record go, then S. A runtime still letting
   * go of S gets settleWaitMs first; one that holds on (`busy`) leaves S as
   * it is, for boot cleanup. S is purged before the run records its native
   * record as gone, so a purge that fails leaves the run to boot cleanup
   * (G1a-review #5). `deferred` purges S but leaves the run pending: its
   * native record is not known to be gone; `unsupported` is final, the run
   * records that its runtime keeps it (D11). Returns the discard's answer.
   */
  async function cleanUp(request: CompanionTurnRequest, turn: ActiveTurn, node: CheckinNode): Promise<EphemeralDiscardResult> {
    if (busy(node.nodeId)) await within(deps.chatHub.whenTurnSettled(turn.turnId), settleWaitMs);
    let result: EphemeralDiscardResult;
    try {
      result = await deps.chatManager.discardEphemeralSession({ ownerUserId: LOCAL_AGENT_OWNER_ID, nodeId: node.nodeId });
    } catch (error) {
      log.warn('chat', 'companion check-in session not discarded', { runId: request.runId, error: message(error) });
      result = 'deferred';
    }
    if (result === 'busy') {
      log.warn('chat', 'companion check-in still running at cleanup: left for the next start', { runId: request.runId });
      return result;
    }
    try {
      purgeCheckinNode(node.nodeId);
      if (result === 'discarded' || result === 'absent') markRunDiscarded(request.runId, clock.now());
      else if (result === 'unsupported') markRunNativeKept(request.runId, clock.now());
    } catch (error) {
      log.warn('chat', 'companion check-in node not purged', { runId: request.runId, error: message(error) });
    }
    return result;
  }

  /**
   * A stopped check-in's turn may still be running (it ignored the cancel):
   * it gets settleWaitMs to end. True when it still runs after that.
   */
  async function stillRunning(turn: ActiveTurn): Promise<boolean> {
    if (deps.chatHub.requestedTurnStatus(turn.turnId) !== 'active') return false;
    await within(deps.chatHub.whenTurnSettled(turn.turnId), settleWaitMs);
    return deps.chatHub.requestedTurnStatus(turn.turnId) === 'active';
  }

  /**
   * A check-in whose turn would not stop in time (G1a-review #6): its run
   * ends now, but what it changed is read and posted only once the turn
   * ended (chatHub force-finishes a stuck turn after its cancel timeout, and
   * no page write passes without a running turn), so the receipt lists every
   * write; then S goes. A restart meanwhile leaves it to boot cleanup
   * (cleanup.ts: a run whose S is still there and that never posted).
   */
  function windDownLater(request: CompanionTurnRequest, conversation: CompanionConversationRef, turn: ActiveTurn, node: CheckinNode, startedAt: number): void {
    windingDown.add(request.runId);
    void (async () => {
      try {
        await deps.chatHub.whenTurnSettled(turn.turnId);
        endCompanionHiddenTurn(turn.turnId);
        await settle(request, conversation, { outcome: { outcome: 'error', detail: 'Stopped', turnId: turn.turnId }, reply: null }, startedAt);
      } catch (error) {
        log.warn('chat', 'companion check-in that would not stop not settled', { runId: request.runId, error: message(error) });
      } finally {
        endCompanionHiddenTurn(turn.turnId);
        forgetCheckinWrites(turn.turnId);
        try {
          await cleanUp(request, turn, node);
        } catch (error) {
          log.warn('chat', 'companion check-in that would not stop not cleaned up', { runId: request.runId, error: message(error) });
        }
        windingDown.delete(request.runId);
      }
    })();
  }

  async function runCheckin(request: CompanionTurnRequest, turn: ActiveTurn): Promise<CompanionTurnOutcome> {
    const startedAt = clock.now();
    // The user's rules outrank everything in the note; unreadable, nothing runs (fail closed).
    const rules = readCompanionRules();
    if (!rules.ok) return { outcome: 'error', detail: 'The user\'s rules could not be read, so the check-in did not run' };
    const conversation = ensureConversation();
    if (busy(conversation.nodeId)) return { outcome: 'skipped', detail: 'The conversation is busy' };
    let node: CheckinNode;
    try {
      node = createCheckinNode(request.runId, conversation.workspaceId, startedAt);
    } catch (error) {
      return { outcome: 'error', detail: `The check-in could not start: ${message(error)}` };
    }
    let outcome!: CompanionTurnOutcome;
    let discard: EphemeralDiscardResult | null = null;
    let lingering = false;
    try {
      const result = await converse({ ...request, material: { ...request.material, rules: rules.rules } }, turn, node, conversation);
      // A stopped turn still running would write after its receipt was read: its post waits for its end (G1a-review #6).
      lingering = await stillRunning(turn);
      outcome = lingering ? withNote(result.outcome, COMPANION_STILL_RUNNING_NOTE) : await settle(request, conversation, result, startedAt);
    } finally {
      if (lingering) {
        windDownLater(request, conversation, turn, node, startedAt);
      } else {
        endCompanionHiddenTurn(turn.turnId);
        forgetCheckinWrites(turn.turnId);
        discard = await cleanUp(request, turn, node);
      }
    }
    // In the outcome, not on the run: the coordinator's finishRun writes the run's detail from it.
    return discard === 'unsupported' ? withNote(outcome, COMPANION_NATIVE_KEPT_NOTE) : outcome;
  }

  return {
    isIdle() {
      if (active) return false;
      try {
        const nodeId = currentNodeId();
        return nodeId === null || !busy(nodeId);
      } catch {
        return false;
      }
    },

    async run(request) {
      if (request.kind === 'catch_up') return { outcome: 'skipped', detail: 'The catch-up is deterministic: no model turn runs for it' };
      if (active) return { outcome: 'skipped', detail: 'Another check-in is running' };
      const turn = newActiveTurn(companionTurnId(request.runId));
      active = turn;
      const timer = setTimeout(() => stopTurn(turn, 'timeout'), timeoutMs);
      timer.unref?.();
      try {
        return await runCheckin(request, turn);
      } catch (error) {
        log.warn('chat', 'companion check-in failed', { runId: request.runId, kind: request.kind, error: message(error) });
        return { outcome: 'error', detail: message(error) };
      } finally {
        clearTimeout(timer);
        if (active === turn) active = null;
        turn.markFinished();
      }
    },

    async preempt() {
      const turn = active;
      if (!turn) return;
      stopTurn(turn, 'preempt');
      await within(turn.finished, preemptWaitMs);
    },
  };
}
