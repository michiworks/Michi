/**
 * MultiModelOrchestrator: runs a multi-model plan by itself once the user
 * presses Start. Every live row becomes a branch of the caller that answers
 * the agent's prompt; review rounds give each surviving branch the others'
 * answers; the caller then writes the synthesis (and an addendum for answers
 * that arrived after it). It owns every transition of a run: the state is
 * persisted in multi_model_runs (compare-and-set) and then pushed to the
 * workflow run hub, whose snapshot both cards render.
 *
 * Serialization: one promise-chain lock per run (`withRun`), one per caller
 * (`withCaller`, around propose, Start and run Retry), and one process-wide
 * open queue that creates branches and opens their sessions strictly one at
 * a time. Nothing awaits a turn's outcome inline; outcomes settle steps
 * through the run lock.
 */
import { randomUUID } from 'node:crypto';
import {
  BACKEND_RESTARTED_ERROR,
  CHAT_STREAM_EVENTS,
  MULTI_MODEL_LIMITS,
  MULTI_MODEL_STEP_IN_FLIGHT,
  MULTI_MODEL_STEP_RETRYABLE,
  MULTI_MODEL_SYNTHESIS_RETRYABLE,
  multiModelLatestRunIndex,
  multiModelStepsInFlight,
  multiModelStepsReplaceable,
  multiModelStepsRetryable,
  sanitizeThreadTitle,
  threadMessageBody,
  type ChatStreamEvent,
  type DurableMessageMetadata,
  type MultiModelContext,
  type MultiModelModelPick,
  type MultiModelPhase,
  type MultiModelPlanEdit,
  type MultiModelProposalResult,
  type MultiModelStepStatus,
  type MultiModelSynthesisStatus,
  type ReadyModelsDto,
  type ThreadMessagePlanSource,
  type WorkflowRunDtoV1,
  type WorkspaceStructureChangedEvent,
} from 'michi-shared';
import type { ChatHub } from '../../agents/chatHub';
import { MultiModelError, type MultiModelToolCaller, type MultiModelToolPort } from '../../agents/multiModelTool';
import { carryReplyTrust, carrySenderTrust } from '../../agents/threadMessageWakes';
import type { AgentSession } from '../../agents/types';
import { LOCAL_AGENT_OWNER_ID } from '../agentOwner';
import type { PermissionAnswered } from '../attentionSignals';
import type { answerChatPermission } from '../chatPermissionAnswers';
import { readNodePermissionSetting, resolveChatApproveForMe, resolveChatPermissionMode } from '../chatPermissions';
import { getNode, getNodeSessionBinding, listMessages } from '../dbRepository';
import { rollbackProvisionalSpawnNode } from '../graphCommands';
import { log } from '../logger';
import { stripSentinelsStreamingSafe } from '../messageSerialization';
import { summarizeReply } from '../scheduledJobs/chatExecutor';
import { isScheduledOnlyThread } from '../scheduledJobs/scheduledOnly';
import { workflowRunId, type WorkflowRunHub } from '../workflowRunHub';
import { MultiModelApprovalMirror } from './approvalsMirror';
import { callerUnavailable, childAvailable, childRowExists, type CreateChildInput, type OpenedChild } from './childThreads';
import {
  formatPlanAddendum,
  formatPlanPrompt,
  formatPlanReview,
  formatPlanSynthesis,
  type PlanFinalAnswer,
  type PlanMissingThread,
  type PlanPeerAnswer,
} from './formatters';
import type { ReadyModelsService, ReadySnapshot } from './readyModels';
import type { MultiModelRunRecord, MultiModelStore, MultiModelTurnOutcome, MultiModelTurnRole } from './store';
import { startPlanTurn, type PlanTurnDeps, type PlanTurnOutcome } from './turnRunner';
import type { MultiModelModelChoice, MultiModelPlan, MultiModelRunState, MultiModelStepState, MultiModelThreadPlan, MultiModelThreadState } from './types';
import { workflowRunPatch, type LiveRunExtras } from './view';

// MultiModelError lives in the tool module so it needs only shared types.
export { MultiModelError, type MultiModelErrorCode } from '../../agents/multiModelTool';

export interface MultiModelOrchestratorDeps {
  hub: Pick<WorkflowRunHub, 'update' | 'registerControls' | 'requestApproval' | 'withdrawApproval' | 'recover'>;
  store: MultiModelStore;
  chat: Pick<ChatHub, 'startRequestedSelfTurn' | 'requestedTurnStatus' | 'cancel' | 'holdsSession'
    | 'getPendingPermission' | 'subscribeBackground' | 'onCancel' | 'isShuttingDown' | 'resolveActiveInvocationAnchor'>;
  ensureSession(input: { ownerUserId: string; workspaceId: string; nodeId: string }): Promise<AgentSession | null>;
  acquireRestoreLock(nodeId: string): Promise<() => void>;
  /** ThreadMessagingDeps.isLiveSession. */
  isLiveSession?(session: AgentSession): boolean;
  /** sessionRegistry: the node has a live session. */
  hasLiveSession(nodeId: string): boolean;
  /** createChildThread with server.ts's defaults bound. */
  createChild(input: CreateChildInput): Promise<OpenedChild>;
  answerPermission: typeof answerChatPermission;
  subscribePermissionAnswered(listener: (event: PermissionAnswered) => void): () => void;
  /** threadTurnReceipt(turnId)?.error. */
  turnError(turnId: string): string | null;
  readyModels: ReadyModelsService;
  now?: () => number;
  newUuid?: () => string;
  /** Hub commits of live-activity-only changes are throttled to one per this many ms per run. Default 1500. */
  liveCommitMs?: number;
  /** turnRunner's wait for a busy node (tests shorten it). */
  busyPollMs?: number;
  busyWaitMs?: number;
}

type Effects = Array<() => void>;

/** What the run's Retry re-runs: a row's Retry also re-runs a step the user stopped. */
const RERUNNABLE = new Set<MultiModelStepStatus>(['failed', 'cancelled', 'interrupted']);
const SYNTHESIS_LIVE = new Set<MultiModelSynthesisStatus>(['queued', 'running']);

const DETAIL = {
  replaced: 'Replaced by a newer plan',
  removed: 'The conversation that started this was removed',
  moved: 'The conversation that started this moved to another workspace',
  stopped: 'Stopped',
  synthesisStopped: 'Synthesis stopped',
  addendumStopped: 'Addendum stopped',
  noAnswer: 'No branch produced an answer',
  interrupted: 'Interrupted: Michi restarted while this ran. Retry continues it.',
} as const;

const NEXT_HINT = 'The plan card is shown to the user. End your turn now with one short sentence; do not repeat the plan. '
  + 'If the user presses Start, Michi runs it and wakes this thread with every answer so you can write the synthesis.';
const BRANCH_DELETED = 'Branch was deleted';
const ONE_ANSWER = 'Only one answer, nothing to review';
const JOINED_LATE = 'Replaced after this round started';
const LIVE_COMMIT_MS = 1_500;
const LIVE_TEXT_KEEP = 8_000;
const NOW_TOOL_TITLE = 150;
const APPROVAL_TIMED_OUT = 'Approval timed out and was denied: ';
const DEFAULT_TITLE_CHARS = 60;

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalid(message: string): MultiModelError {
  return new MultiModelError('invalid', message, 400);
}

function conflict(code: 'not_proposed' | 'not_running' | 'already_running' | 'thread_busy' | 'thread_not_retryable' | 'limit'
  | 'duplicate_model' | 'caller_unavailable' | 'refused', message: string): MultiModelError {
  return new MultiModelError(code, message, 409);
}

function notFound(): MultiModelError {
  return new MultiModelError('not_found', 'not_found', 404);
}

function emptyStep(): MultiModelStepState {
  return { status: 'pending', turnId: null, attempt: 0, startedAt: null, endedAt: null, summary: null, excerpt: null, error: null, totalTokens: null, notice: null };
}

/** The next attempt of a step: queued, no turn yet. */
function queueStep(step: MultiModelStepState): void {
  Object.assign(step, { ...emptyStep(), status: 'queued' as const, attempt: step.attempt + 1 });
}

function inFlight(step: MultiModelStepState | undefined): boolean {
  return !!step && MULTI_MODEL_STEP_IN_FLIGHT.has(step.status);
}

function threadInFlight(thread: MultiModelThreadState): boolean {
  return multiModelStepsInFlight(thread.steps);
}

/** The row's branch is queued for creation in the open queue: its minted id has no node yet to check. */
function creationPending(thread: MultiModelThreadState): boolean {
  return thread.steps[0]?.status === 'queued' && thread.steps[0].turnId === null;
}

/** A branch that existed and was deleted, or whose tree was archived. */
function childGone(thread: MultiModelThreadState): boolean {
  return thread.childNodeId !== null && !creationPending(thread) && !childAvailable(thread.childNodeId);
}

function latestRunIndex(thread: MultiModelThreadState): number {
  return multiModelLatestRunIndex(thread.steps);
}

function latestCompletedIndex(thread: MultiModelThreadState): number {
  for (let index = thread.steps.length - 1; index >= 0; index -= 1) {
    if (thread.steps[index].status === 'completed') return index;
  }
  return -1;
}

function label(plan: MultiModelThreadPlan): string {
  return `${plan.runtimeLabel} · ${plan.modelLabel}`;
}

function sameModel(a: Pick<MultiModelModelChoice, 'runtimeId' | 'providerId' | 'modelId'>, b: Pick<MultiModelModelChoice, 'runtimeId' | 'providerId' | 'modelId'>): boolean {
  return a.runtimeId === b.runtimeId && (a.providerId ?? null) === (b.providerId ?? null) && (a.modelId ?? null) === (b.modelId ?? null);
}

/** Live (non-removed) rows that were started, in plan order. */
function liveThreads(record: MultiModelRunRecord): Array<{ plan: MultiModelThreadPlan; state: MultiModelThreadState }> {
  return record.plan.threads.flatMap((plan) => {
    const state = record.state.threads[plan.key];
    return !plan.removed && state ? [{ plan, state }] : [];
  });
}

interface TurnRef {
  runId: string;
  /** Null for the synthesis and addenda (caller turns). */
  key: string | null;
  step: number;
  nodeId: string;
}

interface LiveActivity {
  now: Record<string, string | undefined>;
  excerpt: Record<string, string | undefined>;
  text: Record<string, string>;
  afterTool: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
}

export class MultiModelOrchestrator implements MultiModelToolPort {
  private readonly now: () => number;
  private readonly newUuid: () => string;
  private readonly runLocks = new Map<string, Promise<unknown>>();
  private readonly callerLocks = new Map<string, Promise<unknown>>();
  private openQueue: Promise<unknown> = Promise.resolve();
  /**
   * The last committed copy of each run: mayStart reads it synchronously.
   * This map and lastCommitAt and controls drop a run once it ended and its
   * turns settled (forgetEnded); the store and the hub keep it.
   */
  private readonly records = new Map<string, MultiModelRunRecord>();
  /** Cancels the orchestrator itself issued (ChatHub notifies those too). */
  private readonly orchestratorCancels = new Set<string>();
  /** Turns a user stopped from a pane. */
  private readonly userStopped = new Set<string>();
  private readonly turnRefs = new Map<string, TurnRef>();
  /** turnId → requestId → title of the step turns' permission requests, until they resolve. */
  private readonly approvalTitles = new Map<string, Map<number, string>>();
  /** turnId → requests of it the user answered (the run's card, or the branch pane). */
  private readonly userAnswered = new Map<string, Set<number>>();
  private readonly activity = new Map<string, LiveActivity>();
  private readonly lastCommitAt = new Map<string, number>();
  private readonly controls = new Map<string, 'proposed' | 'running' | 'none'>();
  /** The hub's run after a record's commit, what route commands return; held only as long as the record. */
  private readonly committed = new WeakMap<MultiModelRunRecord, WorkflowRunDtoV1>();
  private readonly mirror: MultiModelApprovalMirror;
  private readonly turnDeps: PlanTurnDeps;

  constructor(private readonly deps: MultiModelOrchestratorDeps) {
    this.now = deps.now ?? Date.now;
    this.newUuid = deps.newUuid ?? randomUUID;
    this.mirror = new MultiModelApprovalMirror({
      hub: deps.hub,
      getPendingPermission: (chatId) => deps.chat.getPendingPermission(chatId),
      answer: deps.answerPermission,
    });
    this.turnDeps = {
      startTurn: (args) => deps.chat.startRequestedSelfTurn(args),
      ensureSession: (input) => deps.ensureSession(input),
      serialOpen: (fn) => this.serialOpen(fn),
      hasLiveSession: (nodeId) => deps.hasLiveSession(nodeId),
      acquireRestoreLock: (nodeId) => deps.acquireRestoreLock(nodeId),
      isLiveSession: deps.isLiveSession,
      requestedTurnStatus: (turnId) => deps.chat.requestedTurnStatus(turnId),
      turnError: (turnId) => deps.turnError(turnId),
      isShuttingDown: () => deps.chat.isShuttingDown(),
      isBusy: (nodeId) => deps.chat.holdsSession(nodeId),
      ...(deps.busyPollMs !== undefined ? { busyPollMs: deps.busyPollMs } : {}),
      ...(deps.busyWaitMs !== undefined ? { busyWaitMs: deps.busyWaitMs } : {}),
    };
  }

  /** Boot: subscribe to chat frames and cancels; settle and re-attach stored runs. Synchronous DB + hub work. */
  start(): void {
    this.deps.hub.recover();
    this.deps.chat.subscribeBackground({ includeForeground: true, send: (_chatId, event) => this.onFrame(event), close: () => {} });
    this.deps.chat.onCancel(({ turnId }) => this.onCancel(turnId));
    this.deps.subscribePermissionAnswered((event) => this.onPermissionAnswered(event));
    for (const record of this.deps.store.listOpenRuns()) {
      try {
        this.recoverRun(record);
      } catch (error) {
        log.warn('chat', 'multi-model run recovery failed', { runId: record.id, error: errorText(error) });
      }
    }
  }

  /**
   * A structure frame (structureEvents): a run whose branch was deleted,
   * restored, archived or moved commits again, so the rows' branchGone
   * follows; nothing else commits a run that has ended.
   */
  structureChanged(frame: WorkspaceStructureChangedEvent): void {
    const runIds = new Set<string>();
    for (const change of frame.changes) {
      if (change.op === 'created' || change.op === 'renamed') continue;
      if (change.entity === 'node' && change.nodeId) {
        const runId = this.deps.store.runOfNode(change.nodeId);
        if (runId) runIds.add(runId);
      } else if (change.entity === 'tree' && change.treeId) {
        for (const runId of this.deps.store.runsInTree(change.treeId)) runIds.add(runId);
      }
    }
    for (const runId of runIds) {
      this.mutate(runId, () => false).catch((error) => {
        if (!(error instanceof MultiModelError)) log.warn('chat', 'multi-model branch change failed', { runId, error: errorText(error) });
      });
    }
  }

  // ---- Tool port ----------------------------------------------------------

  async listReadyModels(caller: MultiModelToolCaller): Promise<ReadyModelsDto> {
    const ownerUserId = caller.ownerUserId ?? LOCAL_AGENT_OWNER_ID;
    const node = caller.nodeId ? getNode(caller.nodeId) : null;
    const current = node?.runtime_id
      ? { runtimeId: node.runtime_id, providerId: node.provider_id ?? null, modelId: node.model_id ?? null }
      : undefined;
    return this.deps.readyModels.list(ownerUserId, current);
  }

  async propose(caller: MultiModelToolCaller, args: unknown, opts: { signal?: AbortSignal } = {}): Promise<MultiModelProposalResult> {
    const ownerUserId = caller.ownerUserId ?? LOCAL_AGENT_OWNER_ID;
    const nodeId = this.refusal(caller, ownerUserId);
    const plan = await this.validatePlan(ownerUserId, args);
    if (opts.signal?.aborted) throw conflict('refused', 'The turn was stopped before the plan was shown');
    const node = getNode(nodeId)!;
    const turn = caller.turn
      ? { turnId: caller.turn.turnId, messageId: caller.turn.assistantId }
      : this.deps.chat.resolveActiveInvocationAnchor({ runtimeSessionId: caller.runtimeSessionId, nodeId, ownerUserId, runtimeToolCallId: null });
    const callerTurnId = turn?.turnId ?? null;
    if (callerTurnId) {
      const role = this.deps.store.turn(callerTurnId)?.role;
      if (role === 'synthesis' || role === 'addendum') throw conflict('refused', 'Write the synthesis as your reply; a new plan needs the user\'s request');
    }
    const askMessageId = this.deps.store.askMessageIdFor(nodeId, callerTurnId);
    if (askMessageId === null) {
      // A fork is cut at the user's request; without one a branch inherits nothing (createChildThread), so the plan,
      // the card, the result and rows added later say Fresh too.
      for (const thread of plan.threads) thread.context = 'fresh';
      plan.sharedContext = 'fresh';
    }
    const ask = askMessageId ? listMessages(nodeId).find((message) => message.id === askMessageId)?.content ?? '' : '';
    plan.askPreview = clamp(threadMessageBody(ask), MULTI_MODEL_LIMITS.ask);
    if (!plan.title) plan.title = clamp(plan.askPreview, DEFAULT_TITLE_CHARS) || 'Multi-model plan';
    const callerLabels = this.deps.readyModels.labelsFor(node.runtime_id ?? null, node.provider_id ?? null, node.model_id ?? null);
    plan.caller = { runtimeId: node.runtime_id ?? '', ...callerLabels };
    const permUser = process.env.MICHI_CLOUD === '1' ? ownerUserId : undefined;

    return this.withCaller(nodeId, async () => {
      if (this.deps.store.listRunsForCaller(nodeId, ['running']).length > 0) {
        throw conflict('refused', 'A multi-model run is already running in this thread. Wait for it, or ask the user to stop it');
      }
      for (const older of this.deps.store.listRunsForCaller(nodeId, ['proposed'])) {
        await this.mutate(older.id, (record) => {
          if (record.status !== 'proposed') return false;
          this.finish(record, 'cancelled', DETAIL.replaced);
        });
      }
      const uuid = this.newUuid();
      const nativeId = `mm_${uuid}`;
      const runId = workflowRunId(ownerUserId, 'michi', nativeId);
      const at = this.now();
      const state: MultiModelRunState = {
        version: 1,
        currentStep: 0,
        permissionMode: resolveChatPermissionMode(nodeId, permUser),
        approveForMe: resolveChatApproveForMe(nodeId, permUser),
        threads: {},
        synthesis: { status: 'pending', turnId: null, attempt: 0, startedAt: null, endedAt: null, summary: null, error: null, messageId: null, totalTokens: null },
        addenda: [],
        cancelRequested: false,
        statusDetail: null,
      };
      this.deps.store.insertRun({
        id: runId, nativeId, ownerUserId, workspaceId: node.workspace_id, callerNodeId: nodeId, callerTurnId,
        callerMessageId: turn?.messageId ?? null, askMessageId, status: 'proposed', plan, state,
        createdAt: at, startedAt: null, endedAt: null,
      }, at);
      const record = this.deps.store.getRunById(runId);
      if (!record) throw new Error('The plan could not be saved');
      this.records.set(runId, record);
      this.commitHub(record);
      this.syncControls(record);
      return {
        status: 'proposed',
        runId,
        nativeId,
        threads: plan.threads.map((thread) => ({ key: thread.key, label: label(thread), context: thread.context })),
        reviewRounds: plan.reviewRounds,
        next: NEXT_HINT,
      };
    });
  }

  /** The caller's node id when it may propose; throws the refusal otherwise. */
  private refusal(caller: MultiModelToolCaller, ownerUserId: string): string {
    if (caller.isAgentRun || caller.assistant || caller.maintenance || !caller.nodeId) {
      throw conflict('refused', 'Multi-model plans can only be proposed from an ordinary chat');
    }
    const nodeId = caller.nodeId;
    if (isScheduledOnlyThread(nodeId)) throw conflict('refused', 'Multi-model plans cannot be proposed from a scheduled thread');
    if (this.deps.store.runOfNodeOrAncestor(nodeId) !== null) {
      throw conflict('refused', 'This thread is a branch of a multi-model plan; only the thread that started the plan can start one');
    }
    const binding = getNodeSessionBinding(nodeId, ownerUserId);
    const node = getNode(nodeId);
    if (!binding || binding.nodeId !== nodeId || !node || node.kind !== 'chat'
      || (caller.workspaceId !== null && caller.workspaceId !== node.workspace_id)
      || callerUnavailable(nodeId, node.workspace_id) !== null) {
      throw conflict('refused', 'This chat is not available for a multi-model plan');
    }
    if (this.deps.store.listRunsForCaller(nodeId, ['running']).length > 0) {
      throw conflict('refused', 'A multi-model run is already running in this thread. Wait for it, or ask the user to stop it');
    }
    return nodeId;
  }

  private async validatePlan(ownerUserId: string, args: unknown): Promise<MultiModelPlan> {
    // One probe of the runtimes for every pick and the error's ready list: a slow runtime costs its timeout once.
    let snapshot: Promise<ReadySnapshot> | undefined;
    const ready = () => (snapshot ??= this.deps.readyModels.snapshot(ownerUserId));
    const withReadyList = async (error: MultiModelError) => this.withReadyList(ownerUserId, error, await ready());
    const raw = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : null;
    if (!raw) throw await withReadyList(invalid('Arguments must be an object'));
    const title = raw.title === undefined ? '' : typeof raw.title === 'string' ? raw.title.trim() : null;
    if (title === null || title.length > MULTI_MODEL_LIMITS.title) throw await withReadyList(invalid(`title must be a string of at most ${MULTI_MODEL_LIMITS.title} characters`));
    if (!Array.isArray(raw.threads) || raw.threads.length < 1 || raw.threads.length > MULTI_MODEL_LIMITS.threads) {
      throw await withReadyList(invalid(`threads must list 1-${MULTI_MODEL_LIMITS.threads} branches`));
    }
    const reviewRounds = raw.reviewRounds === undefined ? 1 : raw.reviewRounds;
    if (typeof reviewRounds !== 'number' || !Number.isInteger(reviewRounds) || reviewRounds < 0 || reviewRounds > MULTI_MODEL_LIMITS.reviewRounds) {
      throw await withReadyList(invalid(`reviewRounds must be an integer 0-${MULTI_MODEL_LIMITS.reviewRounds}`));
    }
    const contextOf = (value: unknown, field: string): MultiModelContext => {
      if (value === undefined) return 'fresh';
      if (value === 'fork' || value === 'fresh') return value;
      throw invalid(`${field} must be "fork" or "fresh"`);
    };
    const optionalString = (value: unknown, field: string): string | null => {
      if (value === undefined || value === null) return null;
      if (typeof value !== 'string' || value.length > 200) throw invalid(`${field} must be a string`);
      return value.trim() || null;
    };
    const threads: MultiModelThreadPlan[] = [];
    try {
      for (const [index, item] of raw.threads.entries()) {
        const field = `threads[${index}]`;
        const thread = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null;
        if (!thread || typeof thread.runtime !== 'string' || !thread.runtime.trim()) throw invalid(`${field}.runtime must be a runtime id from list_ready_models`);
        const prompt = typeof thread.prompt === 'string' ? thread.prompt.trim() : '';
        if (!prompt || prompt.length > MULTI_MODEL_LIMITS.prompt) throw invalid(`${field}.prompt must be 1-${MULTI_MODEL_LIMITS.prompt} characters`);
        const pick: MultiModelModelPick = {
          runtimeId: thread.runtime.trim(),
          providerId: optionalString(thread.provider, `${field}.provider`),
          modelId: optionalString(thread.model, `${field}.model`),
          reasoning: optionalString(thread.reasoning, `${field}.reasoning`),
        };
        const context = contextOf(thread.context, `${field}.context`);
        const choice = await this.deps.readyModels.resolvePick(ownerUserId, pick, await ready());
        if (threads.some((other) => sameModel(other, choice))) {
          throw new MultiModelError('duplicate_model', `${field} repeats ${choice.runtimeLabel} · ${choice.modelLabel}; each branch needs a different model`, 409);
        }
        threads.push({ ...choice, key: `t${index + 1}`, context, prompt, removed: false, addedByUser: false });
      }
      const sharedPrompt = raw.sharedPrompt === undefined ? threads[0].prompt
        : typeof raw.sharedPrompt === 'string' && raw.sharedPrompt.trim().length <= MULTI_MODEL_LIMITS.prompt ? raw.sharedPrompt.trim() || threads[0].prompt : null;
      if (sharedPrompt === null) throw invalid(`sharedPrompt must be at most ${MULTI_MODEL_LIMITS.prompt} characters`);
      const sharedContext = raw.sharedContext === undefined ? threads[0].context : contextOf(raw.sharedContext, 'sharedContext');
      return {
        version: 1,
        title,
        askPreview: '',
        reviewRounds: reviewRounds as 0 | 1 | 2,
        sharedPrompt,
        sharedContext,
        threads,
        nextAddedKey: 1,
        caller: { runtimeId: '', runtimeLabel: '', modelLabel: '' },
      };
    } catch (error) {
      throw error instanceof MultiModelError ? await withReadyList(error) : error;
    }
  }

  /** The same error with the compact ready list appended, so the agent can correct itself. */
  private async withReadyList(ownerUserId: string, error: MultiModelError, snapshot: ReadySnapshot): Promise<MultiModelError> {
    let ready = '';
    try {
      const dto = await this.deps.readyModels.list(ownerUserId, undefined, snapshot);
      ready = dto.runtimes.map((runtime) => {
        const models = runtime.providers
          ? runtime.providers.map((provider) => `${provider.providerId}: ${provider.models.slice(0, 6).map((model) => model.modelId).join(', ') || runtime.defaultModelId || 'default'}`).join('; ')
          : runtime.models.slice(0, 8).map((model) => model.modelId).join(', ') || runtime.defaultModelId || 'default';
        return `${runtime.runtimeId} (${models})`;
      }).join(' | ');
    } catch (listError) {
      log.warn('chat', 'multi-model ready list failed', { error: errorText(listError) });
    }
    return ready ? new MultiModelError(error.code, `${error.message}. Ready: ${ready}`, error.status) : error;
  }

  // ---- Routes ---------------------------------------------------------------

  async readyModelsFor(ownerUserId: string, _workspaceId: string): Promise<ReadyModelsDto> {
    return this.deps.readyModels.list(ownerUserId);
  }

  async editPlan(ownerUserId: string, runId: string, edit: MultiModelPlanEdit): Promise<WorkflowRunDtoV1> {
    this.requireRun(ownerUserId, runId);
    const choice = edit.op === 'add' || edit.op === 'replace' ? await this.deps.readyModels.resolvePick(ownerUserId, edit.pick) : null;
    let unavailable = null as MultiModelError | null;
    const record = await this.mutate(runId, (r) => {
      if (r.status !== 'proposed') throw conflict('not_proposed', 'The plan has already started or ended');
      if (this.cancelIfCallerGone(r)) {
        unavailable = conflict('caller_unavailable', r.state.statusDetail ?? DETAIL.removed);
        return;
      }
      const rows = r.plan.threads;
      const live = rows.filter((row) => !row.removed);
      const row = edit.op === 'add' ? null : rows.find((candidate) => candidate.key === edit.key);
      if (edit.op !== 'add' && !row) throw notFound();
      if (edit.op === 'remove') {
        row!.removed = true;
      } else if (edit.op === 'restore') {
        if (!row!.removed) return false;
        if (live.length >= MULTI_MODEL_LIMITS.threads) throw conflict('limit', `A plan has at most ${MULTI_MODEL_LIMITS.threads} models`);
        if (live.some((other) => sameModel(other, row!))) throw new MultiModelError('duplicate_model', `${label(row!)} is already in the plan`, 409);
        row!.removed = false;
      } else if (edit.op === 'replace') {
        if (live.some((other) => other.key !== row!.key && sameModel(other, choice!))) {
          throw new MultiModelError('duplicate_model', `${choice!.runtimeLabel} · ${choice!.modelLabel} is already in the plan`, 409);
        }
        Object.assign(row!, choice!);
      } else {
        if (live.length >= MULTI_MODEL_LIMITS.threads || rows.length >= MULTI_MODEL_LIMITS.rows) {
          throw conflict('limit', `A plan has at most ${MULTI_MODEL_LIMITS.threads} models`);
        }
        if (live.some((other) => sameModel(other, choice!))) {
          throw new MultiModelError('duplicate_model', `${choice!.runtimeLabel} · ${choice!.modelLabel} is already in the plan`, 409);
        }
        rows.push({ ...choice!, key: `a${r.plan.nextAddedKey}`, prompt: r.plan.sharedPrompt, context: r.plan.sharedContext, removed: false, addedByUser: true });
        r.plan.nextAddedKey += 1;
      }
    });
    if (unavailable) throw unavailable;
    return this.runOf(record);
  }

  async startRun(ownerUserId: string, runId: string): Promise<WorkflowRunDtoV1> {
    const first = this.requireRun(ownerUserId, runId);
    return this.withCaller(first.callerNodeId, async () => {
      let unavailable = null as MultiModelError | null;
      const record = await this.mutate(runId, (r, fx) => {
        if (r.status === 'running') return false;
        if (r.status !== 'proposed') throw conflict('not_proposed', 'The plan has already ended');
        const rows = r.plan.threads.filter((row) => !row.removed);
        if (rows.length === 0) throw invalid('Add a model first');
        if (this.cancelIfCallerGone(r)) {
          unavailable = conflict('caller_unavailable', r.state.statusDetail ?? DETAIL.removed);
          return;
        }
        if (this.otherRunning(r)) throw conflict('already_running', 'Another multi-model run is already running in this chat');
        r.status = 'running';
        r.startedAt = this.now();
        r.endedAt = null;
        r.state.currentStep = 0;
        r.state.statusDetail = null;
        r.state.cancelRequested = false;
        for (const row of rows) {
          const steps = Array.from({ length: 1 + r.plan.reviewRounds }, emptyStep);
          queueStep(steps[0]);
          r.state.threads[row.key] = {
            key: row.key, childNodeId: null, previousChildNodeIds: [], generation: 0, steps,
            stopRequested: false, late: false, addendumTurnId: null,
          };
          fx.push(() => this.enqueueLaunch(runId, row.key));
        }
      });
      if (unavailable) throw unavailable;
      return this.runOf(record);
    });
  }

  async cancelProposal(ownerUserId: string, runId: string): Promise<WorkflowRunDtoV1> {
    this.requireRun(ownerUserId, runId);
    const record = await this.mutate(runId, (r) => {
      if (r.status === 'cancelled' && r.startedAt === null) return false;
      if (r.status !== 'proposed') throw conflict('not_proposed', 'The plan has already started or ended');
      this.finish(r, 'cancelled', null);
    });
    return this.runOf(record);
  }

  async stopAll(ownerUserId: string, runId: string): Promise<WorkflowRunDtoV1> {
    this.requireRun(ownerUserId, runId);
    const record = await this.mutate(runId, (r, fx) => {
      if (r.status === 'cancelled') return false;
      if (r.status !== 'running') throw conflict('not_running', 'This run is not running');
      this.applyStopAll(r, fx, DETAIL.stopped);
    });
    return this.runOf(record);
  }

  async retryRun(ownerUserId: string, runId: string): Promise<WorkflowRunDtoV1> {
    const first = this.requireRun(ownerUserId, runId);
    return this.withCaller(first.callerNodeId, async () => {
      const record = await this.mutate(runId, (r, fx) => {
        if (r.status === 'running') return false;
        if (r.startedAt === null) throw conflict('not_running', 'This plan was never started');
        const lastAddendum = r.state.addenda.at(-1);
        const addendumRetry = r.status === 'completed' && !!lastAddendum && MULTI_MODEL_SYNTHESIS_RETRYABLE.has(lastAddendum.status);
        // A completed run re-runs the rows whose last run step failed (not one the user stopped): they come back
        // late, so advance() writes them an addendum.
        const rowRetry = r.status === 'completed' && liveThreads(r).some(({ state }) => this.rerunnable(state, latestRunIndex(state)));
        if (r.status === 'completed' && !addendumRetry && !rowRetry) throw conflict('not_running', 'Nothing in this run needs a retry');
        if (r.status === 'proposed') throw conflict('not_running', 'This plan was never started');
        this.reopenForRetry(r);
        const current = r.state.currentStep;
        for (const { plan, state } of liveThreads(r)) {
          const index = current <= r.plan.reviewRounds ? current : latestRunIndex(state);
          if (!this.rerunnable(state, index)) continue;
          this.queueRetry(r, plan.key, index, fx);
        }
        if (MULTI_MODEL_SYNTHESIS_RETRYABLE.has(r.state.synthesis.status)) r.state.synthesis.status = 'pending';
        if (addendumRetry) {
          lastAddendum!.status = 'pending';
          for (const key of lastAddendum!.keys) {
            const thread = r.state.threads[key];
            if (thread) thread.addendumTurnId = null;
          }
        }
        this.advance(r, fx);
      });
      return this.runOf(record);
    });
  }

  async stopThread(ownerUserId: string, runId: string, key: string): Promise<WorkflowRunDtoV1> {
    this.requireRun(ownerUserId, runId);
    const record = await this.mutate(runId, (r, fx) => {
      const thread = this.requireThread(r, key);
      if (!threadInFlight(thread)) throw conflict('not_running', 'This branch has nothing running');
      thread.stopRequested = true;
      thread.steps.forEach((step) => {
        if (!inFlight(step)) return;
        if (step.turnId === null) this.endStep(step, 'stopped', null);
        else this.requestCancel(fx, thread.childNodeId!, step.turnId);
      });
      this.advance(r, fx);
    });
    return this.runOf(record);
  }

  async retryThread(ownerUserId: string, runId: string, key: string): Promise<WorkflowRunDtoV1> {
    const first = this.requireRun(ownerUserId, runId);
    return this.withCaller(first.callerNodeId, async () => {
      const record = await this.mutate(runId, (r, fx) => {
        const thread = this.requireThread(r, key);
        if (threadInFlight(thread)) throw conflict('thread_busy', 'This branch is still running');
        if (!multiModelStepsRetryable(thread.steps)) throw conflict('thread_not_retryable', 'This branch has nothing to retry');
        const index = latestRunIndex(thread);
        if (!this.retryAllowed(thread, index)) throw conflict('thread_not_retryable', 'This branch was deleted; replace its model to run it again');
        this.reopenForRetry(r);
        this.queueRetry(r, key, index, fx);
        this.advance(r, fx);
      });
      return this.runOf(record);
    });
  }

  async replaceThread(ownerUserId: string, runId: string, key: string, pick: MultiModelModelPick): Promise<WorkflowRunDtoV1> {
    const first = this.requireRun(ownerUserId, runId);
    const choice = await this.deps.readyModels.resolvePick(ownerUserId, pick);
    return this.withCaller(first.callerNodeId, async () => {
      const record = await this.mutate(runId, (r, fx) => {
        const thread = this.requireThread(r, key);
        if (threadInFlight(thread)) throw conflict('thread_busy', 'This branch is still running');
        if (!multiModelStepsReplaceable(thread.steps)) throw conflict('thread_not_retryable', 'This branch cannot be replaced now');
        const row = r.plan.threads.find((candidate) => candidate.key === key)!;
        if (r.plan.threads.some((other) => !other.removed && other.key !== key && sameModel(other, choice))) {
          throw new MultiModelError('duplicate_model', `${choice.runtimeLabel} · ${choice.modelLabel} is already in the plan`, 409);
        }
        this.reopenForRetry(r);
        Object.assign(row, choice);
        this.forgetUserStops(thread);
        thread.stopRequested = false;
        if (thread.childNodeId) thread.previousChildNodeIds.push(thread.childNodeId);
        // Every new branch gets a new generation, so its turn ids never repeat an earlier branch's.
        thread.generation += 1;
        thread.childNodeId = `n-${this.newUuid()}`;
        thread.steps = thread.steps.map(emptyStep);
        queueStep(thread.steps[0]);
        this.markLate(r, thread, 0);
        if (thread.late) {
          // A late row never joins a review round that already started: those steps are skipped, not left pending.
          const started = Math.min(r.state.currentStep, r.plan.reviewRounds);
          for (let round = 1; round <= started; round += 1) this.endStep(thread.steps[round], 'skipped', JOINED_LATE);
        }
        fx.push(() => this.enqueueLaunch(runId, key));
        this.advance(r, fx);
      });
      return this.runOf(record);
    });
  }

  // ---- Locks and persistence --------------------------------------------

  private chain<T>(locks: Map<string, Promise<unknown>>, id: string, body: () => Promise<T> | T): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(body);
    const tail = next.catch(() => {});
    locks.set(id, tail);
    void tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
    return next;
  }

  private withCaller<T>(callerNodeId: string, body: () => Promise<T>): Promise<T> {
    return this.chain(this.callerLocks, callerNodeId, body);
  }

  private serialOpen<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.openQueue.catch(() => {}).then(fn);
    this.openQueue = next.catch(() => {});
    return next;
  }

  /**
   * Load the run, apply `fn` (false: nothing changed), save it with
   * compare-and-set (one retry after a reload), commit the hub snapshot,
   * then run the effects `fn` queued (turn starts, cancels).
   */
  private mutate(runId: string, fn: (record: MultiModelRunRecord, fx: Effects) => boolean | void): Promise<MultiModelRunRecord> {
    return this.chain(this.runLocks, runId, () => this.applyNow(runId, fn));
  }

  private applyNow(runId: string, fn: (record: MultiModelRunRecord, fx: Effects) => boolean | void): MultiModelRunRecord {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const record = this.deps.store.getRunById(runId);
      if (!record) throw notFound();
      const fx: Effects = [];
      if (fn(record, fx) === false) {
        this.records.set(runId, record);
        this.commitHub(record);
        this.syncControls(record);
        this.forgetEnded(record);
        return record;
      }
      if (!this.deps.store.saveRun(record, record.revision, this.now())) continue;
      this.records.set(runId, record);
      if (record.status !== 'running') this.clearActivity(runId);
      this.commitHub(record);
      this.syncControls(record);
      this.forgetEnded(record);
      for (const effect of fx) {
        try { effect(); } catch (error) {
          log.warn('chat', 'multi-model effect failed', { runId, error: errorText(error) });
        }
      }
      return record;
    }
    throw new Error('The run changed concurrently; try again');
  }

  private requireRun(ownerUserId: string, runId: string): MultiModelRunRecord {
    const record = this.deps.store.getRun(ownerUserId, runId);
    if (!record) throw notFound();
    return record;
  }

  private requireThread(record: MultiModelRunRecord, key: string): MultiModelThreadState {
    const thread = record.state.threads[key];
    const row = record.plan.threads.find((candidate) => candidate.key === key);
    if (!row || row.removed) throw notFound();
    if (!thread) throw conflict('not_running', 'The plan has not started');
    return thread;
  }

  private runOf(record: MultiModelRunRecord): WorkflowRunDtoV1 {
    return this.committed.get(record) ?? this.commitHub(record);
  }

  /** An ended run whose turns all settled: nothing reads its in-memory entries again until it reopens. */
  private forgetEnded(record: MultiModelRunRecord): void {
    if (record.status === 'proposed' || record.status === 'running' || this.deps.store.openTurns(record.id).length > 0) return;
    this.records.delete(record.id);
    this.lastCommitAt.delete(record.id);
    this.controls.delete(record.id);
  }

  private extras(record: MultiModelRunRecord): LiveRunExtras {
    const activity = this.activity.get(record.id);
    return {
      now: activity?.now ?? {},
      excerpt: activity?.excerpt ?? {},
      settling: this.deps.store.openTurns(record.id).length > 0,
      branchGone: new Set(Object.entries(record.state.threads).flatMap(([key, thread]) => (childGone(thread) ? [key] : []))),
    };
  }

  /** Push the run's snapshot to the hub; the same snapshot leaves the hub's run as it is. */
  private commitHub(record: MultiModelRunRecord): WorkflowRunDtoV1 {
    const patch = workflowRunPatch(record, this.extras(record));
    const key = JSON.stringify(patch);
    this.lastCommitAt.set(record.id, this.now());
    const run = this.deps.hub.update(
      { ownerUserId: record.ownerUserId, workspaceId: record.workspaceId, nodeId: record.callerNodeId },
      'michi',
      record.nativeId,
      (current) => {
        const owned = {
          name: current.name, description: current.description, status: current.status, statusDetail: current.statusDetail,
          result: current.result, nodes: current.nodes, startedAt: current.startedAt, endedAt: current.endedAt,
          usage: current.usage, multiModel: current.multiModel,
        };
        return current.revision > 0 && JSON.stringify(owned) === key ? current : { ...current, ...patch };
      },
    );
    if (!run) throw new Error('The run could not be tracked');
    this.committed.set(record, run);
    return run;
  }

  /** proposed: Start/Cancel; running: Stop all; otherwise none. Registered only on change (each registration commits). */
  private syncControls(record: MultiModelRunRecord): void {
    const kind = record.status === 'proposed' ? 'proposed' : record.status === 'running' ? 'running' : 'none';
    if (this.controls.get(record.id) === kind) return;
    this.controls.set(record.id, kind);
    const { ownerUserId, id } = record;
    this.deps.hub.registerControls(ownerUserId, 'michi', record.nativeId, kind === 'proposed'
      ? { resume: async () => { await this.startRun(ownerUserId, id); }, stop: async () => { await this.cancelProposal(ownerUserId, id); } }
      : kind === 'running' ? { stop: async () => { await this.stopAll(ownerUserId, id); } } : {});
  }

  // ---- State transitions (synchronous, over the record inside mutate) ----

  private otherRunning(record: MultiModelRunRecord): boolean {
    return this.deps.store.listRunsForCaller(record.callerNodeId, ['running']).some((other) => other.id !== record.id);
  }

  /** A proposed plan whose caller is gone is cancelled; true when it was. */
  private cancelIfCallerGone(record: MultiModelRunRecord): boolean {
    const gone = callerUnavailable(record.callerNodeId, record.workspaceId);
    if (!gone) return false;
    this.finish(record, 'cancelled', gone === 'moved' ? DETAIL.moved : DETAIL.removed);
    return true;
  }

  private finish(record: MultiModelRunRecord, phase: MultiModelPhase, detail: string | null): void {
    record.status = phase;
    record.endedAt = this.now();
    record.state.statusDetail = detail;
    this.mirror.withdrawAll(record.nativeId);
  }

  /**
   * A Retry (the run's or a row's) or a row's Replace in a finished run
   * reopens it (under the caller lock) when its turns have settled, its
   * caller is still there, and no other run of the caller is running.
   */
  private reopenForRetry(record: MultiModelRunRecord): void {
    if (record.status === 'running') return;
    if (this.deps.store.openTurns(record.id).length > 0) throw conflict('thread_busy', 'Still stopping the branches. Try again in a moment.');
    const gone = callerUnavailable(record.callerNodeId, record.workspaceId);
    if (gone) throw conflict('caller_unavailable', gone === 'moved' ? DETAIL.moved : DETAIL.removed);
    if (this.otherRunning(record)) throw conflict('already_running', 'Another multi-model run is already running in this chat');
    this.reopen(record);
  }

  /** A finished run goes back to running for a retry. */
  private reopen(record: MultiModelRunRecord): void {
    record.status = 'running';
    record.endedAt = null;
    record.state.cancelRequested = false;
    record.state.statusDetail = null;
    if (MULTI_MODEL_SYNTHESIS_RETRYABLE.has(record.state.synthesis.status)) record.state.synthesis.status = 'pending';
  }

  private endStep(step: MultiModelStepState, status: MultiModelStepStatus, error: string | null): void {
    step.status = status;
    step.endedAt = this.now();
    step.error = error;
  }

  private forgetUserStops(thread: MultiModelThreadState): void {
    for (const step of thread.steps) if (step.turnId) this.userStopped.delete(step.turnId);
  }

  private markLate(record: MultiModelRunRecord, thread: MultiModelThreadState, index: number): void {
    if (index === record.state.currentStep) return;
    thread.late = true;
    thread.addendumTurnId = null;
  }

  /** A review needs the branch that wrote the answer; a deleted branch's answer step is re-run on a new one (launchChild). */
  private retryAllowed(thread: MultiModelThreadState, index: number): boolean {
    return index === 0 || !childGone(thread);
  }

  /** Run Retry re-runs step `index` of the row: it failed, was cancelled or interrupted (a user's stop stays), and may run again. */
  private rerunnable(thread: MultiModelThreadState, index: number): boolean {
    const step = thread.steps[index];
    return !!step && RERUNNABLE.has(step.status) && this.retryAllowed(thread, index);
  }

  /** Queue a new attempt of step `index`: through the open queue for a step 0 without a usable child, else directly. */
  private queueRetry(record: MultiModelRunRecord, key: string, index: number, fx: Effects): void {
    const thread = record.state.threads[key];
    const previousTurn = thread.steps[index].turnId;
    this.forgetUserStops(thread);
    thread.stopRequested = false;
    this.markLate(record, thread, index);
    queueStep(thread.steps[index]);
    if (index === 0 && (previousTurn === null || thread.childNodeId === null || !childAvailable(thread.childNodeId))) {
      fx.push(() => this.enqueueLaunch(record.id, key));
    } else {
      this.startStepTurn(record, key, index, fx);
    }
  }

  private requestCancel(fx: Effects, nodeId: string, turnId: string): void {
    fx.push(() => {
      this.orchestratorCancels.add(turnId);
      this.deps.chat.cancel(nodeId, turnId);
    });
  }

  private applyStopAll(record: MultiModelRunRecord, fx: Effects, detail: string): void {
    record.state.cancelRequested = true;
    for (const { state } of liveThreads(record)) {
      for (const step of state.steps) {
        if (!inFlight(step)) continue;
        if (step.turnId === null) this.endStep(step, 'cancelled', null);
        else this.requestCancel(fx, state.childNodeId!, step.turnId);
      }
    }
    const { synthesis } = record.state;
    if (SYNTHESIS_LIVE.has(synthesis.status) && synthesis.turnId) this.requestCancel(fx, record.callerNodeId, synthesis.turnId);
    for (const addendum of record.state.addenda) {
      if (SYNTHESIS_LIVE.has(addendum.status)) this.requestCancel(fx, record.callerNodeId, addendum.turnId);
    }
    this.finish(record, 'cancelled', detail);
  }

  private mayStartOn(record: MultiModelRunRecord | undefined, key: string | null): boolean {
    if (!record || record.status !== 'running' || record.state.cancelRequested || this.deps.chat.isShuttingDown()) return false;
    if (callerUnavailable(record.callerNodeId, record.workspaceId) !== null) return false;
    if (key === null) return true;
    const thread = record.state.threads[key];
    return !!thread && !thread.stopRequested && !childGone(thread);
  }

  private mayStart(runId: string, key: string | null): boolean {
    return this.mayStartOn(this.records.get(runId), key);
  }

  /** A queued step the open queue refused to launch settles without a child. */
  private settleUnlaunched(thread: MultiModelThreadState): void {
    const gone = thread.childNodeId !== null && childRowExists(thread.childNodeId) && !childAvailable(thread.childNodeId);
    const status: MultiModelStepStatus = this.deps.chat.isShuttingDown() ? 'interrupted'
      : thread.stopRequested || gone ? 'stopped' : 'cancelled';
    this.endStep(thread.steps[0], status, gone && !thread.stopRequested ? BRANCH_DELETED : null);
  }

  private advance(record: MultiModelRunRecord, fx: Effects): void {
    const { state, plan } = record;
    if (record.status !== 'running' || state.cancelRequested) return;
    // Shutdown settles the killed turns interrupted; the run stays as it is, for restart recovery to interrupt it.
    if (this.deps.chat.isShuttingDown()) return;
    const gone = callerUnavailable(record.callerNodeId, record.workspaceId);
    if (gone) {
      this.applyStopAll(record, fx, gone === 'moved' ? DETAIL.moved : DETAIL.removed);
      return;
    }
    const threads = liveThreads(record);
    for (const { state: thread } of threads) {
      if (!childGone(thread)) continue;
      const wasStopped = thread.stopRequested;
      thread.stopRequested = true;
      let marked = false;
      for (const step of thread.steps) {
        if (!inFlight(step)) continue;
        if (step.turnId) this.requestCancel(fx, thread.childNodeId!, step.turnId);
        this.endStep(step, 'stopped', BRANCH_DELETED);
        marked = true;
      }
      const pending = thread.steps.find((step) => step.status === 'pending');
      if (!wasStopped && !marked && pending) this.endStep(pending, 'stopped', BRANCH_DELETED);
    }
    const rounds = plan.reviewRounds;
    let current = state.currentStep;
    if (current <= rounds) {
      // A row not yet launched holds the round too; a late row never joins a round that started without it.
      const blocking = (thread: MultiModelThreadState) => inFlight(thread.steps[current])
        || (!thread.late && thread.steps[current]?.status === 'pending');
      if (threads.some(({ state: thread }) => blocking(thread))) return;
      const next = current + 1;
      if (next <= rounds) {
        const eligible = threads.filter(({ state: thread }) => thread.steps[current]?.status === 'completed' && thread.childNodeId
          && !thread.stopRequested && childAvailable(thread.childNodeId));
        if (eligible.length >= 2) {
          for (const { plan: row, state: thread } of threads) {
            const step = thread.steps[next];
            if (!step || step.status !== 'pending') continue;
            if (eligible.some((entry) => entry.plan.key === row.key)) {
              queueStep(step);
              this.startStepTurn(record, row.key, next, fx);
            } else {
              this.endStep(step, 'skipped', this.reasonFor(thread));
            }
          }
          state.currentStep = next;
          return;
        }
        for (const { state: thread } of threads) {
          // A row with no answer keeps its own reason (the synthesis and the card show it).
          const reason = latestCompletedIndex(thread) >= 0 ? ONE_ANSWER : this.reasonFor(thread);
          for (let index = next; index <= rounds; index += 1) {
            if (thread.steps[index]?.status === 'pending') this.endStep(thread.steps[index], 'skipped', reason);
          }
        }
      }
      state.currentStep = rounds + 1;
      current = state.currentStep;
    }
    const synthesis = state.synthesis;
    if (SYNTHESIS_LIVE.has(synthesis.status)) return;
    if (synthesis.status !== 'completed') {
      if (synthesis.status !== 'pending') return;
      if (threads.some(({ state: thread }) => threadInFlight(thread))) return;
      const finals = threads.filter(({ state: thread }) => latestCompletedIndex(thread) >= 0);
      if (finals.length === 0) {
        this.finish(record, 'failed', DETAIL.noAnswer);
        return;
      }
      this.startSynthesis(record, fx);
      return;
    }
    if (state.addenda.some((addendum) => SYNTHESIS_LIVE.has(addendum.status))) return;
    if (threads.some(({ state: thread }) => threadInFlight(thread))) return;
    const late = threads.filter(({ state: thread }) => {
      const index = latestCompletedIndex(thread);
      return thread.late && thread.addendumTurnId === null && index >= 0
        && (thread.steps[index].endedAt ?? 0) > (synthesis.startedAt ?? 0);
    });
    if (late.length > 0) {
      this.startAddendum(record, late.map(({ plan: row }) => row.key), fx);
      return;
    }
    const phase = this.terminalPhase(state);
    if (phase) this.finish(record, phase.phase, phase.detail);
  }

  /** The run's end state when nothing is left to do; null while it is not terminal. Never starts turns. */
  private terminalPhase(state: MultiModelRunState): { phase: MultiModelPhase; detail: string | null } | null {
    const threads = Object.values(state.threads);
    if (state.synthesis.status === 'completed') {
      const last = state.addenda.at(-1);
      const detail = !last ? null
        : last.status === 'failed' ? `Couldn't add the late answers: ${last.error ?? 'unknown error'}`
        : last.status === 'cancelled' ? DETAIL.addendumStopped
        : last.status === 'interrupted' ? "Couldn't add the late answers: Michi restarted while it ran"
        : null;
      return { phase: 'completed', detail };
    }
    if (state.synthesis.status === 'failed') {
      return { phase: 'failed', detail: `Couldn't write the synthesis: ${state.synthesis.error ?? 'unknown error'}` };
    }
    if (threads.every((thread) => latestCompletedIndex(thread) < 0 && !threadInFlight(thread))) {
      return { phase: 'failed', detail: DETAIL.noAnswer };
    }
    return null;
  }

  /** Why a thread did not take part (synthesis "missing", review skip reasons). */
  private reasonFor(thread: MultiModelThreadState): string {
    const index = latestRunIndex(thread);
    const step = thread.steps[index];
    if (!step) return 'It did not start';
    const where = `step ${index + 1}`;
    if (step.status === 'failed') return `Failed in ${where}: ${step.error ?? 'unknown error'}`;
    if (step.status === 'stopped') return step.error ? `Stopped in ${where}: ${step.error}` : `Stopped by you in ${where}`;
    if (step.status === 'cancelled') return `Cancelled in ${where}`;
    if (step.status === 'interrupted') return `Interrupted in ${where}`;
    const skipped = thread.steps.slice(index + 1).find((later) => later.status === 'skipped');
    if (skipped) return skipped.error ?? 'Skipped';
    return `Did not finish ${where}`;
  }

  // ---- Turns ----------------------------------------------------------------

  private stepTurnId(record: MultiModelRunRecord, key: string, thread: MultiModelThreadState, index: number): string {
    return `mm-${record.nativeId.slice(3)}-${key}-g${thread.generation}-s${index}-a${thread.steps[index].attempt}`;
  }

  private recordTurn(record: MultiModelRunRecord, turnId: string, nodeId: string, key: string | null, role: MultiModelTurnRole, round: number, attempt: number): void {
    this.deps.store.recordTurn({ turnId, runId: record.id, nodeId, threadKey: key, role, round, attempt: Math.max(1, attempt), createdAt: this.now() });
    this.turnRefs.set(turnId, { runId: record.id, key, step: round, nodeId });
  }

  private planSource(record: MultiModelRunRecord, plan: Omit<ThreadMessagePlanSource, 'runId'>, hop: number): DurableMessageMetadata {
    const callerTitle = getNode(record.callerNodeId)?.title ?? null;
    return {
      threadMessage: {
        fromNodeId: record.callerNodeId,
        fromTitle: sanitizeThreadTitle(callerTitle),
        hop,
        plan: { runId: record.id, ...plan },
      },
    };
  }

  private enqueueLaunch(runId: string, key: string): void {
    void this.launchChild(runId, key).catch((error) => log.warn('chat', 'multi-model branch launch failed', { runId, key, error: errorText(error) }));
  }

  /**
   * The open queue's job for a row's step 0: create its branch (or reuse a
   * kept one), record the turn and start it; the queue moves on once the
   * turn began.
   */
  private launchChild(runId: string, key: string): Promise<void> {
    return this.serialOpen(async () => {
      let launch = null as { childNodeId: string; create: boolean; permissionMode: MultiModelRunState['permissionMode']; approveForMe: boolean } | null;
      let record = await this.mutate(runId, (r, fx) => {
        const thread = r.state.threads[key];
        if (!thread || thread.steps[0]?.status !== 'queued' || thread.steps[0].turnId !== null) return false;
        if (!this.mayStartOn(r, key)) {
          this.settleUnlaunched(thread);
          this.advance(r, fx);
          return;
        }
        if (thread.childNodeId !== null && childRowExists(thread.childNodeId) && !childAvailable(thread.childNodeId)) {
          // A kept branch that was deleted (or purged: its row stays until GC) is not reused: the row gets a new one.
          thread.previousChildNodeIds.push(thread.childNodeId);
          thread.generation += 1;
          thread.childNodeId = null;
        }
        if (thread.childNodeId === null) thread.childNodeId = `n-${this.newUuid()}`;
        const permUser = process.env.MICHI_CLOUD === '1' ? r.ownerUserId : undefined;
        // The card shows the caller's effective mode; the branch copies the caller's own setting, so it follows
        // the global setting as the caller does (a branch written the global mode would keep it once that is off).
        r.state.permissionMode = resolveChatPermissionMode(r.callerNodeId, permUser);
        r.state.approveForMe = resolveChatApproveForMe(r.callerNodeId, permUser);
        const own = readNodePermissionSetting(r.callerNodeId, permUser);
        launch = { childNodeId: thread.childNodeId, create: !getNode(thread.childNodeId), permissionMode: own.mode, approveForMe: own.approveForMe };
      });
      if (!launch) return;
      const { childNodeId, create, permissionMode, approveForMe } = launch;
      const row = record.plan.threads.find((candidate) => candidate.key === key)!;
      let opened: { session: AgentSession; release(): void; inheritedUnavailable: boolean };
      try {
        if (create) {
          const child = await this.deps.createChild({
            ownerUserId: record.ownerUserId, callerNodeId: record.callerNodeId, runId, childNodeId, permissionMode, approveForMe,
            choice: row, context: row.context, askMessageId: record.askMessageId, title: label(row),
          });
          opened = { session: child.session, release: child.release, inheritedUnavailable: row.context === 'fork' && child.forkKind === 'fresh' };
        } else {
          // A branch kept from an earlier attempt: reopen its session (already inside the open queue).
          const session = await this.deps.ensureSession({ ownerUserId: record.ownerUserId, workspaceId: record.workspaceId, nodeId: childNodeId });
          if (!session) throw new Error('its session is no longer available');
          opened = { session, release: await this.deps.acquireRestoreLock(childNodeId), inheritedUnavailable: getNode(childNodeId)?.fresh_context === 1 && row.context === 'fork' };
        }
      } catch (error) {
        await this.mutate(runId, (r, fx) => {
          const thread = r.state.threads[key];
          if (!thread || thread.childNodeId !== childNodeId || thread.steps[0].status !== 'queued') return false;
          thread.childNodeId = getNode(childNodeId) ? childNodeId : null;
          this.endStep(thread.steps[0], 'failed', clamp(`Could not open ${label(row)}: ${errorText(error)}`, MULTI_MODEL_LIMITS.error));
          this.advance(r, fx);
        });
        return;
      }
      let turn = null as { turnId: string; generation: number; attempt: number } | null;
      record = await this.mutate(runId, (r, fx) => {
        const thread = r.state.threads[key];
        if (!thread || thread.childNodeId !== childNodeId || thread.steps[0].status !== 'queued' || thread.steps[0].turnId !== null) return false;
        if (!this.mayStartOn(r, key)) {
          this.settleUnlaunched(thread);
          this.advance(r, fx);
          return;
        }
        const turnId = this.stepTurnId(r, key, thread, 0);
        thread.steps[0].turnId = turnId;
        this.recordTurn(r, turnId, childNodeId, key, 'answer', 0, thread.steps[0].attempt);
        turn = { turnId, generation: thread.generation, attempt: thread.steps[0].attempt };
      }).catch((error) => { opened.release(); throw error; });
      if (!turn) {
        opened.release();
        return;
      }
      const { turnId, generation, attempt } = turn;
      const callerTitle = getNode(record.callerNodeId)?.title ?? null;
      const handle = startPlanTurn(this.turnDeps, {
        ownerUserId: record.ownerUserId,
        workspaceId: record.workspaceId,
        nodeId: childNodeId,
        turnId,
        text: formatPlanPrompt({ callerNodeId: record.callerNodeId, callerTitle, context: row.context, prompt: row.prompt, inheritedUnavailable: opened.inheritedUnavailable }),
        userMetadata: this.planSource(record, { step: 'answer', context: row.context, fromLabel: record.plan.caller.runtimeLabel }, 1),
        opened,
        shouldStart: () => this.mayStart(runId, key),
        beforeStart: (session) => carrySenderTrust(record.callerNodeId, record.callerTurnId, { nodeId: childNodeId, turnId }, session.runtimeId),
        onBegan: () => { void this.markBegan(runId, key, 0, turnId); },
      });
      void handle.outcome.then((outcome) => this.settleStep(runId, key, 0, generation, attempt, turnId, outcome));
      // A new branch holds the queue until its first turn began (forks of one runtime share a client). A kept
      // one leaves once its session is open: its turn may wait behind the user's own turn in that branch.
      if (create) await handle.began;
    });
  }

  /** Start a queued step's turn on a branch that has its child (a review, or a retry of an answer). */
  private startStepTurn(record: MultiModelRunRecord, key: string, index: number, fx: Effects): void {
    const thread = record.state.threads[key];
    const row = record.plan.threads.find((candidate) => candidate.key === key)!;
    const childNodeId = thread.childNodeId!;
    const turnId = this.stepTurnId(record, key, thread, index);
    const step = thread.steps[index];
    step.turnId = turnId;
    this.recordTurn(record, turnId, childNodeId, key, index === 0 ? 'answer' : 'review', index, step.attempt);
    const { generation } = thread;
    const attempt = step.attempt;
    const runId = record.id;
    let text: string;
    let userMetadata: DurableMessageMetadata;
    let peers: PlanPeerAnswer[] = [];
    const fromLabel = record.plan.caller.runtimeLabel;
    if (index === 0) {
      text = formatPlanPrompt({
        callerNodeId: record.callerNodeId, callerTitle: getNode(record.callerNodeId)?.title ?? null, context: row.context, prompt: row.prompt,
        inheritedUnavailable: row.context === 'fork' && getNode(childNodeId)?.fresh_context === 1,
      });
      userMetadata = this.planSource(record, { step: 'answer', context: row.context, fromLabel }, 1);
    } else {
      const missing: PlanMissingThread[] = [];
      for (const { plan, state } of liveThreads(record)) {
        if (plan.key === key) continue;
        const previous = state.steps[index - 1];
        if (previous?.status === 'completed' && previous.turnId && state.childNodeId && !state.stopRequested) {
          peers.push(this.answerOf(plan, state.childNodeId, previous.turnId));
        } else {
          missing.push({ label: label(plan), reason: this.reasonFor(state) });
        }
      }
      text = formatPlanReview({ round: index, rounds: record.plan.reviewRounds, peers, missing });
      userMetadata = this.planSource(record, { step: 'review', round: index, rounds: record.plan.reviewRounds, fromLabel }, 1);
    }
    fx.push(() => {
      const handle = startPlanTurn(this.turnDeps, {
        ownerUserId: record.ownerUserId,
        workspaceId: record.workspaceId,
        nodeId: childNodeId,
        turnId,
        text,
        userMetadata,
        shouldStart: () => this.mayStart(runId, key),
        beforeStart: (session) => {
          if (index === 0) carrySenderTrust(record.callerNodeId, record.callerTurnId, { nodeId: childNodeId, turnId }, session.runtimeId);
          for (const peer of peers) carryReplyTrust({ nodeId: peer.nodeId, turnId: peer.turnId }, { nodeId: childNodeId, turnId }, session.runtimeId);
        },
        onBegan: () => { void this.markBegan(runId, key, index, turnId); },
      });
      void handle.outcome.then((outcome) => this.settleStep(runId, key, index, generation, attempt, turnId, outcome));
    });
  }

  private answerOf(plan: MultiModelThreadPlan, nodeId: string, turnId: string): PlanPeerAnswer {
    return { label: label(plan), context: plan.context, nodeId, turnId, text: this.deps.store.readAnswer(nodeId, turnId)?.content ?? '' };
  }

  private finalOf(plan: MultiModelThreadPlan, thread: MultiModelThreadState): PlanFinalAnswer | null {
    const index = latestCompletedIndex(thread);
    const step = thread.steps[index];
    if (!step?.turnId || !thread.childNodeId) return null;
    return {
      ...this.answerOf(plan, thread.childNodeId, step.turnId),
      firstSummary: thread.steps[0].summary,
      revised: index > 0,
      reviewFailed: thread.steps.slice(index + 1).some((later) => MULTI_MODEL_STEP_RETRYABLE.has(later.status)),
      notices: [...new Set(thread.steps.flatMap((entry) => entry.notice ? [entry.notice] : []))],
    };
  }

  private startSynthesis(record: MultiModelRunRecord, fx: Effects): void {
    const { synthesis } = record.state;
    const threads = liveThreads(record);
    const finals = threads.flatMap(({ plan, state }) => { const final = this.finalOf(plan, state); return final ? [final] : []; });
    const missing = threads.filter(({ state }) => latestCompletedIndex(state) < 0)
      .map(({ plan, state }) => ({ label: label(plan), reason: this.reasonFor(state) }));
    const attempt = synthesis.attempt + 1;
    const turnId = `mm-${record.nativeId.slice(3)}-syn-a${attempt}`;
    Object.assign(synthesis, {
      status: 'queued', turnId, attempt, startedAt: this.now(), endedAt: null, summary: null, error: null,
      messageId: null, totalTokens: null,
    });
    this.recordTurn(record, turnId, record.callerNodeId, null, 'synthesis', 0, attempt);
    const text = formatPlanSynthesis({ runId: record.id, rounds: record.plan.reviewRounds, finals, missing });
    const userMetadata = this.planSource(record, { step: 'synthesis', branches: finals.length + missing.length }, 2);
    this.startCallerTurn(record, turnId, text, userMetadata, finals, fx, (outcome) => this.settleSynthesis(record.id, attempt, turnId, outcome));
  }

  private startAddendum(record: MultiModelRunRecord, keys: string[], fx: Effects): void {
    const { addenda } = record.state;
    const rearmed = addenda.at(-1)?.status === 'pending' ? addenda.at(-1)! : null;
    const n = rearmed ? addenda.length : addenda.length + 1;
    const attempt = rearmed ? rearmed.attempt + 1 : 1;
    const turnId = `mm-${record.nativeId.slice(3)}-add${n}-a${attempt}`;
    const entry = { turnId, keys, status: 'queued' as const, attempt, error: null, messageId: null };
    if (rearmed) addenda[addenda.length - 1] = entry;
    else addenda.push(entry);
    const threads = liveThreads(record).filter(({ plan }) => keys.includes(plan.key));
    for (const { state } of threads) state.addendumTurnId = turnId;
    this.recordTurn(record, turnId, record.callerNodeId, null, 'addendum', 0, attempt);
    const finals = threads.flatMap(({ plan, state }) => { const final = this.finalOf(plan, state); return final ? [final] : []; });
    const text = formatPlanAddendum({ runId: record.id, finals });
    const userMetadata = this.planSource(record, { step: 'addendum', branches: keys.length }, 2);
    this.startCallerTurn(record, turnId, text, userMetadata, finals, fx, (outcome) => this.settleAddendum(record.id, turnId, outcome));
  }

  private startCallerTurn(record: MultiModelRunRecord, turnId: string, text: string, userMetadata: DurableMessageMetadata,
    finals: PlanFinalAnswer[], fx: Effects, settle: (outcome: PlanTurnOutcome) => Promise<unknown>): void {
    const runId = record.id;
    const callerNodeId = record.callerNodeId;
    fx.push(() => {
      const handle = startPlanTurn(this.turnDeps, {
        ownerUserId: record.ownerUserId,
        workspaceId: record.workspaceId,
        nodeId: callerNodeId,
        turnId,
        text,
        userMetadata,
        shouldStart: () => this.mayStart(runId, null),
        beforeStart: (session) => {
          for (const final of finals) carryReplyTrust({ nodeId: final.nodeId, turnId: final.turnId }, { nodeId: callerNodeId, turnId }, session.runtimeId);
        },
        onBegan: (assistantId) => { void this.markBegan(runId, null, 0, turnId, assistantId); },
      });
      void handle.outcome.then(settle);
    });
  }

  /** The turn began: its step (or the synthesis/addendum) is running. */
  private markBegan(runId: string, key: string | null, index: number, turnId: string, assistantId?: string): Promise<unknown> {
    return this.mutate(runId, (r) => {
      if (key !== null) {
        const step = r.state.threads[key]?.steps[index];
        if (!step || step.turnId !== turnId || step.status !== 'queued') return false;
        step.status = 'running';
        step.startedAt = this.now();
        return;
      }
      const target = r.state.synthesis.turnId === turnId ? r.state.synthesis : r.state.addenda.find((addendum) => addendum.turnId === turnId);
      if (!target || target.status !== 'queued') return false;
      target.status = 'running';
      if (target === r.state.synthesis) target.messageId = assistantId ?? null;
    }).catch((error) => log.warn('chat', 'multi-model begin not recorded', { runId, turnId, error: errorText(error) }));
  }

  // ---- Settling ---------------------------------------------------------------

  /**
   * An outcome that arrives while Michi shuts down is shutdown's doing, whatever the runtime reported: a cut-off
   * turn may be finalized completed (with only its preamble) or cancelled. It counts as interrupted, so restart
   * recovery interrupts the run and Retry re-runs it.
   */
  private settledOutcome(outcome: PlanTurnOutcome): PlanTurnOutcome {
    return this.deps.chat.isShuttingDown() ? { kind: 'interrupted' } : outcome;
  }

  private turnOutcome(outcome: PlanTurnOutcome, stoppedByUser: boolean): MultiModelTurnOutcome {
    if (outcome.kind === 'cancelled' && stoppedByUser) return 'stopped';
    return outcome.kind;
  }

  private forgetTurn(turnId: string): void {
    this.orchestratorCancels.delete(turnId);
    this.userStopped.delete(turnId);
    this.turnRefs.delete(turnId);
    this.approvalTitles.delete(turnId);
    this.userAnswered.delete(turnId);
  }

  /** Apply a step turn's outcome to the record (no turn started: recovery uses it too). */
  private applyStepOutcome(record: MultiModelRunRecord, key: string, index: number, outcome: PlanTurnOutcome): void {
    const thread = record.state.threads[key];
    const step = thread.steps[index];
    const turnId = step.turnId!;
    const userStop = this.userStopped.has(turnId);
    if (outcome.kind === 'completed') {
      const answer = thread.childNodeId ? this.deps.store.readAnswer(thread.childNodeId, turnId) : null;
      const visible = stripSentinelsStreamingSafe(answer?.content ?? '').trim();
      this.endStep(step, 'completed', null);
      step.summary = summarizeReply(answer?.content ?? '');
      step.excerpt = visible ? clamp(visible, MULTI_MODEL_LIMITS.excerpt) : null;
      step.totalTokens = answer?.totalTokens ?? null;
    } else if (outcome.kind === 'failed') {
      this.endStep(step, 'failed', clamp(outcome.error, MULTI_MODEL_LIMITS.error));
    } else if (outcome.kind === 'interrupted') {
      this.endStep(step, 'interrupted', null);
    } else {
      const status: MultiModelStepStatus = record.state.cancelRequested ? 'cancelled'
        : thread.stopRequested || userStop ? 'stopped' : 'cancelled';
      this.endStep(step, status, null);
    }
  }

  /**
   * A step turn ended. Its turn row is closed in every case; the step is
   * touched only when the turn is still the thread's current one for that
   * step (not an older attempt, nor a replaced or recreated branch's).
   */
  private settleStep(runId: string, key: string, index: number, generation: number, attempt: number, turnId: string,
    reported: PlanTurnOutcome): Promise<unknown> {
    return this.mutate(runId, (r, fx) => {
      const outcome = this.settledOutcome(reported);
      const thread = r.state.threads[key];
      const step = thread?.steps[index];
      const current = !!thread && !!step && thread.generation === generation && step.attempt === attempt && step.turnId === turnId;
      this.deps.store.settleTurn(turnId, this.turnOutcome(outcome, (current && thread.stopRequested) || this.userStopped.has(turnId)),
        outcome.kind === 'failed' ? outcome.error : null, this.now());
      if (!current) {
        this.forgetTurn(turnId);
        return false;
      }
      if (inFlight(step)) this.applyStepOutcome(r, key, index, outcome);
      this.forgetTurn(turnId);
      this.clearThreadActivity(runId, key);
      this.mirror.withdraw(r.nativeId, key);
      this.advance(r, fx);
    }).catch((error) => log.warn('chat', 'multi-model step not settled', { runId, key, error: errorText(error) }));
  }

  private applySynthesisOutcome(record: MultiModelRunRecord, outcome: PlanTurnOutcome): void {
    const synthesis = record.state.synthesis;
    synthesis.endedAt = this.now();
    if (outcome.kind === 'completed') {
      const answer = this.deps.store.readAnswer(record.callerNodeId, synthesis.turnId!);
      synthesis.status = 'completed';
      if (answer) synthesis.messageId = answer.messageId;
      synthesis.summary = summarizeReply(answer?.content ?? '');
      synthesis.totalTokens = answer?.totalTokens ?? null;
      synthesis.error = null;
    } else if (outcome.kind === 'failed') {
      synthesis.status = 'failed';
      synthesis.error = clamp(outcome.error, MULTI_MODEL_LIMITS.error);
      if (record.status === 'running') this.finish(record, 'failed', `Couldn't write the synthesis: ${synthesis.error}`);
    } else if (outcome.kind === 'interrupted') {
      synthesis.status = 'interrupted';
      // While shutting down the phase stays running; restart recovery finishes it as interrupted.
      if (record.status === 'running' && !this.deps.chat.isShuttingDown()) this.finish(record, 'interrupted', DETAIL.interrupted);
    } else {
      synthesis.status = 'cancelled';
      if (record.status === 'running') this.finish(record, 'cancelled', record.state.cancelRequested ? DETAIL.stopped : DETAIL.synthesisStopped);
    }
  }

  private settleSynthesis(runId: string, attempt: number, turnId: string, reported: PlanTurnOutcome): Promise<unknown> {
    return this.mutate(runId, (r, fx) => {
      const outcome = this.settledOutcome(reported);
      const synthesis = r.state.synthesis;
      this.deps.store.settleTurn(turnId, this.turnOutcome(outcome, this.userStopped.has(turnId)), outcome.kind === 'failed' ? outcome.error : null, this.now());
      this.forgetTurn(turnId);
      if (synthesis.attempt !== attempt || synthesis.turnId !== turnId) return false;
      if (!SYNTHESIS_LIVE.has(synthesis.status)) return;
      this.applySynthesisOutcome(r, outcome);
      this.advance(r, fx);
    }).catch((error) => log.warn('chat', 'multi-model synthesis not settled', { runId, error: errorText(error) }));
  }

  private applyAddendumOutcome(record: MultiModelRunRecord, turnId: string, outcome: PlanTurnOutcome): void {
    const addendum = record.state.addenda.find((entry) => entry.turnId === turnId)!;
    if (outcome.kind === 'completed') {
      addendum.status = 'completed';
      addendum.messageId = this.deps.store.readAnswer(record.callerNodeId, turnId)?.messageId ?? null;
    } else if (outcome.kind === 'failed') {
      addendum.status = 'failed';
      addendum.error = clamp(outcome.error, MULTI_MODEL_LIMITS.error);
    } else if (outcome.kind === 'interrupted') {
      addendum.status = 'interrupted';
    } else {
      addendum.status = 'cancelled';
    }
  }

  private settleAddendum(runId: string, turnId: string, reported: PlanTurnOutcome): Promise<unknown> {
    return this.mutate(runId, (r, fx) => {
      const outcome = this.settledOutcome(reported);
      const addendum = r.state.addenda.find((entry) => entry.turnId === turnId);
      this.deps.store.settleTurn(turnId, this.turnOutcome(outcome, this.userStopped.has(turnId)), outcome.kind === 'failed' ? outcome.error : null, this.now());
      this.forgetTurn(turnId);
      if (!addendum) return false;
      if (!SYNTHESIS_LIVE.has(addendum.status)) return;
      this.applyAddendumOutcome(r, turnId, outcome);
      this.advance(r, fx);
    }).catch((error) => log.warn('chat', 'multi-model addendum not settled', { runId, error: errorText(error) }));
  }

  // ---- Live frames, cancels and answers ---------------------------------------

  private activityOf(runId: string): LiveActivity {
    let activity = this.activity.get(runId);
    if (!activity) {
      activity = { now: {}, excerpt: {}, text: {}, afterTool: new Set() };
      this.activity.set(runId, activity);
    }
    return activity;
  }

  private clearThreadActivity(runId: string, key: string): void {
    const activity = this.activity.get(runId);
    if (!activity) return;
    delete activity.now[key];
    delete activity.excerpt[key];
    delete activity.text[key];
    activity.afterTool.delete(key);
  }

  private clearActivity(runId: string): void {
    const activity = this.activity.get(runId);
    if (activity?.timer) clearTimeout(activity.timer);
    this.activity.delete(runId);
  }

  /** Live-activity-only changes commit at most once per liveCommitMs per run. */
  private touchActivity(runId: string): void {
    const activity = this.activityOf(runId);
    if (activity.timer) return;
    const every = this.deps.liveCommitMs ?? LIVE_COMMIT_MS;
    const wait = Math.max(0, (this.lastCommitAt.get(runId) ?? 0) + every - this.now());
    activity.timer = setTimeout(() => {
      activity.timer = undefined;
      const record = this.records.get(runId);
      if (record?.status !== 'running') return;
      try { this.commitHub(record); } catch (error) {
        log.warn('chat', 'multi-model live commit failed', { runId, error: errorText(error) });
      }
    }, wait);
  }

  private onFrame(event: ChatStreamEvent): void {
    const turnId = event.data.turnId;
    if (!turnId?.startsWith('mm-')) return;
    const ref = this.turnRefs.get(turnId);
    if (!ref || ref.key === null || event.data.nodeId !== ref.nodeId) return;
    const { runId, key, step } = ref;
    switch (event.event) {
      case CHAT_STREAM_EVENTS.toolCall: {
        const activity = this.activityOf(runId);
        activity.now[key] = `Running ${clamp(event.data.title || 'a tool', NOW_TOOL_TITLE)}`;
        activity.afterTool.add(key);
        this.touchActivity(runId);
        return;
      }
      case CHAT_STREAM_EVENTS.chunk: {
        if (!event.data.text) return;
        const activity = this.activityOf(runId);
        if (activity.afterTool.delete(key) || activity.now[key] === undefined) activity.now[key] = 'Writing the answer';
        const text = ((activity.text[key] ?? '') + event.data.text).slice(-LIVE_TEXT_KEEP);
        activity.text[key] = text;
        const visible = stripSentinelsStreamingSafe(text).trim();
        activity.excerpt[key] = visible ? visible.slice(-MULTI_MODEL_LIMITS.excerpt) : undefined;
        this.touchActivity(runId);
        return;
      }
      case CHAT_STREAM_EVENTS.permissionRequest: {
        let titles = this.approvalTitles.get(turnId);
        if (!titles) {
          titles = new Map();
          this.approvalTitles.set(turnId, titles);
        }
        titles.set(event.data.requestId, event.data.title);
        void this.setWaiting(runId, key, step, turnId, true, null);
        return;
      }
      case CHAT_STREAM_EVENTS.permissionResolved:
        void this.setWaiting(runId, key, step, turnId, false, null, event.data.requestId);
        return;
      case CHAT_STREAM_EVENTS.userInputRequest:
        this.activityOf(runId).now[key] = 'Waiting for your answer in the branch';
        void this.setWaiting(runId, key, step, turnId, true, 'question');
        return;
      case CHAT_STREAM_EVENTS.userInputResolved:
        void this.setWaiting(runId, key, step, turnId, false, 'question');
        return;
      case CHAT_STREAM_EVENTS.done:
      case CHAT_STREAM_EVENTS.error: {
        const record = this.records.get(runId);
        if (record) this.mirror.withdraw(record.nativeId, key);
        return;
      }
      default:
    }
  }

  /**
   * A permission or question of the step's own turn: waiting (and the approval mirrored), or back to running.
   * A resolved request (`resolvedRequestId`) leaves the step waiting while another request of its turn is pending.
   */
  private setWaiting(runId: string, key: string, index: number, turnId: string, waiting: boolean, kind: 'question' | null,
    resolvedRequestId?: number): Promise<unknown> {
    return this.mutate(runId, (r) => {
      const thread = r.state.threads[key];
      const step = thread?.steps[index];
      if (!thread || !step || step.turnId !== turnId || !inFlight(step)) return false;
      let noticed = false;
      if (kind === null) {
        if (!waiting && resolvedRequestId !== undefined) {
          noticed = this.noticeUnanswered(r, thread, step, turnId, resolvedRequestId);
          const pending = this.deps.chat.getPendingPermission(thread.childNodeId!);
          if (pending && pending.turnId === turnId && pending.requestId !== resolvedRequestId) waiting = true;
        }
        if (waiting) this.mirror.mirror({ ownerUserId: r.ownerUserId, nativeId: r.nativeId, threadKey: key, step: index, childNodeId: thread.childNodeId!, turnId });
        else this.mirror.withdraw(r.nativeId, key);
      } else if (!waiting) {
        const activity = this.activity.get(runId);
        if (activity) delete activity.now[key];
      }
      const next: MultiModelStepStatus = waiting ? 'waiting' : 'running';
      if (step.status === next) return noticed ? undefined : false;
      step.status = next;
      step.startedAt ??= this.now();
    }).catch((error) => log.warn('chat', 'multi-model wait state not recorded', { runId, key, error: errorText(error) }));
  }

  /**
   * A request of the step's turn resolved. Without an answer from the user and without a stop, the runtime gave up
   * waiting (its approval timeout) and denied it: the step says so, and keeps saying so once it completes, so neither
   * the user nor the synthesis takes the denial for the branch's own doing. True when the notice was set.
   */
  private noticeUnanswered(record: MultiModelRunRecord, thread: MultiModelThreadState, step: MultiModelStepState, turnId: string,
    requestId: number): boolean {
    const titles = this.approvalTitles.get(turnId);
    const title = titles?.get(requestId);
    if (title === undefined) return false;
    titles!.delete(requestId);
    if (this.userAnswered.get(turnId)?.has(requestId)) return false;
    if (thread.stopRequested || record.state.cancelRequested || this.userStopped.has(turnId) || this.orchestratorCancels.has(turnId)
      || this.deps.chat.isShuttingDown()) return false;
    step.notice = clamp(`${APPROVAL_TIMED_OUT}${title.trim() || 'a tool'}`, MULTI_MODEL_LIMITS.notice);
    return true;
  }

  private onPermissionAnswered(event: PermissionAnswered): void {
    for (const [turnId, ref] of this.turnRefs) {
      if (ref.key === null || ref.nodeId !== event.nodeId || (event.turnId && event.turnId !== turnId)) continue;
      // Synchronous: the answer's permission_resolved frame was broadcast just before, and is applied after this.
      let answered = this.userAnswered.get(turnId);
      if (!answered) {
        answered = new Set();
        this.userAnswered.set(turnId, answered);
      }
      answered.add(event.requestId);
      void this.setWaiting(ref.runId, ref.key, ref.step, turnId, false, null, event.requestId);
    }
  }

  /** A Stop from a pane (child, or the caller on the synthesis/addendum turn); the orchestrator's own cancels are ignored. */
  private onCancel(turnId: string): void {
    if (!turnId.startsWith('mm-') || this.orchestratorCancels.has(turnId)) return;
    const turn = this.deps.store.turn(turnId);
    if (turn && turn.outcome === null) this.userStopped.add(turnId);
  }

  // ---- Restart recovery -------------------------------------------------------

  private recoverRun(record: MultiModelRunRecord): void {
    if (record.status === 'proposed') {
      if (this.cancelIfCallerGone(record)) {
        if (!this.deps.store.saveRun(record, record.revision, this.now())) return;
      }
      this.records.set(record.id, record);
      this.commitHub(record);
      this.syncControls(record);
      return;
    }
    let cutOff = false;
    // 1. Settle what the turns' durable receipts say.
    for (const turn of this.deps.store.openTurns(record.id)) {
      const status = this.deps.chat.requestedTurnStatus(turn.turnId);
      const error = this.deps.turnError(turn.turnId);
      const outcome: PlanTurnOutcome = status === 'completed' ? { kind: 'completed' }
        : status === 'cancelled' ? { kind: 'cancelled' }
        : status === 'error' && error !== BACKEND_RESTARTED_ERROR ? { kind: 'failed', error: error || 'The turn failed' }
        : { kind: 'interrupted' };
      if (outcome.kind === 'interrupted') cutOff = true;
      this.deps.store.settleTurn(turn.turnId, outcome.kind, outcome.kind === 'failed' ? outcome.error : null, this.now());
      this.applyRecoveredOutcome(record, turn.turnId, outcome);
    }
    // 2. Branches created without a recorded turn (a crash in between), and strays.
    this.reconcileChildren(record);
    // 3. Anything still queued or running was cut off, and so was a row whose last step shutdown interrupted.
    for (const thread of Object.values(record.state.threads)) {
      for (const step of thread.steps) {
        if (!inFlight(step)) continue;
        this.endStep(step, 'interrupted', null);
        cutOff = true;
      }
    }
    if (liveThreads(record).some(({ state }) => state.steps[latestRunIndex(state)]?.status === 'interrupted')) cutOff = true;
    for (const target of [record.state.synthesis, ...record.state.addenda]) {
      if (!SYNTHESIS_LIVE.has(target.status) && target.status !== 'interrupted') continue;
      target.status = 'interrupted';
      cutOff = true;
    }
    // 4. Finished, or interrupted for Retry.
    const phase = cutOff ? null : this.terminalPhase(record.state);
    if (phase) {
      record.status = phase.phase;
      record.endedAt = this.now();
      record.state.statusDetail = phase.detail;
    } else {
      record.status = 'interrupted';
      record.endedAt = this.now();
      record.state.statusDetail = DETAIL.interrupted;
    }
    if (!this.deps.store.saveRun(record, record.revision, this.now())) return;
    this.records.set(record.id, record);
    this.commitHub(record);
    this.syncControls(record);
    this.forgetEnded(record);
  }

  private applyRecoveredOutcome(record: MultiModelRunRecord, turnId: string, outcome: PlanTurnOutcome): void {
    for (const thread of Object.values(record.state.threads)) {
      const index = thread.steps.findIndex((step) => step.turnId === turnId);
      if (index >= 0 && inFlight(thread.steps[index])) {
        this.applyStepOutcome(record, thread.key, index, outcome);
        return;
      }
    }
    if (record.state.synthesis.turnId === turnId && SYNTHESIS_LIVE.has(record.state.synthesis.status)) {
      const before = record.status;
      this.applySynthesisOutcome(record, outcome);
      record.status = before;
      return;
    }
    const addendum = record.state.addenda.find((entry) => entry.turnId === turnId);
    if (addendum && SYNTHESIS_LIVE.has(addendum.status)) this.applyAddendumOutcome(record, turnId, outcome);
  }

  private reconcileChildren(record: MultiModelRunRecord): void {
    const owner = record.ownerUserId;
    for (const thread of Object.values(record.state.threads)) {
      const childNodeId = thread.childNodeId;
      if (!childNodeId || this.deps.store.hasTurnOnNode(record.id, childNodeId)) continue;
      if (!getNode(childNodeId) || rollbackProvisionalSpawnNode(childNodeId, record.workspaceId, owner)) thread.childNodeId = null;
    }
    const known = new Set(Object.values(record.state.threads).flatMap((thread) =>
      [thread.childNodeId, ...thread.previousChildNodeIds].filter((id): id is string => !!id)));
    for (const { nodeId } of this.deps.store.childNodesOfRun(record.id)) {
      if (known.has(nodeId) || rollbackProvisionalSpawnNode(nodeId, record.workspaceId, owner)) continue;
      // A stray of the caller goes to the row it was titled for (`<runtime> · <model>`).
      const node = getNode(nodeId);
      const row = node?.parent_node_id === record.callerNodeId ? record.plan.threads.find((candidate) => label(candidate) === node.title) : undefined;
      const thread = row ? record.state.threads[row.key] : undefined;
      if (thread) thread.previousChildNodeIds.push(nodeId);
      else log.warn('chat', 'multi-model branch not reconciled', { runId: record.id, nodeId });
    }
  }
}
