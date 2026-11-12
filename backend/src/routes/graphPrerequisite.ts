import type express from 'express';
import { requestOwnerUserId } from '../services/accessPolicy';
import { getNode } from '../services/dbRepository';
import { dbWorker, isDbWorkerReady } from '../services/dbWorkerClient';
import { DomainError } from '../services/domainErrors';
import { ensureDurableGraphNode, type EnsureDurableGraphNodeInput } from '../services/graphCommands';
import { runWithStructureOrigin, structureOriginOf } from '../services/structureEvents';
import { domainErrorResponse } from './domainErrorResponse';

interface GraphPrerequisiteFailure {
  status: number;
  body: { error: string; code: 'NODE_NOT_PERSISTED' | 'NODE_PREREQUISITE_FAILED' };
}

/**
 * Write the graph slice a request carries for a node this backend does not
 * hold yet. Every route that can be a new node's first write goes through
 * here, so that write gets the same checks, origin and error codes whichever
 * request reaches the backend first. Null when the node exists or was
 * written; otherwise the response to send.
 */
export async function ensureRequestedGraphNode(
  req: express.Request,
  nodeId: string,
  prerequisite: unknown,
  options: { workspaceId?: unknown } = {},
): Promise<GraphPrerequisiteFailure | null> {
  try {
    if (getNode(nodeId)) return null;
    if (!prerequisite || typeof prerequisite !== 'object') {
      return { status: 409, body: { error: 'durable node prerequisite required', code: 'NODE_NOT_PERSISTED' } };
    }
    const input: EnsureDurableGraphNodeInput = {
      ...(prerequisite as EnsureDurableGraphNodeInput),
      ownerUserId: requestOwnerUserId(req) ?? null,
    };
    if (input.node?.id !== nodeId || (options.workspaceId && input.workspace?.id !== options.workspaceId)) {
      throw new DomainError('conflict', 'graph_prerequisite_identity_mismatch', 'graph prerequisite must identify the requested node and workspace');
    }
    // The window's own graph slice (it holds it already): only this write
    // names it, not the work the route does next.
    const origin = structureOriginOf(req);
    if (isDbWorkerReady()) await runWithStructureOrigin(origin, () => dbWorker.ensureDurableGraphNode(input));
    else runWithStructureOrigin(origin, () => ensureDurableGraphNode(input));
    return null;
  } catch (err) {
    const failure = domainErrorResponse(err);
    return { status: failure.status, body: { error: failure.error, code: 'NODE_PREREQUISITE_FAILED' } };
  }
}
