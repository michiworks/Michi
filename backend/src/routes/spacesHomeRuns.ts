import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SpacesFirstRunStatus } from 'michi-shared';
import { requestAgentOwner } from '../services/agentOwner';
import { PageWriteError } from '../services/pages/core';
import type { ScheduledJobScheduler } from '../services/scheduledJobs/scheduler';
import { retrySpacesFirstRun, spacesFirstRunStatus, startSpacesFirstRun } from '../services/metaAgent/firstRun';
import { maintenanceCoordinatorState } from '../services/metaAgent/maintenanceCoordinator';
import { isObject, pageBody, pageErrors, route, type Obj } from './pageRouteKit';
const owner = (req: Request): string => requestAgentOwner((req as Request & { user?: { id?: string } }).user?.id);

function requireOwner(req: Request): string {
  const ownerUserId = owner(req);
  if (!ownerUserId) throw new PageWriteError(404, 'not_found', 'Spaces Home not found');
  return ownerUserId;
}

/** These bodies are optional, and small enough to skip the Pages write limit. */
function body(req: Request, keys: readonly string[]): Obj {
  if (req.body === undefined || (isObject(req.body) && Object.keys(req.body).length === 0)) return {};
  return pageBody(req, keys, { sizeCap: false });
}

/** Every answer is the shared SpacesFirstRunStatus the client reads. */
const answer = (res: Response, status: SpacesFirstRunStatus) => { res.json(status); };

/**
 * First-time generation of the workspace homes and the Spaces Home. Mount at /api.
 *   POST /spaces-home/first-run        -> SpacesFirstRunStatus (idempotent; call whenever Spaces opens). A first run
 *                                         that never ran starts only when `visitMayStart` allows it (D17: else the
 *                                         Get started card starts it); a run already asked for is woken
 *   GET  /spaces-home/first-run        -> SpacesFirstRunStatus
 *   POST /spaces-home/first-run/retry  { workspaceId? } -> SpacesFirstRunStatus (failed runs only)
 */
export function setupSpacesHomeRunRoutes(deps: {
  scheduler: ScheduledJobScheduler | null;
  clock?: () => number;
  /** Whether opening Spaces may start a first run that never ran (companion/getStarted.ts); absent: it always may. */
  visitMayStart?: () => boolean;
}): Router {
  const router = Router();
  const now = () => (deps.clock ?? Date.now)();
  const scheduler = (): ScheduledJobScheduler => {
    if (!deps.scheduler) throw new PageWriteError(409, 'invalid', 'Pages upkeep needs scheduled jobs, which are off on this backend');
    return deps.scheduler;
  };

  router.get('/spaces-home/first-run', route((req, res) => {
    answer(res, spacesFirstRunStatus(requireOwner(req), now()));
  }));

  router.post('/spaces-home/first-run', route((req, res) => {
    body(req, []);
    const ownerUserId = requireOwner(req);
    const status = spacesFirstRunStatus(ownerUserId, now());
    // While Michi is paused (until Get started's Start or Resume), opening Spaces queues and announces nothing that would not run;
    // nor does a visit Get started says may not start it.
    if (maintenanceCoordinatorState(ownerUserId).paused || (status.requestedAt === null && deps.visitMayStart && !deps.visitMayStart())) {
      answer(res, status);
      return;
    }
    answer(res, startSpacesFirstRun(scheduler(), ownerUserId, now()));
  }));

  router.post('/spaces-home/first-run/retry', route((req, res) => {
    const input = body(req, ['workspaceId']);
    if (input.workspaceId !== undefined && (typeof input.workspaceId !== 'string' || !input.workspaceId || input.workspaceId.length > 200)) {
      throw new PageWriteError(400, 'invalid', 'Invalid workspaceId');
    }
    answer(res, retrySpacesFirstRun(scheduler(), requireOwner(req), (input.workspaceId as string | undefined) ?? null, now()));
  }));

  router.use('/spaces-home/first-run', pageErrors('Unable to complete the Spaces first-run request'));
  return router;
}
