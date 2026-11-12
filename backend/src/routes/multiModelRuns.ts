import express, { type Request, type Response } from 'express';
import { parseMultiModelModelPick, parseMultiModelPlanEdit, type WorkflowRunDtoV1 } from 'michi-shared';
import { MultiModelError, type MultiModelOrchestrator } from '../services/multiModel/orchestrator';
import type { WorkflowRunHub } from '../services/workflowRunHub';
import { workflowRunOwner, workflowWorkspaceScope } from './workflowRunScope';

/**
 * Multi-model runs (services/multiModel/): the plan card's and the drawer's
 * commands. Approvals go through the generic
 * POST /workflow-runs/:id/approvals/:approvalId.
 *
 *   GET   /multi-model/ready-models?workspaceId=         ready runtimes/models
 *   PATCH /multi-model-runs/:runId/plan                  MultiModelPlanEdit
 *   POST  /multi-model-runs/:runId/start | cancel | stop | retry
 *   POST  /multi-model-runs/:runId/threads/:key/stop | retry
 *   POST  /multi-model-runs/:runId/threads/:key/replace  { pick }
 *
 * Every run lookup is owner-scoped: another owner's run is 404.
 */

export interface MultiModelRunRouteDeps {
  orchestrator: Pick<MultiModelOrchestrator, 'readyModelsFor' | 'editPlan' | 'startRun' | 'cancelProposal' | 'stopAll'
    | 'retryRun' | 'stopThread' | 'retryThread' | 'replaceThread'>;
  hub: Pick<WorkflowRunHub, 'workspaceOwnedBy'>;
}

const THREAD_KEY = /^[at][1-9][0-9]?$/;

function sendError(res: Response, error: unknown): void {
  if (error instanceof MultiModelError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(502).json({ error: error instanceof Error ? error.message : 'The run rejected the request' });
}

export function setupMultiModelRunRoutes(deps: MultiModelRunRouteDeps): express.Router {
  const router = express.Router();
  const { orchestrator } = deps;

  /** Run a command for the request's owner and answer `{ run }`. */
  const command = (req: Request, res: Response, call: (ownerUserId: string) => Promise<WorkflowRunDtoV1>): void => {
    const ownerUserId = workflowRunOwner(req);
    if (!ownerUserId) { res.status(401).json({ error: 'unauthorized' }); return; }
    call(ownerUserId).then((run) => { res.json({ run }); }, (error) => sendError(res, error));
  };

  /** The `:key` param, or null after answering 400. */
  const threadKey = (req: Request, res: Response): string | null => {
    const key = req.params.key;
    if (typeof key === 'string' && THREAD_KEY.test(key)) return key;
    res.status(400).json({ error: 'Invalid thread key' });
    return null;
  };

  router.get('/multi-model/ready-models', (req, res) => {
    const scope = workflowWorkspaceScope(req, res, deps.hub);
    if (!scope) return;
    orchestrator.readyModelsFor(scope.ownerUserId, scope.workspaceId).then((dto) => { res.json(dto); }, (error) => sendError(res, error));
  });

  router.patch('/multi-model-runs/:runId/plan', (req, res) => {
    const edit = parseMultiModelPlanEdit(req.body);
    if (!edit) { res.status(400).json({ error: 'Invalid plan edit' }); return; }
    command(req, res, (owner) => orchestrator.editPlan(owner, req.params.runId, edit));
  });

  router.post('/multi-model-runs/:runId/start', (req, res) => command(req, res, (owner) => orchestrator.startRun(owner, req.params.runId)));
  router.post('/multi-model-runs/:runId/cancel', (req, res) => command(req, res, (owner) => orchestrator.cancelProposal(owner, req.params.runId)));
  router.post('/multi-model-runs/:runId/stop', (req, res) => command(req, res, (owner) => orchestrator.stopAll(owner, req.params.runId)));
  router.post('/multi-model-runs/:runId/retry', (req, res) => command(req, res, (owner) => orchestrator.retryRun(owner, req.params.runId)));

  router.post('/multi-model-runs/:runId/threads/:key/stop', (req, res) => {
    const key = threadKey(req, res);
    if (key) command(req, res, (owner) => orchestrator.stopThread(owner, req.params.runId, key));
  });

  router.post('/multi-model-runs/:runId/threads/:key/retry', (req, res) => {
    const key = threadKey(req, res);
    if (key) command(req, res, (owner) => orchestrator.retryThread(owner, req.params.runId, key));
  });

  router.post('/multi-model-runs/:runId/threads/:key/replace', (req, res) => {
    const key = threadKey(req, res);
    if (!key) return;
    const pick = parseMultiModelModelPick(req.body?.pick);
    if (!pick) { res.status(400).json({ error: 'Invalid model pick' }); return; }
    command(req, res, (owner) => orchestrator.replaceThread(owner, req.params.runId, key, pick));
  });

  return router;
}
