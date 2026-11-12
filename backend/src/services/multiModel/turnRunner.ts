/**
 * Start one backend-requested turn of a multi-model run and resolve its
 * outcome, after the send_to_thread delivery (agents/threadMessageTool.ts):
 * open the node's session, start the turn under the restore lock, then read
 * the outcome from the durable receipt once it is done.
 *
 * Callers await `began` only where they must serialize (a new child in the
 * open queue) and settle the step from `outcome`; nothing awaits `outcome`
 * inline, so a child waiting on an approval never holds anyone else up.
 */
import { BACKEND_RESTARTED_ERROR, MULTI_MODEL_LIMITS, type DurableMessageMetadata } from 'michi-shared';
import type { StartedRequestedSelfTurn, StartRequestedSelfTurnArgs } from '../../agents/chatHub';
import { startUnderRestoreLock } from '../../agents/requestedTurnStart';
import type { AgentSession } from '../../agents/types';

export interface PlanTurnDeps {
  /** chatHub.startRequestedSelfTurn. */
  startTurn(args: StartRequestedSelfTurnArgs): Promise<StartedRequestedSelfTurn>;
  /** chatManager.ensureParentSession. */
  ensureSession(input: { ownerUserId: string; workspaceId: string; nodeId: string }): Promise<AgentSession | null>;
  /** The orchestrator's open queue. ensureSession runs inside it when the node has no live session. */
  serialOpen<T>(fn: () => Promise<T>): Promise<T>;
  /** sessionRegistry lookup. */
  hasLiveSession(nodeId: string): boolean;
  acquireRestoreLock(nodeId: string): Promise<() => void>;
  /** ThreadMessagingDeps.isLiveSession. */
  isLiveSession?(session: AgentSession): boolean;
  requestedTurnStatus(turnId: string): 'active' | 'completed' | 'cancelled' | 'error' | null;
  /** threadTurnReceipt(turnId)?.error. */
  turnError(turnId: string): string | null;
  isShuttingDown(): boolean;
  /** The node runs a turn of its own (chatHub.holdsSession). */
  isBusy(nodeId: string): boolean;
  /** Poll interval and limit of the wait for a busy node; tests shorten them. */
  busyPollMs?: number;
  busyWaitMs?: number;
}

export type PlanTurnOutcome =
  | { kind: 'completed' }
  | { kind: 'failed'; error: string }
  /** A stop this plan did not request: a runtime or user cancel. */
  | { kind: 'cancelled' }
  /** shouldStart said no (the caller maps it to interrupted while shutting down). */
  | { kind: 'withdrawn' }
  /** backend_restarted. */
  | { kind: 'interrupted' };

export interface PlanTurnRequest {
  ownerUserId: string;
  workspaceId: string;
  nodeId: string;
  turnId: string;
  text: string;
  userMetadata: DurableMessageMetadata;
  /** Already-open session (first child turn, lock held by the caller); else ensureSession is used. */
  opened?: { session: AgentSession; release(): void };
  shouldStart: () => boolean;
  /** Called holding the restore lock, right before the turn is started (trust carried onto it). */
  beforeStart?: (session: AgentSession) => void;
  /** Called synchronously right after the turn began (startRequestedSelfTurn resolved). */
  onBegan?: (assistantId: string) => void;
}

export interface PlanTurnHandle {
  /** Resolves once the turn began, or once it can no longer begin (withdrawn, failed open/start). Never rejects. */
  began: Promise<void>;
  /** Resolves with the final outcome in every case, including a withdrawn or failed begin. Never rejects. */
  outcome: Promise<PlanTurnOutcome>;
}

const BUSY_POLL_MS = 2_000;
const BUSY_WAIT_MS = 10 * 60_000;
const ACTIVE_PARENT = 'Cannot reload an active parent turn';
const WITHDRAWN = 'was withdrawn before it started';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampError(text: string): string {
  return text.length > MULTI_MODEL_LIMITS.error ? `${text.slice(0, MULTI_MODEL_LIMITS.error - 1)}…` : text;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function openSession(deps: PlanTurnDeps, request: PlanTurnRequest): Promise<AgentSession | null> {
  const input = { ownerUserId: request.ownerUserId, workspaceId: request.workspaceId, nodeId: request.nodeId };
  // ensureParentSession takes the restore lock itself, which is not re-entrant.
  const open = () => deps.hasLiveSession(request.nodeId) ? deps.ensureSession(input) : deps.serialOpen(() => deps.ensureSession(input));
  try {
    return await open();
  } catch (error) {
    if (!errorText(error).includes(ACTIVE_PARENT)) throw error;
  }
  // The node runs a turn of its own: wait for it outside the open queue, then try once more.
  const poll = deps.busyPollMs ?? BUSY_POLL_MS;
  const deadline = Date.now() + (deps.busyWaitMs ?? BUSY_WAIT_MS);
  while (deps.isBusy(request.nodeId) && !deps.isShuttingDown() && Date.now() < deadline) await delay(poll);
  return open();
}

function outcomeOf(deps: PlanTurnDeps, turnId: string): PlanTurnOutcome {
  const status = deps.requestedTurnStatus(turnId);
  if (status === 'completed') return { kind: 'completed' };
  if (status === 'cancelled') return { kind: 'cancelled' };
  if (status === 'error') {
    const error = deps.turnError(turnId);
    if (error === BACKEND_RESTARTED_ERROR) return { kind: 'interrupted' };
    return { kind: 'failed', error: clampError(error || 'The turn failed') };
  }
  return { kind: 'failed', error: 'The answer could not be saved' };
}

export function startPlanTurn(deps: PlanTurnDeps, request: PlanTurnRequest): PlanTurnHandle {
  let resolveBegan!: () => void;
  const began = new Promise<void>((resolve) => { resolveBegan = resolve; });
  const outcome = (async (): Promise<PlanTurnOutcome> => {
    let session: AgentSession;
    let release: () => void;
    if (request.opened) {
      session = request.opened.session;
      release = () => request.opened!.release();
    } else {
      // No session is opened for a turn that may no longer start (a Stop, or shutdown).
      if (!request.shouldStart()) return { kind: 'withdrawn' };
      let opened: AgentSession | null;
      try {
        opened = await openSession(deps, request);
      } catch (error) {
        return { kind: 'failed', error: clampError(`Could not open the thread's session: ${errorText(error)}`) };
      }
      if (!opened) return { kind: 'failed', error: "Could not open the thread's session: it is no longer available" };
      session = opened;
      try {
        release = await deps.acquireRestoreLock(request.nodeId);
      } catch (error) {
        return { kind: 'failed', error: clampError(`Could not open the thread's session: ${errorText(error)}`) };
      }
    }
    const start = startUnderRestoreLock(release, session, deps.isLiveSession, () => {
      request.beforeStart?.(session);
      return deps.startTurn({
        chatId: session.id,
        nodeId: request.nodeId,
        ownerUserId: request.ownerUserId,
        turnId: request.turnId,
        text: request.text,
        displayText: request.text,
        userMetadata: request.userMetadata,
        session,
        shouldStart: request.shouldStart,
      });
    });
    let started: StartedRequestedSelfTurn;
    try {
      started = await start;
    } catch (error) {
      const message = errorText(error);
      return message.includes(WITHDRAWN) ? { kind: 'withdrawn' } : { kind: 'failed', error: clampError(message) };
    }
    request.onBegan?.(started.assistantId);
    resolveBegan();
    await started.done.catch(() => {});
    return outcomeOf(deps, request.turnId);
  })().catch((error): PlanTurnOutcome => ({ kind: 'failed', error: clampError(errorText(error)) }))
    .finally(() => resolveBegan());
  return { began, outcome };
}
