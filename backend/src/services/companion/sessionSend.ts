/**
 * session_send (DESIGN-v2 §4): the agent's follow-ups into the conversations
 * it started and still follows. One module decides whether a follow-up may
 * go out and delivers it, for all three ways one goes out:
 *
 * - `user`: companion_session_send in the user's own turn (tools.ts), after
 *   the user approved its exact text, or with "Send, and stop asking" on for
 *   that conversation (never in a turn that read check-in material);
 * - `card`: the user applied a `session.send` card (cards.ts), the approval
 *   of its exact text, re-checked against what the card recorded;
 * - `checkin`: a check-in's own follow-up (DESIGN-v2 Q1), only into a
 *   conversation whose permission choice is exactly `ask`
 *   (companionCheckinMaySendDirectly), read right before the delivery, on a
 *   runtime whose approval gate Michi holds for a tainted turn
 *   (turnTrust.ts companionRuntimeGateAuthoritative: every non-read tool
 *   call reaches Michi's approval, whatever the user's runtime config
 *   pre-approves), checked on the node and again on the session it opens.
 *   Its `cms-` turn is recorded as check-in material (taint 'checkin')
 *   before the turn starts, so saved always-allow grants, session trust and
 *   send_to_thread ask too (w3-fix D15); when that record fails nothing is
 *   sent. Any other choice or runtime gets a card (tools.ts). Right before
 *   it goes, what the check-in's Michi Memory pack showed when it started
 *   must still hold (checkinNode.ts checkinMemoryHolds, D5): else WITHDRAWN.
 *
 * The target is a delegation the agent follows (companion_delegations,
 * `following`: never a conversation the user started, never one from before
 * v2), passing send_to_thread's assistant checks (threadMessageTool.ts
 * checkAssistantThreadTarget: started, not deleted or archived, AI
 * navigation on, no system workspace), not taken over by the user, and idle:
 * one waiting on the user (an approval or a question) or still running is
 * refused, never steered or queued. Each delegation takes
 * COMPANION_LIMITS.maxDailySendsPerDelegation follow-ups a local day.
 *
 * Each follow-up is a `send` run (outside the turn budget) whose turn in the
 * target is `cms-<runId>`; the target receives
 * formatCompanionThreadMessage's text (Michi's header, then the checked
 * body) with `threadMessage` from the agent's conversation and
 * `companionSend {runId, via}` on the user message, through the same steps as
 * send_to_thread (ensure the session, the restore lock, a requested turn).
 */

import {
  COMPANION_LIMITS,
  DEFAULT_COMPANION_NAME,
  chatPermissionChoice,
  checkCompanionSendText,
  companionCheckinMaySendDirectly,
  companionSendTurnId,
  formatCompanionThreadMessage,
  isWiderChatPermission,
  sanitizeThreadTitle,
  type ChatPermissionChoice,
  type CompanionSendVia,
  type DurableMessageMetadata,
} from 'michi-shared';
import { chatHub, type StartedRequestedSelfTurn } from '../../agents/chatHub';
import { checkAssistantThreadTarget, threadMessagingDeps, type ThreadMessagingDeps } from '../../agents/threadMessageTool';
import type { AgentSession } from '../../agents/types';
import { ensureAssistant } from '../../assistant/store';
import { resolveChatApproveForMe, resolveChatPermissionMode } from '../chatPermissions';
import { getWorkspace, type NodeRow } from '../dbRepository';
import { log } from '../logger';
import { serverLiveWait, type HomeLiveWait } from '../pages/homeSections';
import { companionRuntimeGateAuthoritative, recordCompanionTaint } from '../turnTrust';
import { recordPassedOutsideContent } from '../turnGuard';
import { CHECKIN_WITHDRAWN_MESSAGE, checkinMemoryHolds } from './checkinNode';
import { localDayStart } from './clock';
import {
  closeDelegation,
  countDeliveredSends,
  finishRun,
  getFollowedDelegation,
  markDelegationSent,
  recordCheckinSend,
  startSendRun,
  type CompanionDelegation,
} from './repository';
import { getCompanionSettings } from './settings';
import { michiWorkerState } from './sources/michi';

// ── What the server wires (tests set fakes) ─────────────────────────────────

/**
 * Fakes for tests; production uses the defaults.
 * @testonly
 */
export interface CompanionSendDeps {
  /** How a thread's session opens and its turn starts (default: send_to_thread's boot wiring). */
  messaging?: ThreadMessagingDeps | null;
  /** A pending approval or question of the conversation's running turn (default: ChatHub's, through the Home's reader). */
  liveWait?: (nodeId: string) => HomeLiveWait | null;
  /** The conversation runs or is about to (default: ChatHub's live turns, queued self turns and the durable row). */
  busy?: (nodeId: string) => boolean;
  /**
   * Its permission choice now (chatPermissionChoice of its mode and Approve
   * for me), read for the conversation's owner; null when it cannot be read.
   */
  permission?: (nodeId: string, ownerUserId: string) => ChatPermissionChoice | null;
  /** Whether Michi holds the approval gate of a tainted turn on this runtime (default: turnTrust.ts companionRuntimeGateAuthoritative). */
  gateAuthoritative?: (runtimeId: string) => boolean;
  /** The agent's own conversation V, the follow-up's sender (default: ensureAssistant). */
  agent?: () => { workspaceId: string; nodeId: string };
}

let sendDeps: CompanionSendDeps = {};

/**
 * Tests set fakes; replaces what was set.
 * @testonly
 */
export function setCompanionSendDeps(deps: CompanionSendDeps): void {
  sendDeps = { ...deps };
}

function defaultBusy(nodeId: string): boolean {
  return chatHub.isActive(nodeId) || chatHub.isOwnerTurnActive(nodeId) || chatHub.hasPendingSelfTurn(nodeId);
}

/**
 * The conversation's choice as its owner's turns run it: with no owner, the
 * cloud's reader answers `ask` for any chat, which would let a check-in send
 * straight into one that runs more freely (G2-review suggestion 3).
 */
function defaultPermission(nodeId: string, ownerUserId: string): ChatPermissionChoice | null {
  try {
    return chatPermissionChoice(resolveChatPermissionMode(nodeId, ownerUserId), resolveChatApproveForMe(nodeId, ownerUserId));
  } catch {
    return null;
  }
}

const messaging = (): ThreadMessagingDeps | null => (sendDeps.messaging === undefined ? threadMessagingDeps() : sendDeps.messaging);
const liveWait = (nodeId: string) => (sendDeps.liveWait ?? serverLiveWait)(nodeId);
const permissionOf = (nodeId: string, ownerUserId: string) => (sendDeps.permission ?? defaultPermission)(nodeId, ownerUserId);

/** Michi holds the approval gate of a tainted turn on this runtime (D15); an unknown one never. */
function gateAuthoritative(runtimeId: string | null | undefined): boolean {
  if (typeof runtimeId !== 'string' || !runtimeId) return false;
  try {
    return (sendDeps.gateAuthoritative ?? companionRuntimeGateAuthoritative)(runtimeId) === true;
  } catch {
    return false;
  }
}

function agentConversation(): { workspaceId: string; nodeId: string } {
  if (sendDeps.agent) return sendDeps.agent();
  const agent = ensureAssistant();
  return { workspaceId: agent.workspaceId, nodeId: agent.nodeId };
}

function agentName(): string {
  try {
    return getCompanionSettings().displayName || DEFAULT_COMPANION_NAME;
  } catch {
    return DEFAULT_COMPANION_NAME;
  }
}

// ── Refusals ────────────────────────────────────────────────────────────────

/**
 * Why a follow-up does not go out. The codes besides these are send_to_thread's
 * target checks' (NOT_FOUND, READ_ONLY, NOT_STARTED, INVALID_TARGET,
 * NAVIGATION_DISABLED, …), passed through.
 */
type CompanionSendRefusalCode =
  | 'NOT_FOLLOWED'
  | 'TAKEN_OVER'
  | 'TARGET_GONE'
  | 'TARGET_WAITING_ON_USER'
  | 'TARGET_BUSY'
  | 'DAILY_LIMIT'
  | 'INVALID_TEXT'
  | 'MOVED_ON'
  | 'PERMISSION_WIDER'
  | 'NOT_ASK'
  | 'GATE_NOT_HELD'
  | 'TAINT_UNRECORDED'
  | 'WITHDRAWN'
  | 'UNAVAILABLE'
  | (string & {});

/**
 * A check-in's direct send that does not go out for one of these is
 * proposed as a session.send card instead (Q1, D15): the conversation runs
 * more freely than Ask, on a runtime whose gate Michi does not hold for a
 * tainted turn, or its turn could not be recorded as check-in material.
 */
export const COMPANION_SEND_CARD_INSTEAD: ReadonlySet<string> = new Set(['NOT_ASK', 'GATE_NOT_HELD', 'TAINT_UNRECORDED']);

/** A follow-up that does not go out, with a message for the agent (a tool error) or the user (a failed card). */
export class CompanionSendRefusal extends Error {
  constructor(readonly code: CompanionSendRefusalCode, message: string) {
    super(message);
    this.name = 'CompanionSendRefusal';
  }
}

const refuse = (code: CompanionSendRefusalCode, message: string): never => { throw new CompanionSendRefusal(code, message); };

/** What a permission choice means for the tools of the conversation that gets the follow-up, as one sentence (approval questions). */
export function companionTargetPermissionLine(choice: ChatPermissionChoice | null): string {
  switch (choice) {
    case 'ask':
      return 'It runs in Ask: its tools ask you before they run.';
    case 'approve':
      return 'It runs in Ask with Approve for me: its classifier approves some tools without asking you.';
    case 'trust':
      return 'It runs in Trust: its tools run without asking.';
    case 'yolo':
      return 'It runs in YOLO: everything it does runs without asking.';
    default:
      return 'Michi could not read how it runs, so treat it as running without asking.';
  }
}

const CHOICE_LABEL: Record<ChatPermissionChoice, string> = { ask: 'Ask', approve: 'Ask with Approve for me', trust: 'Trust', yolo: 'YOLO' };

/**
 * Why a follow-up asks although the user chose "Send, and stop asking" for
 * its conversation (w3-fix D22): it now runs more freely than when they
 * chose it, or Michi cannot read how it runs. Null when it may go without
 * asking: the choice in effect is no wider than the one stored with it.
 */
export function companionAutoSendAskReason(stored: ChatPermissionChoice | null, now: ChatPermissionChoice | null): string | null {
  if (now === null) return 'Michi could not read how that conversation runs now, so it asks even though you said to stop asking for it.';
  if (stored === null || isWiderChatPermission(now, stored)) {
    return `It runs in ${CHOICE_LABEL[now]} now, more freely than${stored ? ` in ${CHOICE_LABEL[stored]}` : ''} when you said to stop asking, so Michi asks again.`;
  }
  return null;
}

// ── The target ──────────────────────────────────────────────────────────────

/** A conversation a follow-up may go into, as Michi read it now. */
interface CompanionSendTarget {
  delegation: CompanionDelegation;
  node: NodeRow;
  ownerUserId: string;
  workspaceId: string;
  workspaceName: string;
  /** One line (sanitizeThreadTitle). */
  title: string;
  /** Its permission choice now; null when Michi cannot read it (every check then fails closed). */
  permission: ChatPermissionChoice | null;
  /** The runtime its node runs on; null when none is recorded (a check-in then sends no follow-up itself). */
  runtimeId: string | null;
  /** Its latest turn's reply (the card's afterMessageId); null when none. */
  latestReplyId: string | null;
}

interface CompanionSendCaller {
  ownerUserId: string | null;
  /** The agent's own workspace and conversation (V). */
  workspaceId: string;
  nodeId: string;
}

/**
 * The delegated conversation `nodeId` as a follow-up target (DESIGN-v2 §4),
 * whatever its state: followed, passing the assistant target checks and not
 * taken over (one the user wrote in, or that went, is closed on the way).
 * Throws CompanionSendRefusal.
 */
export function companionSendTarget(nodeId: string, now: number, caller: CompanionSendCaller = { ownerUserId: null, ...agentConversation() }): CompanionSendTarget {
  const delegation = getFollowedDelegation(nodeId);
  if (!delegation) {
    refuse('NOT_FOLLOWED', `${agentName()} only sends follow-ups to a conversation it started and still follows; this is not one. Link it and let the user write there.`);
  }
  const checked = checkAssistantThreadTarget(caller, nodeId);
  if (!checked.ok) {
    if (checked.code === 'NOT_FOUND') closeDelegation(nodeId, now, 'gone');
    return refuse(checked.code === 'NOT_FOUND' ? 'TARGET_GONE' : checked.code, checked.message);
  }
  const worker = michiWorkerState(nodeId);
  if (!worker || !worker.exists || worker.turnStatus === 'cancelled') {
    closeDelegation(nodeId, now, 'gone');
    refuse('TARGET_GONE', 'That conversation is gone or was stopped, so nothing goes to it any more.');
  }
  if (worker!.userTookOver) {
    closeDelegation(nodeId, now, 'took_over');
    refuse('TAKEN_OVER', `The user has written in that conversation themselves, so ${agentName()} no longer sends to it.`);
  }
  return {
    delegation: delegation!,
    node: checked.node,
    ownerUserId: checked.ownerUserId,
    workspaceId: checked.workspaceId,
    workspaceName: sanitizeThreadTitle(getWorkspace(checked.workspaceId)?.name ?? null),
    title: sanitizeThreadTitle(checked.node.title),
    permission: permissionOf(nodeId, checked.ownerUserId),
    runtimeId: typeof checked.node.runtime_id === 'string' && checked.node.runtime_id ? checked.node.runtime_id : null,
    latestReplyId: worker!.messageId,
  };
}

/**
 * A check-in may send this follow-up itself (Q1, D15): the conversation runs
 * in exactly Ask, on a runtime whose approval gate Michi holds for a tainted
 * turn. Otherwise it proposes a session.send card.
 */
export function companionCheckinSendsDirectly(target: Pick<CompanionSendTarget, 'permission' | 'runtimeId'>): boolean {
  return companionCheckinMaySendDirectly(target.permission) && gateAuthoritative(target.runtimeId);
}

/** The follow-up's body as it goes out (checkCompanionSendText): the one check, the same before the approval and at delivery. */
export function companionSendBody(text: unknown): string {
  if (typeof text !== 'string') return refuse('INVALID_TEXT', 'A follow-up needs a message');
  const check = checkCompanionSendText(text);
  if (check.problem) refuse('INVALID_TEXT', check.message ?? 'A follow-up cannot be sent');
  return check.body;
}

/** Refuses a target that waits on the user or still runs (DESIGN-v2 §4: never steered, never queued, never answered for the user). */
function requireTargetIdle(nodeId: string): void {
  if (liveWait(nodeId)) {
    refuse('TARGET_WAITING_ON_USER', 'It is waiting for the user to answer an approval or a question there. Tell the user to handle it in that conversation; never answer it for them.');
  }
  if ((sendDeps.busy ?? defaultBusy)(nodeId) || michiWorkerState(nodeId)?.turnStatus === 'active') {
    refuse('TARGET_BUSY', "It's still working; ask again when it finishes.");
  }
}

const GATE_NOT_HELD_MESSAGE = 'A check-in sends a follow-up itself only into a conversation whose every tool Michi can make ask; this one gets a card.';

/** Refuses a delegation that had its follow-ups for today. */
function requireDailySendLeft(delegation: CompanionDelegation, now: number): void {
  if (countDeliveredSends(delegation.id, localDayStart(now)) >= COMPANION_LIMITS.maxDailySendsPerDelegation) {
    refuse('DAILY_LIMIT', `At most ${COMPANION_LIMITS.maxDailySendsPerDelegation} follow-ups go into one conversation a day; that one had them.`);
  }
}

// ── Delivery ────────────────────────────────────────────────────────────────

interface CompanionSendInput {
  nodeId: string;
  /** The message as the user approved it (or the check-in wrote it); checked again here. */
  text: string;
  via: CompanionSendVia;
  /** The applied card (via `card`). */
  cardId?: string | null;
  now: number;
  /** The agent's own conversation, when the caller knows it (a user turn's); default ensureAssistant. */
  caller?: CompanionSendCaller;
  /** A card's record: the conversation must not have moved on since its reply `afterMessageId`. */
  afterMessageId?: string | null;
  /** A card's record: its permission choice must be no wider than this now (isWiderChatPermission). */
  notWiderThan?: ChatPermissionChoice;
  /** Via `checkin`: the check-in's run, whose receipt lists the follow-up once it went (D21). */
  checkinRunId?: string;
  /**
   * The text comes from a turn that held outside content and the user did not
   * approve it as written ("Send, and stop asking"): the target's turn starts
   * from content someone else wrote (D19; services/turnGuard.ts outsideSourced).
   */
  passedOutside?: boolean;
}

export interface CompanionSendResult {
  runId: string;
  /** Its turn in the target, `cms-<runId>`. */
  turnId: string;
  nodeId: string;
  workspaceId: string;
  title: string;
  /** `queued`: the turn had not begun when Michi stopped waiting; it begins once the session is ready. */
  status: 'started' | 'queued';
}

/**
 * Every check before a follow-up goes out, the ones a card's Apply adds and
 * a check-in's Ask-only rule included; returns the target. Throws
 * CompanionSendRefusal. Tools and cards call it before asking or deciding,
 * and deliverCompanionMessage again before it sends.
 */
export function checkCompanionSend(input: Omit<CompanionSendInput, 'cardId'>): { target: CompanionSendTarget; body: string } {
  const body = companionSendBody(input.text);
  const target = companionSendTarget(input.nodeId, input.now, input.caller);
  if (input.afterMessageId !== undefined && target.latestReplyId !== input.afterMessageId) {
    refuse('MOVED_ON', 'The conversation moved on since this follow-up was written; read it again before sending anything.');
  }
  if (input.notWiderThan !== undefined && (target.permission === null || isWiderChatPermission(target.permission, input.notWiderThan))) {
    refuse('PERMISSION_WIDER', `It now runs in ${target.permission ? CHOICE_LABEL[target.permission] : 'a mode Michi cannot read'}, more freely than in ${CHOICE_LABEL[input.notWiderThan]} when this was proposed.`);
  }
  if (input.via === 'checkin' && !companionCheckinMaySendDirectly(target.permission)) {
    refuse('NOT_ASK', 'A check-in sends a follow-up itself only into a conversation that runs in Ask; this one gets a card.');
  }
  if (input.via === 'checkin' && !gateAuthoritative(target.runtimeId)) refuse('GATE_NOT_HELD', GATE_NOT_HELD_MESSAGE);
  requireDailySendLeft(target.delegation, input.now);
  requireTargetIdle(input.nodeId);
  return { target, body };
}

type StartOutcome = { kind: 'started' } | { kind: 'queued' } | { kind: 'failed'; error: unknown };

function waitForStart(start: Promise<StartedRequestedSelfTurn>, waitMs: number): Promise<StartOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'queued' }), waitMs);
    timer.unref?.();
    start.then(
      () => { clearTimeout(timer); resolve({ kind: 'started' }); },
      (error) => { clearTimeout(timer); resolve({ kind: 'failed', error }); },
    );
  });
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Sends one follow-up (DESIGN-v2 §4): every check again, then a `send` run,
 * the target's session, and under its restore lock (re-checked idle) the
 * requested turn `cms-<runId>` with Michi's header; a check-in's is recorded
 * as check-in material first (D15). The run ends `ok` once the turn begins
 * (or was queued to), `error` with the reason when it could not, `skipped`
 * when the conversation started a turn of its own meanwhile, its session
 * runs where Michi does not hold the gate, or a check-in's results were
 * withdrawn (D5). A check-in's follow-up that went
 * is recorded on the check-in's run for its receipt (D21). Throws
 * CompanionSendRefusal; nothing goes out then.
 */
export async function deliverCompanionMessage(input: CompanionSendInput): Promise<CompanionSendResult> {
  const caller = input.caller ?? { ownerUserId: null, ...agentConversation() };
  const { target, body } = checkCompanionSend({ ...input, caller });
  const deps = messaging();
  if (!deps) refuse('UNAVAILABLE', 'Sending follow-ups is not available on this backend.');
  const displayName = agentName();
  const wireText = formatCompanionThreadMessage({ displayName, via: input.via, text: body });
  const run = startSendRun({
    delegationId: target.delegation.id,
    via: input.via,
    detail: `To "${target.title}" via ${input.via}${input.cardId ? ` (card ${input.cardId})` : ''}${input.checkinRunId ? ` (check-in ${input.checkinRunId})` : ''}`
      + ` · ${Array.from(body).length} characters`,
    startedAt: input.now,
  });
  const turnId = companionSendTurnId(run.id);
  const fail = (code: CompanionSendRefusalCode, message: string, outcome: 'error' | 'skipped' = 'error'): never => {
    finishRun(run.id, { outcome, finishedAt: input.now, detail: `Not sent to "${target.title}": ${message}` });
    return refuse(code, message);
  };

  let session: AgentSession | null = null;
  try {
    session = await deps!.ensureSession({ ownerUserId: target.ownerUserId, workspaceId: target.workspaceId, nodeId: target.node.id });
  } catch (error) {
    fail('UNAVAILABLE', errorText(error));
  }
  if (!session) return fail('UNAVAILABLE', "Could not open that conversation's session.");
  // The session opened is the one whose gate counts (D15): it may run on another runtime than the node recorded.
  if (input.via === 'checkin' && !gateAuthoritative(session.runtimeId)) fail('GATE_NOT_HELD', GATE_NOT_HELD_MESSAGE, 'skipped');

  const userMetadata: DurableMessageMetadata = {
    threadMessage: { fromNodeId: caller.nodeId, fromTitle: displayName },
    companionSend: { runId: run.id, via: input.via },
  };
  let start: Promise<StartedRequestedSelfTurn>;
  const release = await deps!.acquireRestoreLock(target.node.id);
  try {
    try {
      // The session may have taken a while to open: the user may have started a turn there meanwhile.
      requireTargetIdle(target.node.id);
    } catch (error) {
      if (error instanceof CompanionSendRefusal) fail(error.code, error.message, 'skipped');
      throw error;
    }
    if (input.via === 'checkin') {
      // D5: the check-in's result goes out only while what its memory pack showed holds.
      if (!input.checkinRunId || !checkinMemoryHolds(input.checkinRunId)) fail('WITHDRAWN', CHECKIN_WITHDRAWN_MESSAGE, 'skipped');
      // D15: the turn holds check-in material from its start, so nothing it runs goes without the user's approval.
      try {
        recordCompanionTaint({ nodeId: target.node.id, turnId }, 'companion_session_send', 'checkin');
      } catch (error) {
        log.warn('chat', 'companion follow-up not marked as check-in material; not sent', { nodeId: target.node.id, turnId, error: errorText(error) });
        fail('TAINT_UNRECORDED', 'Michi could not mark that turn as started by a check-in, so nothing was sent; this one gets a card.');
      }
    }
    if (input.via !== 'checkin' && input.passedOutside) {
      // D19: the target's turn starts from content someone else wrote, so its network and credential reads ask too.
      try {
        recordPassedOutsideContent({ nodeId: target.node.id, turnId }, caller.nodeId, session.runtimeId);
      } catch (error) {
        log.warn('chat', 'companion follow-up not marked as carrying outside content; not sent', { nodeId: target.node.id, turnId, error: errorText(error) });
        fail('TAINT_UNRECORDED', 'Michi could not mark that turn as starting from outside content, so nothing was sent.');
      }
    }
    start = deps!.startTurn({
      chatId: session.id,
      nodeId: target.node.id,
      ownerUserId: caller.ownerUserId,
      turnId,
      text: wireText,
      displayText: wireText,
      userMetadata,
      session,
    });
  } finally {
    release();
  }
  start.then((started) => { void started.done.catch(() => {}); }, (error) => {
    log.warn('chat', 'companion follow-up turn failed to begin', { nodeId: target.node.id, turnId, error: errorText(error) });
  });
  const outcome = await waitForStart(start, deps!.startWaitMs);
  if (outcome.kind === 'failed') return fail('UNAVAILABLE', errorText(outcome.error));
  finishRun(run.id, { outcome: 'ok', finishedAt: input.now, turnId });
  markDelegationSent(target.delegation.id, input.now);
  if (input.checkinRunId) {
    // D21: the check-in's receipt lists it, from storage too (a restart before it posts).
    try {
      recordCheckinSend(input.checkinRunId, { nodeId: target.node.id, title: target.title });
    } catch (error) {
      log.warn('chat', 'companion follow-up not recorded on its check-in', { runId: input.checkinRunId, nodeId: target.node.id, error: errorText(error) });
    }
  }
  return { runId: run.id, turnId, nodeId: target.node.id, workspaceId: target.workspaceId, title: target.title, status: outcome.kind };
}
