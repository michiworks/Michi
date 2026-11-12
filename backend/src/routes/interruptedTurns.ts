import express, { type Request } from 'express';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import { dismissInterruptedTurn, listInterruptedTurns } from '../services/interruptedTurns';
import { requireRequestAccess } from './middleware/sessionAccess';

const TURN_ID_MAX = 200;

/** The account in the cloud; the one local user on the desktop. */
function owner(req: Request): string | null {
  if (process.env.MICHI_CLOUD === '1') return req.user?.id || null;
  return LOCAL_AGENT_OWNER_ID;
}

/**
 * Interrupted turns the user can Resume (services/interruptedTurns.ts). Mounted
 * under /api behind the app's access middleware, and gated again here like
 * the attention routes.
 *
 *   GET  /interrupted-turns                  -> InterruptedTurnsDto
 *   POST /interrupted-turns/:turnId/dismiss  -> { dismissed: true }; 404 for another owner's turn
 */
export function setupInterruptedTurnRoutes(): express.Router {
  const router = express.Router();
  router.get('/interrupted-turns', requireRequestAccess, (req, res) => {
    const ownerUserId = owner(req);
    if (!ownerUserId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    try {
      res.json(listInterruptedTurns(ownerUserId));
    } catch {
      res.status(500).json({ error: 'Unable to list interrupted turns' });
    }
  });
  router.post('/interrupted-turns/:turnId/dismiss', requireRequestAccess, (req, res) => {
    const ownerUserId = owner(req);
    if (!ownerUserId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const turnId = req.params.turnId;
    if (typeof turnId !== 'string' || !turnId || turnId.length > TURN_ID_MAX) {
      res.status(400).json({ error: 'Invalid turnId' });
      return;
    }
    try {
      if (!dismissInterruptedTurn(ownerUserId, turnId)) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ dismissed: true });
    } catch {
      res.status(500).json({ error: 'Unable to dismiss the interrupted turn' });
    }
  });
  return router;
}
