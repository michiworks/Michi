/**
 * send_to_thread `wake`: when the target thread's turn for a message ends,
 * its reply starts a backend-requested turn in the SENDING thread, as a
 * "[Thread reply]" message (formatThreadReply). The sender's agent ends its
 * turn instead of waiting, and the reply continues its task.
 *
 * Durability (services/threadMessageWakeStore.ts, migration 0065). The tool
 * writes the record before it delivers the message, keyed by the target turn,
 * with the reply turn's derived id (threadReplyTurnId). A delivery claims it
 * pending -> delivering once and settles it delivered when the reply turn has
 * begun, or undeliverable (the sender was deleted, archived or put in the
 * trash, or AI navigation was turned off). A delivery retried after a crash
 * passes the same turn id, so ChatHub returns the reply turn that already
 * began instead of sending the reply twice.
 *
 * Triggers. In this process the tool watches the target turn's completion
 * (watchThreadWake). At startup, recoverThreadMessageWakes re-evaluates what
 * the previous process left open, one wake at a time: a target turn that
 * ended is delivered. Nobody may be at the keyboard after a restart, so an
 * answer the restart cut short, or a message that never started, starts no
 * turn: the record settles undeliverable (`interrupted`, `not_started`). A
 * reply turn that a restart interrupts keeps its ordinary restart receipt
 * and is not run again, so it needs no exemption from interrupted-turn
 * recovery; its record settles delivered. Startup also drops settled records
 * older than SETTLED_WAKE_RETENTION_MS.
 *
 * Stop (ChatHub.cancel, wired in server.ts to settleStoppedThreadWakes). The
 * user stopping the turn that asked for a wake settles it `caller_cancelled`,
 * also when its reply waits in the sender's queue behind that turn (the
 * queued reply is withdrawn: StartRequestedSelfTurnArgs.shouldStart).
 * Stopping the target's turn for the message settles it `target_cancelled`:
 * no reply starts. A turn the runtime itself ended as cancelled is not a Stop,
 * and its reply says it was stopped.
 *
 * Retries. When the sender's session does not open, or its reply turn does
 * not begin, the claim goes back to pending for the next startup, up to
 * THREAD_WAKE_MAX_ATTEMPTS failures; then it is undeliverable. A delivery
 * this process's shutdown would cut short (ThreadMessagingDeps.isShuttingDown)
 * leaves the record open without counting.
 *
 * Ordering. Like the message itself, the reply turn is a requested self-turn
 * registered under the sender's restore lock: it queues behind the sender's
 * running turn, and a user send meanwhile gets 409 turn_active.
 *
 * Trust (services/turnTrust.ts). The reply turn counts as having consumed
 * untrusted content when the target turn that answered did (and wrote a
 * reply), or when the turn that asked for the wake did or is unknown: it
 * carries on that turn's work.
 *
 * The loop guard (THREAD_WAKE_MAX_HOPS) is the tool's: a record carries the
 * reply turn's hop, and the reply's metadata passes it on.
 */

import {
  PANE_INSPECTION_LIMITS,
  PaneInspectionError,
  formatThreadReply,
  sanitizeThreadTitle,
  type DurableMessageMetadata,
  type ThreadReplyOutcome,
} from "michi-shared";
import { chatTargetUnavailable, type ChatTargetUnavailable } from "../services/chatTarget";
import { getNode } from "../services/dbRepository";
import { log } from "../services/logger";
import { authorizeCaller, type PaneInspectionCaller } from "../services/paneInspection";
import { readOutput } from "../services/paneInspectionOutput";
import {
  claimThreadWake,
  createThreadWake,
  getThreadWake,
  listOpenThreadWakes,
  pruneSettledThreadWakes,
  releaseThreadWake,
  settleStoppedTurnWakes,
  settleThreadWake,
  threadTurnReceipt,
  type NewThreadWake,
  type ThreadTurnReceipt,
  type ThreadWakeRecord,
  type ThreadWakeState,
} from "../services/threadMessageWakeStore";
import { BACKEND_RESTARTED_ERROR } from "../services/turnPersistence.recipes";
import { getTurnTrust, recordUntrustedSource, type TurnRef } from "../services/turnTrust";
import { recordPassedOutsideContent, turnHoldsOutsideContent } from "../services/turnGuard";
import { buildPaneInspectionCaller } from "./paneInspectionTools";
import { startUnderRestoreLock } from "./requestedTurnStart";
import type { ThreadMessagingDeps } from "./threadMessageTool";
import type { AgentSession } from "./types";

/** The longest reply a wait result or a thread reply carries; read_pane_output pages the rest. */
export const THREAD_REPLY_MAX_BYTES = PANE_INSPECTION_LIMITS.readOutputDefaultBytes;

/** Failed deliveries (the sender's session did not open, its turn did not begin) before a wake is undeliverable. */
export const THREAD_WAKE_MAX_ATTEMPTS = 3;

/** How long startup keeps settled wakes. */
const SETTLED_WAKE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** Startup's pause between two wakes whose reply turns it started. */
const RECOVERY_STAGGER_MS = 100;

type WakeDeps = Pick<ThreadMessagingDeps, "ensureSession" | "startTurn" | "acquireRestoreLock" | "isLiveSession" | "isShuttingDown">;

/**
 * Wakes this process registered and still owns, from registration on (the
 * message may still be queued, with no turn row yet): startup recovery
 * leaves them to their watcher.
 */
const watched = new Set<string>();
const inFlight = new Map<string, Promise<ThreadWakeState | null>>();

/**
 * Turns the user stopped in this process, newest last: a wake one of them
 * asks for afterwards (its call was already on its way) is cancelled at once.
 */
const stoppedTurns = new Set<string>();
const STOPPED_TURNS_MAX = 1_000;

/** The sender's reply turn for a woken message: derived, so every retry names the same turn. */
export function threadReplyTurnId(targetTurnId: string): string {
  return `thread-reply-${targetTurnId}`;
}

/**
 * Records a pending wake. Called before the message is delivered;
 * watchThreadWake or abandonThreadWake follows. Settled at once
 * (`caller_cancelled`) when the user already stopped the asking turn.
 */
export function registerThreadWake(input: Omit<NewThreadWake, "requestedTurnId">): ThreadWakeRecord {
  const record = createThreadWake({ ...input, requestedTurnId: threadReplyTurnId(input.targetTurnId) });
  if (input.callerTurnId && stoppedTurns.has(input.callerTurnId)) {
    settleThreadWake(record.targetTurnId, "undeliverable", "caller_cancelled");
    return getThreadWake(record.targetTurnId) ?? record;
  }
  watched.add(record.targetTurnId);
  return record;
}

/** The message never began and the sender was told so: nothing to wake it for. */
export function abandonThreadWake(targetTurnId: string, detail: string): void {
  settleThreadWake(targetTurnId, "undeliverable", detail);
  watched.delete(targetTurnId);
}

/**
 * ChatHub.cancel's listener (server.ts): the user stopped `turnId`, so no
 * reply starts a turn for a wake that turn asked for, or for the message it
 * was answering. Never throws.
 */
export function settleStoppedThreadWakes(turnId: string): void {
  stoppedTurns.add(turnId);
  if (stoppedTurns.size > STOPPED_TURNS_MAX) stoppedTurns.delete(stoppedTurns.values().next().value!);
  try {
    const settled = settleStoppedTurnWakes(turnId);
    if (settled.callerCancelled || settled.targetCancelled) log.info("chat", "thread reply wakes cancelled by stop", { turnId, ...settled });
  } catch (error) {
    log.warn("chat", "thread reply wakes not cancelled on stop", { turnId, error: errorMessage(error) });
  }
}

/** Delivers the wake once the target's turn for the message has ended (or never began). */
export function watchThreadWake(targetTurnId: string, targetTurnEnded: Promise<unknown>, deps: WakeDeps): Promise<ThreadWakeState | null> {
  watched.add(targetTurnId);
  return targetTurnEnded.then(() => true, () => false)
    .then((ended) => deliverThreadWake(targetTurnId, deps, { targetEnded: ended }))
    .catch((error) => {
      log.warn("chat", "thread reply delivery failed", { targetTurnId, error: errorMessage(error) });
      return null;
    })
    .finally(() => watched.delete(targetTurnId));
}

interface DeliveryOptions {
  /** Startup: settles what a restart cut short instead of leaving it open. */
  recovery?: boolean;
  /** The target turn's runner has ended in this process (its `done` resolved). */
  targetEnded?: boolean;
  /** Called when the reply turn has been handed to startTurn: it is queued in the sender. */
  onQueued?: () => void;
}

/**
 * Delivers one wake if it is due; resolves with its state afterwards
 * ('delivered' once the reply turn began). Idempotent: a settled wake, or
 * one whose reply turn exists, starts nothing. `recovery` (startup) settles
 * a target turn a restart interrupted, which a process that is itself
 * shutting down leaves for the next startup.
 */
export function deliverThreadWake(targetTurnId: string, deps: WakeDeps, opts: DeliveryOptions = {}): Promise<ThreadWakeState | null> {
  const running = inFlight.get(targetTurnId);
  if (running) return running;
  const delivery = deliverOnce(targetTurnId, deps, opts)
    .finally(() => inFlight.delete(targetTurnId));
  inFlight.set(targetTurnId, delivery);
  return delivery;
}

export interface ThreadWakeRecovery {
  delivered: number;
  undeliverable: number;
  /** Still open: the target is still answering, or the delivery is left for the next startup. */
  open: number;
  failed: number;
}

/**
 * Startup: delivers or settles the wakes a previous process left open. One
 * at a time until its reply turn is queued, `staggerMs` apart after one that
 * started a turn: a busy sender holds up no other, and the turns do not all
 * start at once.
 */
export async function recoverThreadMessageWakes(
  deps: WakeDeps | null,
  opts: { staggerMs?: number; now?: number } = {},
): Promise<ThreadWakeRecovery> {
  const summary: ThreadWakeRecovery = { delivered: 0, undeliverable: 0, open: 0, failed: 0 };
  const pruned = pruneSettledThreadWakes((opts.now ?? Date.now()) - SETTLED_WAKE_RETENTION_MS);
  if (pruned > 0) log.info("chat", "settled thread reply wakes pruned", { count: pruned });
  if (!deps) return summary;
  const staggerMs = opts.staggerMs ?? RECOVERY_STAGGER_MS;
  const page = 100;
  const deliveries: Array<Promise<void>> = [];
  let startedTurn = false;
  for (let after: string | null = null; ;) {
    const records = listOpenThreadWakes(after, page);
    for (const record of records) {
      if (watched.has(record.targetTurnId)) continue;
      if (startedTurn && staggerMs > 0) await new Promise((resolve) => setTimeout(resolve, staggerMs));
      startedTurn = false;
      // Resolved when the reply turn is queued, or when the delivery ends short of that.
      let queued!: () => void;
      const reachedQueue = new Promise<void>((resolve) => { queued = resolve; });
      const onQueued = () => { startedTurn = true; queued(); };
      deliveries.push(deliverThreadWake(record.targetTurnId, deps, { recovery: true, onQueued }).then((state) => {
        if (state === "delivered") summary.delivered += 1;
        else if (state === "undeliverable") summary.undeliverable += 1;
        else summary.open += 1;
      }, (error) => {
        summary.failed += 1;
        log.warn("chat", "thread reply recovery failed", { targetTurnId: record.targetTurnId, error: errorMessage(error) });
      }).finally(queued));
      await reachedQueue;
    }
    if (records.length < page) break;
    after = records[records.length - 1].targetTurnId;
  }
  await Promise.all(deliveries);
  return summary;
}

async function deliverOnce(targetTurnId: string, deps: WakeDeps, opts: DeliveryOptions): Promise<ThreadWakeState | null> {
  const record = getThreadWake(targetTurnId);
  if (!record || record.state === "delivered" || record.state === "undeliverable") return record?.state ?? null;
  // A reply turn that began is a delivered wake, whatever happened to it since.
  if (threadTurnReceipt(record.requestedTurnId)) return settle(record, "delivered", "began");
  const outcome = replyOutcome(threadTurnReceipt(record.targetTurnId));
  if (outcome === null) {
    // The target turn ended here without a final receipt (ChatHub could not
    // save its end): no turn will finish it, and a restart would call it
    // interrupted. Otherwise it is still answering, and its watcher delivers it.
    if (opts.targetEnded && !deps.isShuttingDown?.()) return settle(record, "undeliverable", "target_unsaved");
    return record.state;
  }
  if (outcome === "interrupted" || outcome === "not_started") {
    // After a restart nobody may be at the keyboard: the answer the restart
    // cut short, or a message that never began, starts no turn on its own.
    if (opts.recovery) return settle(record, "undeliverable", outcome);
    // This process's own shutdown cut the answer short: the next startup settles it.
    if (outcome === "interrupted") return record.state;
  }
  if (deps.isShuttingDown?.()) return record.state;
  if (record.state === "pending" && !claimThreadWake(targetTurnId)) return getThreadWake(targetTurnId)?.state ?? null;

  const sender = deliverableSender(record);
  if (typeof sender === "string") return settle(record, "undeliverable", sender);
  const reply = outcome === "not_started" ? null : readReply(sender.caller, record);
  const fromTitle = sanitizeThreadTitle(getNode(record.targetNodeId)?.title ?? null);
  const text = formatThreadReply({
    fromNodeId: record.targetNodeId,
    fromTitle,
    turnId: record.targetTurnId,
    outcome,
    text: reply?.text ?? "",
    truncated: reply?.truncated,
  });
  const userMetadata: DurableMessageMetadata = {
    threadMessage: { fromNodeId: record.targetNodeId, fromTitle, kind: "reply", hop: record.hop },
  };

  let session: AgentSession | null;
  try {
    session = await deps.ensureSession({ ownerUserId: sender.caller.ownerUserId, workspaceId: record.workspaceId, nodeId: record.callerNodeId });
  } catch (error) {
    return retryLater(record, `session_unavailable: ${errorMessage(error)}`, deps);
  }
  if (!session) return retryLater(record, "session_unavailable", deps);
  // Opening the session can take a while: a Stop may have settled the wake,
  // shutdown begun, or the sender been archived meanwhile.
  const claimed = getThreadWake(targetTurnId);
  if (claimed?.state !== "delivering") return claimed?.state ?? null;
  if (deps.isShuttingDown?.()) return releaseThreadWake(targetTurnId, null);
  const still = deliverableSender(record);
  if (typeof still === "string") return settle(record, "undeliverable", still);

  const release = await deps.acquireRestoreLock(record.callerNodeId);
  if (deps.isShuttingDown?.()) {
    release();
    return releaseThreadWake(targetTurnId, null);
  }
  const start = startUnderRestoreLock(release, session, deps.isLiveSession, () => {
    markReplyTrust(record, reply?.text ?? "", session.runtimeId);
    return deps.startTurn({
      chatId: session.id,
      nodeId: record.callerNodeId,
      ownerUserId: record.ownerUserId,
      turnId: record.requestedTurnId,
      text,
      displayText: text,
      userMetadata,
      session,
      // A Stop of the asking turn while the reply waits behind it withdraws the reply.
      shouldStart: () => getThreadWake(targetTurnId)?.state === "delivering",
    });
  });
  opts.onQueued?.();
  try {
    const started = await start;
    void started.done.catch(() => {});
  } catch (error) {
    const now = getThreadWake(targetTurnId);
    if (now?.state !== "delivering") return now?.state ?? null;
    return retryLater(record, `begin_failed: ${errorMessage(error)}`, deps);
  }
  return settle(record, "delivered", outcome);
}

function replyOutcome(receipt: ThreadTurnReceipt | null): ThreadReplyOutcome | null {
  if (!receipt) return "not_started";
  if (receipt.status === "completed") return "completed";
  if (receipt.status === "cancelled") return "cancelled";
  if (receipt.status === "error") return receipt.error === BACKEND_RESTARTED_ERROR ? "interrupted" : "failed";
  return null;
}

const SENDER_UNAVAILABLE: Record<ChatTargetUnavailable, string> = {
  gone: "sender_gone",
  not_chat: "sender_not_chat",
  archived: "sender_archived",
  trashed: "sender_trashed",
  workspace_archived: "workspace_archived",
  workspace_trashed: "workspace_trashed",
  moved: "sender_gone",
};

/** Whether the reply may start a turn in the sender, and the caller to read the target as. */
function deliverableSender(record: ThreadWakeRecord): { caller: PaneInspectionCaller } | string {
  try {
    // The same owner and workspace scoping the send itself had.
    const caller = buildPaneInspectionCaller({
      ownerUserId: record.ownerUserId,
      workspaceId: record.workspaceId,
      runOwnerRunId: null,
      backendConnectionId: "local",
      callerNodeId: record.callerNodeId,
    });
    const authorized = authorizeCaller(caller, { kind: "node", nodeId: record.callerNodeId });
    if (authorized.kind !== "node") return "sender_not_chat";
    const unavailable = chatTargetUnavailable(authorized.node);
    return unavailable ? SENDER_UNAVAILABLE[unavailable] : { caller };
  } catch (error) {
    if (error instanceof PaneInspectionError) return error.code === "NAVIGATION_DISABLED" ? "navigation_disabled" : "sender_gone";
    throw error;
  }
}

/** The target turn's answer, bounded; null when it cannot be read (the target is gone). */
function readReply(caller: PaneInspectionCaller, record: ThreadWakeRecord): { text: string; truncated: boolean } | null {
  try {
    const output = readOutput(caller, {
      locator: { nodeId: record.targetNodeId },
      selection: "execution",
      executionRef: { kind: "chat_turn", nodeId: record.targetNodeId, turnId: record.targetTurnId },
      limitBytes: THREAD_REPLY_MAX_BYTES,
    });
    return { text: output.text, truncated: output.nextPageCursor !== null };
  } catch (error) {
    if (error instanceof PaneInspectionError) return null;
    throw error;
  }
}

/**
 * A reply written by a turn that consumed untrusted content (services/
 * turnTrust.ts) can carry instructions nobody in either chat wrote, so the
 * turn that receives it (`to`) counts as having consumed it too. Never throws.
 */
export function carryReplyTrust(from: TurnRef, to: TurnRef, runtimeId: string): void {
  try {
    if (!getTurnTrust(from).untrusted) return;
    recordUntrustedSource(to, { tool: "send_to_thread", runtimeId, detail: `thread:${from.nodeId}` });
  } catch (error) {
    log.warn("chat", "thread reply trust record failed", { fromTurnId: from.turnId, toTurnId: to.turnId, error: errorMessage(error) });
  }
}

/**
 * A message from a sending turn that consumed untrusted content carries what
 * that content may have planted, so the target's turn for it (`to`) counts as
 * having consumed it too; so does one from a sender whose turn could not be
 * identified (`fromTurnId` null). Never throws.
 */
export function carrySenderTrust(fromNodeId: string, fromTurnId: string | null, to: TurnRef, runtimeId: string): void {
  try {
    if (fromTurnId && !getTurnTrust({ nodeId: fromNodeId, turnId: fromTurnId }).untrusted) return;
    recordUntrustedSource(to, { tool: "send_to_thread", runtimeId, detail: `thread:${fromNodeId}` });
    // D19: the target then works from content someone else wrote (services/turnGuard.ts outsideSourced).
    if (!fromTurnId || turnHoldsOutsideContent({ nodeId: fromNodeId, turnId: fromTurnId })) recordPassedOutsideContent(to, fromNodeId, runtimeId);
  } catch (error) {
    log.warn("chat", "thread message trust record failed", { fromTurnId, toTurnId: to.turnId, error: errorMessage(error) });
  }
}

/**
 * The reply turn reads the target's answer and carries on the asking turn's
 * work, so it is untrusted when the answering turn was (and wrote a reply),
 * or the asking turn was or is unknown. Never throws.
 */
function markReplyTrust(record: ThreadWakeRecord, replyText: string, runtimeId: string): void {
  const to = { nodeId: record.callerNodeId, turnId: record.requestedTurnId };
  if (replyText) carryReplyTrust({ nodeId: record.targetNodeId, turnId: record.targetTurnId }, to, runtimeId);
  try {
    if (record.callerTurnId && !getTurnTrust({ nodeId: record.callerNodeId, turnId: record.callerTurnId }).untrusted) return;
    recordUntrustedSource(to, { tool: "send_to_thread", runtimeId, detail: `turn:${record.callerTurnId ?? "unknown"}` });
  } catch (error) {
    log.warn("chat", "thread reply trust record failed", { fromTurnId: record.callerTurnId, toTurnId: to.turnId, error: errorMessage(error) });
  }
}

/**
 * The delivery could not finish now: the claim goes back for the next
 * startup, as an attempt that failed with `detail` (the last allowed one
 * makes the wake undeliverable), or uncounted while this process shuts down.
 */
function retryLater(record: ThreadWakeRecord, detail: string, deps: WakeDeps): ThreadWakeState | null {
  const shuttingDown = deps.isShuttingDown?.() === true;
  const state = releaseThreadWake(record.targetTurnId, shuttingDown ? null : { detail, maxAttempts: THREAD_WAKE_MAX_ATTEMPTS });
  if (state === null) return getThreadWake(record.targetTurnId)?.state ?? null;
  const meta = { targetTurnId: record.targetTurnId, callerNodeId: record.callerNodeId, detail };
  if (state === "undeliverable") log.warn("chat", "thread reply undeliverable", meta);
  else log.warn("chat", shuttingDown ? "thread reply left for the next startup" : "thread reply will be retried at the next startup", meta);
  return state;
}

function settle(record: ThreadWakeRecord, state: "delivered" | "undeliverable", detail: string): ThreadWakeState {
  settleThreadWake(record.targetTurnId, state, detail);
  const meta = { targetTurnId: record.targetTurnId, callerNodeId: record.callerNodeId, detail };
  if (state === "delivered") log.info("chat", "thread reply delivered", meta);
  else log.warn("chat", "thread reply undeliverable", meta);
  return getThreadWake(record.targetTurnId)?.state ?? state;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
