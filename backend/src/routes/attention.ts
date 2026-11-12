import express, { type Request } from 'express';
import type { AttentionClaimResultV1 } from 'michi-shared';
import { requestAgentOwnerOrNull } from '../services/agentOwner';
import { requireRequestAccess } from './middleware/sessionAccess';

/** The attention service as this route needs it (services/attention/attentionService.ts). */
export interface AttentionRouteService {
  claim(ownerUserId: string, id: string, windowId: string): AttentionClaimResultV1 | null;
}

const WINDOW_ID_MAX = 200;

/** The account in the cloud; the one local user on the desktop (as presence and the feed). */
function attentionOwner(req: Request): string | null {
  return requestAgentOwnerOrNull(req.user?.id);
}

/**
 * POST /api/attention/notifications/:id/claim { windowId }
 *
 * The first window to claim an active record wins and is the only one that
 * shows the OS-level notification; later claimers get `claimed: false` with
 * the winner. The winner claiming again keeps `claimed: true`. 404 for a
 * record of another owner, exactly as for one that does not exist. Mounted
 * under /api behind the app's access middleware, and gated again here like
 * the persistence routes.
 */
export function setupAttentionRoutes(service: AttentionRouteService): express.Router {
  const router = express.Router();
  router.post('/attention/notifications/:id/claim', requireRequestAccess, (req, res) => {
    const ownerUserId = attentionOwner(req);
    if (!ownerUserId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const windowId = (req.body as { windowId?: unknown } | undefined)?.windowId;
    if (typeof windowId !== 'string' || !windowId.trim() || windowId.length > WINDOW_ID_MAX) {
      res.status(400).json({ error: `windowId must be a non-empty string of at most ${WINDOW_ID_MAX} characters` });
      return;
    }
    const id = req.params.id;
    if (typeof id !== 'string' || !id) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    let result: AttentionClaimResultV1 | null;
    try {
      result = service.claim(ownerUserId, id, windowId);
    } catch {
      res.status(500).json({ error: 'claim failed' });
      return;
    }
    if (!result) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(200).json(result);
  });
  return router;
}
