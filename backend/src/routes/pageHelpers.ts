import { Router, type Request } from 'express';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import { ensurePageHelper, promotePageHelper } from '../services/pages/helpers';
import { pageErrors, pageId, route } from './pageRouteKit';

const owner = (req: Request): string => (req as Request & { user?: { id?: string } }).user?.id ?? LOCAL_AGENT_OWNER_ID;

/** Page helper lifecycle endpoints. Caller identity always comes from authenticated middleware. */
export function setupPageHelperRoutes(): Router {
  const router = Router();
  router.post('/pages/:pageId/helper', route((req, res) => {
    res.json(ensurePageHelper(pageId(req.params.pageId, 'pageId'), owner(req)));
  }));
  router.post('/pages/:pageId/helper/promote', route((req, res) => {
    res.json(promotePageHelper(pageId(req.params.pageId, 'pageId'), owner(req)));
  }));
  router.use(pageErrors('Unable to complete page helper request'));
  return router;
}
