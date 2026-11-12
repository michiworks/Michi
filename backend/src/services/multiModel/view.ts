/**
 * A multi-model run's UI snapshot: the MultiModelRunView both cards render,
 * and the workflow run fields generic consumers (counts, WorkflowRunPane)
 * read. Pure: plan + state + the in-memory live extras.
 */
import {
  MULTI_MODEL_LIMITS,
  MULTI_MODEL_SYNTHESIS_LEAF_ID,
  multiModelLeafId,
  type MultiModelRunView,
  type MultiModelStepStatus,
  type MultiModelStepView,
  type MultiModelSynthesisStatus,
  type MultiModelSynthesisView,
  type MultiModelThreadView,
  type WorkflowNodeDto,
  type WorkflowNodeStatus,
  type WorkflowRunDtoV1,
  type WorkflowRunStatus,
} from 'michi-shared';
import type { MultiModelRunRecord } from './store';
import type { MultiModelStepState, MultiModelThreadPlan } from './types';

export interface LiveRunExtras {
  /** threadKey → live activity line. */
  now: Record<string, string | undefined>;
  /** threadKey → last 1200 visible chars streamed by the in-flight step turn. */
  excerpt: Record<string, string | undefined>;
  /** store.openTurns(runId).length > 0. */
  settling: boolean;
  /** Keys of the rows whose branch was deleted or archived. */
  branchGone: ReadonlySet<string>;
}

const PHASE_STATUS: Record<MultiModelRunRecord['status'], WorkflowRunStatus> = {
  proposed: 'paused',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'cancelled',
};

const STEP_NODE_STATUS: Record<MultiModelStepStatus, WorkflowNodeStatus> = {
  pending: 'queued',
  queued: 'queued',
  running: 'running',
  waiting: 'running',
  completed: 'completed',
  failed: 'failed',
  stopped: 'cancelled',
  cancelled: 'cancelled',
  interrupted: 'cancelled',
  skipped: 'skipped',
};

const SYNTHESIS_NODE_STATUS: Record<MultiModelSynthesisStatus, WorkflowNodeStatus> = {
  pending: 'queued',
  queued: 'queued',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'cancelled',
  skipped: 'skipped',
};

const LIVE_STATUSES = new Set<MultiModelStepStatus>(['running', 'waiting']);

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null)) as T;
}

function isTerminal(record: MultiModelRunRecord): boolean {
  return record.status !== 'proposed' && record.status !== 'running';
}

function stepView(step: MultiModelStepState, index: number, live: string | undefined, now: string | undefined): MultiModelStepView {
  const running = LIVE_STATUSES.has(step.status);
  return definedOnly<MultiModelStepView>({
    kind: index === 0 ? 'answer' : 'review',
    round: index,
    status: step.status,
    attempt: step.attempt > 0 ? step.attempt : undefined,
    turnId: step.turnId ?? undefined,
    startedAt: step.startedAt ?? undefined,
    endedAt: step.endedAt ?? undefined,
    summary: step.summary ?? undefined,
    error: step.error ?? undefined,
    now: running ? now : undefined,
    excerpt: (running ? live : undefined) ?? step.excerpt ?? undefined,
    notice: step.notice ?? undefined,
  });
}

function threadView(record: MultiModelRunRecord, plan: MultiModelThreadPlan, live: LiveRunExtras): MultiModelThreadView {
  const state = record.state.threads[plan.key];
  const steps = state?.steps ?? [];
  const current = steps.findIndex((step) => LIVE_STATUSES.has(step.status));
  const view: MultiModelThreadView = {
    key: plan.key,
    runtimeId: plan.runtimeId,
    providerId: plan.providerId,
    modelId: plan.modelId,
    reasoning: plan.reasoning,
    runtimeLabel: plan.runtimeLabel,
    modelLabel: plan.modelLabel,
    context: plan.context,
    promptPreview: clamp(plan.prompt, MULTI_MODEL_LIMITS.promptPreview),
    childNodeId: state?.childNodeId ?? null,
    steps: steps.map((step, index) => stepView(step, index,
      index === current ? live.excerpt[plan.key] : undefined, index === current ? live.now[plan.key] : undefined)),
  };
  if (plan.removed) view.removed = true;
  if (plan.addedByUser) view.addedByUser = true;
  if (state?.previousChildNodeIds.length) view.previousChildNodeIds = [...state.previousChildNodeIds];
  if (state?.late) view.late = true;
  if (live.branchGone.has(plan.key)) view.branchGone = true;
  return view;
}

function synthesisView(record: MultiModelRunRecord): MultiModelSynthesisView {
  const { synthesis, addenda } = record.state;
  const view = definedOnly<MultiModelSynthesisView>({
    status: synthesis.status,
    turnId: synthesis.turnId ?? undefined,
    messageId: synthesis.messageId ?? undefined,
    startedAt: synthesis.startedAt ?? undefined,
    endedAt: synthesis.endedAt ?? undefined,
    summary: synthesis.summary ?? undefined,
    error: synthesis.error ?? undefined,
  });
  if (addenda.length > 0) {
    view.addenda = addenda.length;
    view.lastAddendumStatus = addenda[addenda.length - 1].status;
  }
  return view;
}

/** Sum of the reported usage over the run's steps, synthesis included; undefined when none reported. */
function totalTokens(record: MultiModelRunRecord): number | undefined {
  const counts = [
    ...Object.values(record.state.threads).flatMap((thread) => thread.steps.map((step) => step.totalTokens)),
    record.state.synthesis.totalTokens,
  ].filter((value): value is number => typeof value === 'number');
  return counts.length > 0 ? counts.reduce((sum, value) => sum + value, 0) : undefined;
}

export function multiModelView(record: MultiModelRunRecord, live: LiveRunExtras): MultiModelRunView {
  const { plan, state } = record;
  const view: MultiModelRunView = {
    version: 1,
    phase: record.status,
    title: plan.title,
    askPreview: plan.askPreview,
    callerNodeId: record.callerNodeId,
    callerMessageId: record.callerMessageId,
    callerRuntimeId: plan.caller.runtimeId,
    callerRuntimeLabel: plan.caller.runtimeLabel,
    callerModelLabel: plan.caller.modelLabel,
    permissionMode: state.permissionMode,
    reviewRounds: plan.reviewRounds,
    threads: plan.threads.map((thread) => threadView(record, thread, live)),
    synthesis: synthesisView(record),
  };
  if (state.approveForMe) view.approveForMe = true;
  const tokens = totalTokens(record);
  if (tokens !== undefined) view.totalTokens = tokens;
  if (record.startedAt !== null) view.startedAt = record.startedAt;
  const lastMessageId = [...state.addenda].reverse().find((addendum) => addendum.messageId)?.messageId ?? state.synthesis.messageId;
  if (lastMessageId) view.lastMessageId = lastMessageId;
  if (live.settling) view.settling = true;
  return view;
}

function workflowNodes(record: MultiModelRunRecord): WorkflowNodeDto[] {
  const { plan, state } = record;
  const rounds = plan.reviewRounds;
  const nodes: WorkflowNodeDto[] = [{ id: 'answer', kind: 'phase', title: 'Answer separately', status: 'queued' }];
  for (let round = 1; round <= rounds; round += 1) {
    nodes.push({ id: `review-${round}`, kind: 'phase', title: rounds === 1 ? 'Review' : `Review ${round}/${rounds}`, status: 'queued' });
  }
  nodes.push({ id: 'synthesis', kind: 'phase', title: 'Synthesis', status: 'queued' });
  const leaves: WorkflowNodeDto[] = [];
  for (const thread of plan.threads) {
    if (thread.removed) continue;
    const steps = state.threads[thread.key]?.steps ?? [];
    steps.forEach((step, index) => {
      leaves.push(definedOnly<WorkflowNodeDto>({
        id: multiModelLeafId(thread.key, index),
        parentId: index === 0 ? 'answer' : `review-${index}`,
        kind: 'agent',
        title: `${thread.runtimeLabel} · ${thread.modelLabel}`,
        status: STEP_NODE_STATUS[step.status],
        agentName: thread.runtimeLabel,
        model: thread.modelLabel,
        prompt: index === 0 ? clamp(thread.prompt, 400) : undefined,
        result: step.summary ?? undefined,
        error: step.error ?? undefined,
        startedAt: step.startedAt ?? undefined,
        endedAt: step.endedAt ?? undefined,
        attempt: step.attempt > 0 ? step.attempt : undefined,
      }));
    });
  }
  const synthesis = state.synthesis;
  if (record.startedAt !== null) {
    leaves.push(definedOnly<WorkflowNodeDto>({
      id: MULTI_MODEL_SYNTHESIS_LEAF_ID,
      parentId: 'synthesis',
      kind: 'agent',
      title: `${plan.caller.runtimeLabel} · ${plan.caller.modelLabel}`,
      status: SYNTHESIS_NODE_STATUS[synthesis.status],
      agentName: plan.caller.runtimeLabel,
      model: plan.caller.modelLabel,
      result: synthesis.summary ?? undefined,
      error: synthesis.error ?? undefined,
      startedAt: synthesis.startedAt ?? undefined,
      endedAt: synthesis.endedAt ?? undefined,
      attempt: synthesis.attempt > 0 ? synthesis.attempt : undefined,
    }));
  }
  // A phase reads as its leaves: running while any runs, completed once all ended; failed only when one failed
  // (an intentional stop is not an error).
  for (const phase of nodes) {
    const children = leaves.filter((leaf) => leaf.parentId === phase.id);
    if (children.some((leaf) => leaf.status === 'running')) phase.status = 'running';
    else if (children.length > 0 && children.every((leaf) => leaf.status !== 'queued')) {
      phase.status = children.some((leaf) => leaf.status === 'completed') ? 'completed'
        : children.every((leaf) => leaf.status === 'skipped') ? 'skipped'
        : children.some((leaf) => leaf.status === 'failed') ? 'failed' : 'cancelled';
    }
  }
  return [...nodes, ...leaves];
}

/**
 * The workflow run fields this run owns, every key present (undefined when
 * absent) so `{ ...run, ...patch }` overwrites what hub.recover() wrote into
 * a re-attached or retried run.
 */
export function workflowRunPatch(record: MultiModelRunRecord, live: LiveRunExtras): Pick<WorkflowRunDtoV1,
  'name' | 'description' | 'status' | 'statusDetail' | 'result' | 'nodes' | 'startedAt' | 'endedAt' | 'usage' | 'multiModel'> {
  const tokens = totalTokens(record);
  return {
    name: record.plan.title,
    description: record.plan.askPreview || undefined,
    status: PHASE_STATUS[record.status],
    statusDetail: record.state.statusDetail ?? undefined,
    result: record.state.synthesis.summary ?? undefined,
    nodes: workflowNodes(record),
    startedAt: record.createdAt,
    endedAt: isTerminal(record) ? record.endedAt ?? undefined : undefined,
    usage: tokens !== undefined ? { totalTokens: tokens } : undefined,
    multiModel: multiModelView(record, live),
  };
}
