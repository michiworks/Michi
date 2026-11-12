import type { Request, Response } from 'express';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import type { WorkflowRunHub } from '../services/workflowRunHub';

/**
 * Owner and workspace resolution for the routes that look runs up in the
 * WorkflowRunHub (workflowRuns.ts, multiModelRuns.ts), so both agree on
 * whose run it is.
 */

/** The request's user, else the local user on the desktop; null in cloud mode without one. */
export function workflowRunOwner(req: Request): string | null {
  const id = (req as Request & { user?: { id?: string } }).user?.id;
  if (id) return id;
  return process.env.MICHI_CLOUD === '1' ? null : LOCAL_AGENT_OWNER_ID;
}

/** Resolve owner + `?workspaceId=` the owner holds, or answer 401/400/404; null when answered. */
export function workflowWorkspaceScope(
  req: Request,
  res: Response,
  hub: Pick<WorkflowRunHub, 'workspaceOwnedBy'>,
): { ownerUserId: string; workspaceId: string } | null {
  const ownerUserId = workflowRunOwner(req);
  if (!ownerUserId) { res.status(401).json({ error: 'unauthorized' }); return null; }
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId.trim() : '';
  if (!workspaceId) { res.status(400).json({ error: 'workspaceId is required' }); return null; }
  if (!hub.workspaceOwnedBy(ownerUserId, workspaceId)) { res.status(404).json({ error: 'not_found' }); return null; }
  return { ownerUserId, workspaceId };
}
