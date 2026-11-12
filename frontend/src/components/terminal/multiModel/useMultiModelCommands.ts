import { useMemo } from 'react';
import type { MultiModelModelPick, MultiModelPlanEdit, WorkflowRunDtoV1 } from 'michi-shared';
import { useOptionalWorkflowDomain, type WorkflowPendingKind } from '../../../state/workflowDomain';
import type { AgentResourceIdentity } from '../../../state/agentIdentity';
import {
  cancelMultiModelRun,
  editMultiModelPlan,
  replaceMultiModelThread,
  retryMultiModelRun,
  retryMultiModelThread,
  startMultiModelRun,
  stopMultiModelRun,
  stopMultiModelThread,
} from '../../../services/api/multiModelRuns';

export interface MultiModelCommands {
  edit(edit: MultiModelPlanEdit): void;
  start(): void;
  cancel(): void;
  stop(): void;
  retryRun(): void;
  stopThread(key: string): void;
  retryThread(key: string): void;
  replaceThread(key: string, pick: MultiModelModelPick): void;
  answer(approvalId: string, optionId: string): void;
}

/**
 * A multi-model run's commands for the chat card and the drawer, through
 * the workflow domain (pending, then the answered run or its error); null
 * without a domain or a run.
 */
export function useMultiModelCommands(identity: AgentResourceIdentity | null): MultiModelCommands | null {
  const domain = useOptionalWorkflowDomain();
  const conn = identity?.backendConnectionId;
  const id = identity?.id;
  return useMemo(() => {
    if (!domain || conn === undefined || id === undefined) return null;
    const resource = { backendConnectionId: conn, id };
    const perform = (kind: WorkflowPendingKind, call: () => Promise<WorkflowRunDtoV1>) => { void domain.perform(resource, kind, call); };
    return {
      edit: (edit) => perform('edit', () => editMultiModelPlan(conn, id, edit)),
      start: () => perform('start', () => startMultiModelRun(conn, id)),
      cancel: () => perform('cancel', () => cancelMultiModelRun(conn, id)),
      stop: () => perform('stop', () => stopMultiModelRun(conn, id)),
      retryRun: () => perform('retry', () => retryMultiModelRun(conn, id)),
      stopThread: (key) => perform('thread', () => stopMultiModelThread(conn, id, key)),
      retryThread: (key) => perform('thread', () => retryMultiModelThread(conn, id, key)),
      replaceThread: (key, pick) => perform('thread', () => replaceMultiModelThread(conn, id, key, pick)),
      answer: (approvalId, optionId) => { void domain.answer(resource, approvalId, optionId); },
    };
  }, [domain, conn, id]);
}
