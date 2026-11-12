import express from 'express';
import { boundWorkflowRun, isWorkflowAction, isWorkflowRunOpen, SSE_HEARTBEAT_MS, WORKFLOW_ACTIONS, type SubagentEnd, type WorkflowRunDtoV1, type WorkflowRunSseEnvelopeV1 } from 'michi-shared';
import { beginSse, SSE_REPLAY_BYTES } from '../services/httpSse';
import type { BackgroundSubagentRegistry } from '../services/backgroundSubagentRegistry';
import { WorkflowActionError, type WorkflowRunHub } from '../services/workflowRunHub';
import { workflowRunOwner, workflowWorkspaceScope } from './workflowRunScope';

/**
 * Workflow runs (Claude Code Workflows, Kiro CLI workflows):
 *
 *   GET  /workflow-runs?workspaceId=         recent runs of a workspace
 *   GET  /workflow-runs/subscribe?workspaceId=  SSE: current snapshots, then live
 *   GET  /workflow-runs/:id                  one run
 *   POST /workflow-runs/:id/actions          { action: stop|pause|resume|retry }
 *   POST /workflow-runs/:id/approvals/:approvalId  { optionId }
 *
 * Every lookup is owner-scoped; workspace reads also check the workspace
 * belongs to the caller.
 */

/** Snapshot writes pause above this and resume on drain. */
const SNAPSHOT_HIGH_WATER_BYTES = 256_000;
const SNAPSHOT_LIMIT = 50;
/**
 * Whole-snapshot budget in UTF-8 bytes of run JSON. Draining here only paces
 * the loopback hop of an upgraded gateway's WebSocket.
 */
const SNAPSHOT_TOTAL_BYTES = SSE_REPLAY_BYTES;

const runBytes = (run: WorkflowRunDtoV1): number => Buffer.byteLength(JSON.stringify(run), 'utf8');

/**
 * Fit the snapshot (open runs first, then newest first, as `hub.list`
 * returns them) in its byte budget. Runs that fit their share are sent whole
 * and leave the rest to larger ones; trimmed runs are marked `partial`
 * (clients fetch them whole on demand). If even the trimmed runs do not fit,
 * finished runs are left out from the first one that no longer fits, so the
 * kept ones are the newest; `GET /workflow-runs/:id` still serves the rest.
 * Open runs are kept whenever they fit.
 */
export function snapshotRuns(runs: WorkflowRunDtoV1[], totalBytes = SNAPSHOT_TOTAL_BYTES): WorkflowRunDtoV1[] {
  const sizes = runs.map(runBytes);
  if (sizes.reduce((sum, size) => sum + size, 0) <= totalBytes) return runs;
  const out = [...runs];
  const outSizes = [...sizes];
  // The flag is part of the trimmed run's size.
  const partialBytes = (run: WorkflowRunDtoV1) => runBytes({ ...run, partial: true });
  let remaining = totalBytes;
  let left = runs.length;
  // Smallest first: each run gets an equal share of what is left.
  for (const index of runs.map((_, i) => i).sort((a, b) => sizes[a] - sizes[b])) {
    const share = Math.max(0, Math.floor(remaining / left));
    left -= 1;
    if (sizes[index] > share) {
      out[index] = { ...boundWorkflowRun(runs[index], share, partialBytes), partial: true };
      outSizes[index] = runBytes(out[index]);
    }
    remaining -= outSizes[index];
  }
  // Open runs first (a run waiting on an approval may be old by update
  // time), then newest first; the result keeps the input order.
  const priority = runs.map((_, i) => i).sort((a, b) => Number(isWorkflowRunOpen(runs[b])) - Number(isWorkflowRunOpen(runs[a])) || a - b);
  const keep = new Set<number>();
  let used = 0;
  for (const index of priority) {
    if (used + outSizes[index] > totalBytes) {
      if (isWorkflowRunOpen(runs[index])) continue;
      break;
    }
    used += outSizes[index];
    keep.add(index);
  }
  return out.filter((_, index) => keep.has(index));
}

export interface WorkflowRunRouteDeps {
  hub: WorkflowRunHub;
  /**
   * When set, the feed also carries `background_subagents` (a snapshot
   * first, then changes) and `background_subagents_ended` (ends no turn
   * will report, already stored: the recent ones replayed on subscribe,
   * then new ones).
   */
  backgroundSubagents?: BackgroundSubagentRegistry;
  heartbeatMs?: number;
  now?: () => number;
}

function frame(envelope: WorkflowRunSseEnvelopeV1): string {
  return `event: ${envelope.event}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

export function setupWorkflowRunRoutes(deps: WorkflowRunRouteDeps): express.Router {
  const router = express.Router();
  const now = deps.now ?? Date.now;
  const heartbeatMs = deps.heartbeatMs ?? SSE_HEARTBEAT_MS.workflowRuns;

  router.get('/workflow-runs', (req, res) => {
    const scope = workflowWorkspaceScope(req, res, deps.hub);
    if (!scope) return;
    res.json({ runs: deps.hub.list(scope.ownerUserId, scope.workspaceId, SNAPSHOT_LIMIT) });
  });

  router.get('/workflow-runs/subscribe', (req, res) => {
    const scope = workflowWorkspaceScope(req, res, deps.hub);
    if (!scope) return;
    const observer = beginSse(res);
    const send = (envelope: WorkflowRunSseEnvelopeV1): void => { observer.write(frame(envelope)); };
    const sendRun = (run: WorkflowRunDtoV1) => send({ version: 1, event: 'workflow_run', run, emittedAt: now() });
    const sendBackground = (snapshot: boolean, nodes: Record<string, string[]>) =>
      send({ version: 1, event: 'background_subagents', run: null, backgroundSubagents: { snapshot, nodes }, emittedAt: now() });
    // Subscribe before the snapshot so nothing between the two is missed;
    // clients keep the highest revision, so a duplicate is harmless.
    observer.addCleanup(deps.hub.subscribe((ownerUserId, run) => {
      if (ownerUserId === scope.ownerUserId && run.workspaceId === scope.workspaceId) sendRun(run);
    }));
    const sendEnded = (nodeId: string, subagents: SubagentEnd[]) => send({
      version: 1,
      event: 'background_subagents_ended',
      run: null,
      backgroundSubagentsEnded: { nodeId, subagents },
      emittedAt: now(),
    });
    const registry = deps.backgroundSubagents;
    if (registry) {
      // Background subagents: the snapshot is written synchronously right
      // after subscribing, so every later change arrives after it.
      observer.addCleanup(registry.subscribe((ownerUserId, workspaceId, nodes) => {
        if (ownerUserId === scope.ownerUserId && workspaceId === scope.workspaceId) sendBackground(false, nodes);
      }));
      observer.addCleanup(registry.subscribeEnded((ended) => {
        if (ended.ownerUserId === scope.ownerUserId && ended.workspaceId === scope.workspaceId) sendEnded(ended.nodeId, ended.ends);
      }));
      // Ends published while this client was not subscribed (another
      // workspace open, or reconnecting): it may still hold copies waiting
      // for them. Before the liveness snapshot, so it never reads an ended
      // agent as interrupted; an end it already has changes nothing.
      for (const recent of registry.recentEnds(scope.ownerUserId, scope.workspaceId)) sendEnded(recent.nodeId, recent.ends);
      // Small: it tells the client which background agents still run
      // before any history arrives.
      sendBackground(true, registry.snapshot(scope.ownerUserId, scope.workspaceId));
    }
    // The snapshot can be large; let the socket drain between runs instead
    // of tripping the buffer bound (which would loop on reconnect). Open
    // runs go first, so cards waiting on the user arrive before history
    // (clients order cards by start time, not arrival).
    const snapshot = snapshotRuns(deps.hub.list(scope.ownerUserId, scope.workspaceId, SNAPSHOT_LIMIT));
    const writeSnapshot = (): void => {
      while (snapshot.length > 0 && !observer.closed) {
        if (res.writableLength > SNAPSHOT_HIGH_WATER_BYTES) { res.once('drain', writeSnapshot); return; }
        sendRun(snapshot.shift()!);
      }
    };
    writeSnapshot();
    observer.heartbeat(() => frame({ version: 1, event: 'heartbeat', run: null, emittedAt: now() }), heartbeatMs);
  });

  router.get('/workflow-runs/:id', (req, res) => {
    const ownerUserId = workflowRunOwner(req);
    if (!ownerUserId) { res.status(401).json({ error: 'unauthorized' }); return; }
    const run = deps.hub.get(ownerUserId, req.params.id);
    if (!run) { res.status(404).json({ error: 'not_found' }); return; }
    res.json({ run });
  });

  router.post('/workflow-runs/:id/actions', async (req, res) => {
    const ownerUserId = workflowRunOwner(req);
    if (!ownerUserId) { res.status(401).json({ error: 'unauthorized' }); return; }
    const action = req.body?.action;
    if (!isWorkflowAction(action)) {
      res.status(400).json({ error: `action must be one of ${WORKFLOW_ACTIONS.join(', ')}` });
      return;
    }
    try {
      const run = await deps.hub.act(ownerUserId, req.params.id, action);
      res.json({ run });
    } catch (error) {
      if (error instanceof WorkflowActionError) { res.status(error.status).json({ error: error.message }); return; }
      res.status(502).json({ error: error instanceof Error ? error.message : 'The runtime rejected the request' });
    }
  });

  router.post('/workflow-runs/:id/approvals/:approvalId', async (req, res) => {
    const ownerUserId = workflowRunOwner(req);
    if (!ownerUserId) { res.status(401).json({ error: 'unauthorized' }); return; }
    const optionId = req.body?.optionId;
    if (typeof optionId !== 'string' || !optionId || optionId.length > 200) {
      res.status(400).json({ error: 'optionId is required' });
      return;
    }
    try {
      const run = await deps.hub.answerApproval(ownerUserId, req.params.id, req.params.approvalId, optionId);
      res.json({ run });
    } catch (error) {
      if (error instanceof WorkflowActionError) { res.status(error.status).json({ error: error.message }); return; }
      res.status(502).json({ error: error instanceof Error ? error.message : 'The runtime rejected the answer' });
    }
  });

  return router;
}
