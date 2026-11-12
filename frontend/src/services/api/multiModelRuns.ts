import {
  parseReadyModelsDto,
  type MultiModelModelPick,
  type MultiModelPlanEdit,
  type ReadyModelsDto,
  type WorkflowRunDtoV1,
} from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';
import { backendFetch } from './backendRequest';
import { jsonResponse } from './httpError';
import { requestRun } from './workflowRuns';

/**
 * Multi-model run commands (backend routes/multiModelRuns.ts). Each answers
 * with the updated run, like the workflow-run controls; approvals still go
 * through answerWorkflowApproval.
 */

function runUrl(backendConnectionId: string, runId: string, path: string): string {
  return `${backendApiBase(backendConnectionId)}/multi-model-runs/${encodeURIComponent(runId)}${path}`;
}

function threadPath(key: string, command: 'stop' | 'retry' | 'replace'): string {
  return `/threads/${encodeURIComponent(key)}/${command}`;
}

function send(url: string, operation: string, method: 'POST' | 'PATCH', body?: unknown): Promise<WorkflowRunDtoV1> {
  return requestRun(url, operation, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

/** The runtimes and models ready right now, for the plan card's model picker. */
export async function fetchReadyModels(backendConnectionId: string, workspaceId: string, signal?: AbortSignal): Promise<ReadyModelsDto> {
  const url = `${backendApiBase(backendConnectionId)}/multi-model/ready-models?${new URLSearchParams({ workspaceId })}`;
  const dto = parseReadyModelsDto(await jsonResponse(await backendFetch(url, { signal }), 'fetchReadyModels'));
  if (!dto) throw new Error('fetchReadyModels returned a malformed list');
  return dto;
}

export function editMultiModelPlan(backendConnectionId: string, runId: string, edit: MultiModelPlanEdit): Promise<WorkflowRunDtoV1> {
  return send(runUrl(backendConnectionId, runId, '/plan'), 'editMultiModelPlan', 'PATCH', edit);
}

export function startMultiModelRun(backendConnectionId: string, runId: string): Promise<WorkflowRunDtoV1> {
  return send(runUrl(backendConnectionId, runId, '/start'), 'startMultiModelRun', 'POST');
}

export function cancelMultiModelRun(backendConnectionId: string, runId: string): Promise<WorkflowRunDtoV1> {
  return send(runUrl(backendConnectionId, runId, '/cancel'), 'cancelMultiModelRun', 'POST');
}

export function stopMultiModelRun(backendConnectionId: string, runId: string): Promise<WorkflowRunDtoV1> {
  return send(runUrl(backendConnectionId, runId, '/stop'), 'stopMultiModelRun', 'POST');
}

export function retryMultiModelRun(backendConnectionId: string, runId: string): Promise<WorkflowRunDtoV1> {
  return send(runUrl(backendConnectionId, runId, '/retry'), 'retryMultiModelRun', 'POST');
}

export function stopMultiModelThread(backendConnectionId: string, runId: string, key: string): Promise<WorkflowRunDtoV1> {
  return send(runUrl(backendConnectionId, runId, threadPath(key, 'stop')), 'stopMultiModelThread', 'POST');
}

export function retryMultiModelThread(backendConnectionId: string, runId: string, key: string): Promise<WorkflowRunDtoV1> {
  return send(runUrl(backendConnectionId, runId, threadPath(key, 'retry')), 'retryMultiModelThread', 'POST');
}

export function replaceMultiModelThread(backendConnectionId: string, runId: string, key: string, pick: MultiModelModelPick): Promise<WorkflowRunDtoV1> {
  return send(runUrl(backendConnectionId, runId, threadPath(key, 'replace')), 'replaceMultiModelThread', 'POST', { pick });
}
