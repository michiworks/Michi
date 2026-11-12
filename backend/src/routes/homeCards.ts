import { Router } from 'express';
import type { Request } from 'express';
import { localOnlyGuard } from './middleware/localOnly';
import { LOCAL_AGENT_OWNER_ID } from '../services/agentOwner';
import { HomeCardsError, markHomeCardUsed, parseHomeCardsWrite, readHomeCards, writeHomeCards } from '../services/homeCards/repository';
import { pageErrors, route } from './pageRouteKit';

/** Only the Meta agent on this machine writes the cards. */
const writerLocalOnly = localOnlyGuard('Home cards are written by this computer\'s Pages upkeep only');

const owner = (req: Request): string => (req as Request & { user?: { id?: string } }).user?.id ?? LOCAL_AGENT_OWNER_ID;

function noQuery(req: Request): void {
  if (Object.keys(req.query).length > 0) throw new HomeCardsError(400, 'invalid', 'Unknown query parameter');
}

export interface HomeCardsRouteDeps {
  clock?: () => number;
}

/**
 * Michi Home inspiration cards, per owner. Mount at /api.
 *
 *   GET  /home/cards               -> HomeCardsDto
 *   PUT  /home/cards               HomeCardsWrite -> HomeCardsDto (local-only)
 *   POST /home/cards/:cardId/used  -> HomeCardUsedDto
 */
export function setupHomeCardsRoutes(deps: HomeCardsRouteDeps = {}): Router {
  const router = Router();
  const now = () => (deps.clock ?? Date.now)();

  router.get('/home/cards', route((req, res) => {
    noQuery(req);
    res.json(readHomeCards(owner(req)));
  }));
  router.put('/home/cards', ...writerLocalOnly, route((req, res) => {
    noQuery(req);
    res.json(writeHomeCards(owner(req), parseHomeCardsWrite(req.body), now()));
  }));
  router.post('/home/cards/:cardId/used', route((req, res) => {
    noQuery(req);
    const cardId = req.params.cardId;
    if (typeof cardId !== 'string' || !cardId || cardId.length > 200) throw new HomeCardsError(400, 'invalid', 'Invalid cardId');
    res.json(markHomeCardUsed(owner(req), cardId, now()));
  }));

  router.use('/home/cards', pageErrors('Unable to complete Home cards request', (error) => error instanceof HomeCardsError ? error : null));
  return router;
}
