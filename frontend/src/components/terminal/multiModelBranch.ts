import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { MultiModelRunView, MultiModelThreadView, ThreadMessagePlanSource } from 'michi-shared';
import type { ChatMessage, ChatNodeState } from '../../state/chatTypes';
import type { AgentResourceIdentity } from '../../state/agentIdentity';
import { backendConnectionIdForWorkspace } from '../../config/backendConnections';
import {
  useOptionalWorkflowDomain,
  workflowRunKey,
  type WorkflowDomainContextValue,
  type WorkflowDomainState,
} from '../../state/workflowDomain';
import { retryMultiModelThread } from '../../services/api/multiModelRuns';
import { threadActions } from './multiModel/multiModelPresentation';
import { openWorkflowRunDrawer } from './backgroundWork/backgroundWorkEvents';

/**
 * A multi-model branch and the run that made it: the banner's Open plan,
 * and Retry of a failed plan step. The orchestrator follows only the turns
 * it started (its `mm-` turn ids), so a step is retried through the run's
 * row; resending the prompt in the pane would leave the card Failed.
 */

/** This branch's row: the one it answers in, else one it answered in before Replace model (`current` false). */
export function branchRow(
  view: Pick<MultiModelRunView, 'threads'>,
  nodeId: string,
): { thread: MultiModelThreadView; current: boolean } | undefined {
  const current = view.threads.find((thread) => thread.childNodeId === nodeId);
  if (current) return { thread: current, current: true };
  const earlier = view.threads.find((thread) => thread.previousChildNodeIds?.includes(nodeId));
  return earlier ? { thread: earlier, current: false } : undefined;
}

/** The step the drawer expands on the row: the latest that ran (0 the answer, r review round r). */
export function rowFocusStep(thread: Pick<MultiModelThreadView, 'steps'>): number {
  for (let index = thread.steps.length - 1; index > 0; index -= 1) {
    const { status } = thread.steps[index];
    if (status !== 'pending' && status !== 'skipped') return index;
  }
  return 0;
}

/** The plan step (answer or review) the conversation's last turn ran, when that turn failed. */
export function failedPlanStep(node: Pick<ChatNodeState, 'status'> & { messages: readonly ChatMessage[] }): ThreadMessagePlanSource | undefined {
  if (node.status !== 'error') return undefined;
  const plan = node.messages.findLast((message) => message.role === 'user')?.threadMessage?.plan;
  return plan?.step === 'answer' || plan?.step === 'review' ? plan : undefined;
}

export interface MultiModelBranchControls {
  /** Open the caller's Background work drawer on this branch's row. */
  openPlan: () => void;
  /** Retry the row through its run; absent while the run is unknown or the row cannot retry. */
  retry?: () => void;
  /** The row runs again: a retry is on its way. */
  retrying: boolean;
  /** A command on the run is in flight; Retry waits for it. */
  busy: boolean;
  /** Why the run refused a Retry made here. */
  error?: string;
}

interface Summary {
  /** The store has the run. */
  known: boolean;
  ownerNodeId?: string;
  retryable: boolean;
  retrying: boolean;
  busy: boolean;
  error?: string;
}

const UNKNOWN: Summary = { known: false, retryable: false, retrying: false, busy: false };

function summarize(state: WorkflowDomainState, runKey: string, nodeId: string): Summary {
  const run = state.runs[runKey]?.value;
  if (!run) return UNKNOWN;
  const row = run.multiModel ? branchRow(run.multiModel, nodeId) : undefined;
  const thread = row?.current ? row.thread : undefined;
  // The same rules as the run's cards (Retry waits while the run's turns settle).
  const actions = thread && run.multiModel ? threadActions(run.multiModel, thread) : {};
  return {
    known: true,
    ownerNodeId: run.nodeId ?? undefined,
    retryable: !!actions.retry && !actions.retry.disabled,
    retrying: !!actions.stop,
    busy: state.pending[runKey] !== undefined,
    error: state.errors[runKey],
  };
}

function sameSummary(a: Summary, b: Summary): boolean {
  return a.known === b.known && a.ownerNodeId === b.ownerNodeId && a.retryable === b.retryable && a.retrying === b.retrying
    && a.busy === b.busy && a.error === b.error;
}

/** One fetch per run at a time, however many of its branches mount at once. */
const loads = new Map<string, Promise<void>>();

function loadOnce(load: WorkflowDomainContextValue['load'], identity: AgentResourceIdentity, runKey: string): void {
  if (loads.has(runKey)) return;
  const pending = load(identity).catch(() => {}).finally(() => loads.delete(runKey));
  loads.set(runKey, pending);
}

const noSubscription = () => () => {};

/**
 * The controls of a branch a multi-model plan created (`runId` is the node's
 * multiModelRunId); null for any other conversation. Fetches the run when the
 * store does not have it (a branch opened without its caller), so the row's
 * state is known.
 */
export function useMultiModelBranch({ nodeId, workspaceId, runId, parentNodeId }: {
  nodeId: string;
  workspaceId?: string;
  runId?: string;
  parentNodeId?: string;
}): MultiModelBranchControls | null {
  const domain = useOptionalWorkflowDomain();
  const conn = workspaceId && runId ? backendConnectionIdForWorkspace(workspaceId) : undefined;
  const identity = useMemo<AgentResourceIdentity | null>(
    () => (conn && runId ? { backendConnectionId: conn, id: runId } : null),
    [conn, runId],
  );
  const runKey = identity ? workflowRunKey(identity) : '';
  const store = domain?.store;
  const cache = useRef<Summary>(UNKNOWN);
  const select = useCallback(() => {
    const next = store && runKey ? summarize(store.getState(), runKey, nodeId) : UNKNOWN;
    if (!sameSummary(cache.current, next)) cache.current = next;
    return cache.current;
  }, [store, runKey, nodeId]);
  const summary = useSyncExternalStore(store?.subscribe ?? noSubscription, select, select);

  const { known } = summary;
  const load = domain?.load;
  useEffect(() => {
    if (!known && load && identity) loadOnce(load, identity, runKey);
  }, [known, load, identity, runKey]);

  // Read when clicked, so a control rendered earlier acts on the run as it is now.
  const openPlan = useCallback(() => {
    const run = store?.getState().runs[runKey]?.value;
    const owner = run?.nodeId ?? parentNodeId;
    if (!owner || !runKey) return;
    const row = run?.multiModel ? branchRow(run.multiModel, nodeId) : undefined;
    openWorkflowRunDrawer(owner, runKey, row
      ? { threadKey: row.thread.key, ...(row.current ? { step: rowFocusStep(row.thread) } : {}) }
      : undefined);
  }, [store, runKey, parentNodeId, nodeId]);

  const [retriedHere, setRetriedHere] = useState(false);
  const retry = useCallback(() => {
    if (!domain || !identity) return;
    const state = domain.store.getState();
    if (state.pending[runKey] !== undefined) return;
    const view = state.runs[runKey]?.value.multiModel;
    const thread = view?.threads.find((candidate) => candidate.childNodeId === nodeId);
    const action = view && thread ? threadActions(view, thread).retry : undefined;
    if (!thread || !action || action.disabled) return;
    setRetriedHere(true);
    void domain.perform(identity, 'thread', () => retryMultiModelThread(identity.backendConnectionId, identity.id, thread.key));
  }, [domain, identity, runKey, nodeId]);

  const hasOwner = !!(summary.ownerNodeId ?? parentNodeId);
  const { retryable, retrying, busy } = summary;
  const error = retriedHere && retryable ? summary.error : undefined;
  return useMemo(() => {
    if (!runKey || !hasOwner) return null;
    return {
      openPlan,
      ...(retryable ? { retry } : {}),
      retrying,
      busy,
      ...(error ? { error } : {}),
    };
  }, [runKey, hasOwner, openPlan, retry, retryable, retrying, busy, error]);
}
