import {
  applyWorkflowRunPatch,
  parseWorkflowRunDto,
  parseWorkflowRunSseEnvelope,
  SSE_HEARTBEAT_MS,
  sseSilenceTimeoutMs,
  type BackgroundSubagentsEndedV1,
  type BackgroundSubagentsUpdateV1,
  type WorkflowAction,
  type WorkflowRunDtoV1,
} from 'michi-shared';
import { backendApiBase, LOCAL_BACKEND_CONNECTION_ID, workspaceBackendApiBase } from '../../config/backendConnections';
import { backendEntityId, connectionIdFromApiUrl, mapBackendPayload } from '../../config/backendIdentity';
import { backendFetch } from './backendRequest';
import { jsonResponse } from './httpError';
import { openSseFeed } from './sseFeed';

/**
 * A run as the renderer keys it: its workspace and chat references scoped to
 * the connection. Step ids (`nodes[].id`, `parentId`, approval and log
 * `nodeId`) are the runtime's and stay as written; mapBackendPayload goes by
 * field name and would scope all of them but `parentId`, flattening the tree.
 */
function mapWorkflowRunIdentity(run: WorkflowRunDtoV1, connectionId: string): WorkflowRunDtoV1 {
  if (connectionId === LOCAL_BACKEND_CONNECTION_ID) return run;
  const scope = (id: string) => backendEntityId(connectionId, id);
  const view = run.multiModel;
  return {
    ...run,
    workspaceId: scope(run.workspaceId),
    nodeId: run.nodeId === null ? null : scope(run.nodeId),
    ...(view ? { multiModel: {
      ...view,
      callerNodeId: scope(view.callerNodeId),
      threads: view.threads.map((thread) => ({
        ...thread,
        childNodeId: thread.childNodeId === null ? null : scope(thread.childNodeId),
        ...(thread.previousChildNodeIds ? { previousChildNodeIds: thread.previousChildNodeIds.map(scope) } : {}),
      })),
    } } : {}),
  };
}

/** The run a `{ run }` read or command answers, validated, as the backend wrote it. */
async function requestBackendRun(url: string, operation: string, init?: RequestInit): Promise<WorkflowRunDtoV1> {
  const payload = await jsonResponse(await backendFetch(url, init, { mapPayload: false }), operation);
  const run = payload && typeof payload === 'object' ? parseWorkflowRunDto((payload as { run?: unknown }).run) : null;
  if (!run) throw new Error(`${operation} returned a malformed run`);
  return run;
}

/** The run a `{ run }` read or command answers, validated, as the feed delivers it. */
export async function requestRun(url: string, operation: string, init?: RequestInit): Promise<WorkflowRunDtoV1> {
  return mapWorkflowRunIdentity(await requestBackendRun(url, operation, init), connectionIdFromApiUrl(url));
}

export function getWorkflowRun(backendConnectionId: string, runId: string, signal?: AbortSignal): Promise<WorkflowRunDtoV1> {
  return requestRun(`${backendApiBase(backendConnectionId)}/workflow-runs/${encodeURIComponent(runId)}`, 'getWorkflowRun', { signal });
}

export function actOnWorkflowRun(backendConnectionId: string, runId: string, action: WorkflowAction): Promise<WorkflowRunDtoV1> {
  return requestRun(`${backendApiBase(backendConnectionId)}/workflow-runs/${encodeURIComponent(runId)}/actions`, 'actOnWorkflowRun', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}

export function answerWorkflowApproval(backendConnectionId: string, runId: string, approvalId: string, optionId: string): Promise<WorkflowRunDtoV1> {
  return requestRun(
    `${backendApiBase(backendConnectionId)}/workflow-runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
    'answerWorkflowApproval',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ optionId }) },
  );
}

export interface WorkflowRunSubscriptionOptions {
  onRun: (run: WorkflowRunDtoV1) => void;
  /**
   * Background subagents the backend's live agent processes still track:
   * a snapshot first, then deltas. Backends from before the event never
   * call it.
   */
  onBackgroundSubagents?: (update: BackgroundSubagentsUpdateV1) => void;
  /**
   * Background subagents of one node that ended without a turn reporting
   * them (already stored by the backend). Backends from before the event
   * never call it.
   */
  onBackgroundSubagentsEnded?: (ended: BackgroundSubagentsEndedV1) => void;
  onOpen?: () => void;
  onDisconnect?: (error?: Error) => void;
}

/**
 * Snapshot-then-live stream of a workspace's runs (and background
 * subagents). Returns unsubscribe. It asks for patches: each run arrives
 * once, then only what changed, merged here into the copy the feed sent so
 * `onRun` always gets whole runs. A patch for another revision than that
 * copy (a frame lost) reads the run whole instead. Backends from before
 * patches ignore the ask and send whole runs.
 */
export function subscribeWorkflowRuns(workspaceId: string, options: WorkflowRunSubscriptionOptions): () => void {
  const base = workspaceBackendApiBase(workspaceId);
  const connectionId = connectionIdFromApiUrl(base);
  // The runs as this feed sent them (unmapped), the bases its patches apply to.
  const sent = new Map<string, WorkflowRunDtoV1>();
  const deliver = (run: WorkflowRunDtoV1) => {
    const known = sent.get(run.id);
    if (known && known.revision > run.revision) return;
    sent.set(run.id, run);
    options.onRun(mapWorkflowRunIdentity(run, connectionId));
  };
  const reading = new Set<string>();
  const readWhole = (runId: string) => {
    sent.delete(runId);
    if (reading.has(runId)) return;
    reading.add(runId);
    requestBackendRun(`${base}/workflow-runs/${encodeURIComponent(runId)}`, 'getWorkflowRun')
      .then(deliver, () => {})
      .finally(() => reading.delete(runId));
  };
  return openSseFeed(`${base}/workflow-runs/subscribe?${new URLSearchParams({ workspaceId, patches: '1' })}`, {
    label: 'subscribeWorkflowRuns',
    transport: { mapPayload: false },
    silenceMs: sseSilenceTimeoutMs(SSE_HEARTBEAT_MS.workflowRuns),
    onOpen: options.onOpen,
    onDisconnect: options.onDisconnect,
    onFrame: (_event, data) => {
      let json: unknown;
      try { json = JSON.parse(data); } catch { return; }
      const envelope = parseWorkflowRunSseEnvelope(json);
      if (envelope?.run) deliver(envelope.run);
      else if (envelope?.event === 'workflow_run_patch' && envelope.patch) {
        const known = sent.get(envelope.patch.id);
        const patched = known ? applyWorkflowRunPatch(known, envelope.patch) : null;
        const run = patched ? parseWorkflowRunDto(patched) : null;
        if (run) deliver(run);
        else readWhole(envelope.patch.id);
      } else if (envelope?.event === 'background_subagents' && envelope.backgroundSubagents) {
        options.onBackgroundSubagents?.(mapBackendPayload(envelope.backgroundSubagents, connectionId, 'renderer', 'backgroundSubagents'));
      } else if (envelope?.event === 'background_subagents_ended' && envelope.backgroundSubagentsEnded) {
        options.onBackgroundSubagentsEnded?.(mapBackendPayload(envelope.backgroundSubagentsEnded, connectionId, 'renderer'));
      }
    },
  });
}
