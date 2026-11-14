import express, { type Request, type RequestHandler } from 'express';
import {
  ATTENTION_DESKTOP_STREAM_PATH,
  type AttentionClaimResultV1,
  type AttentionNotificationV1,
} from 'michi-shared';
import { LOCAL_AGENT_OWNER_ID, requestAgentOwnerOrNull } from '../services/agentOwner';
import { attentionFeed as defaultFeed, type AttentionFeed } from '../services/attention/attentionFeed';
import { beginSse } from '../services/httpSse';
import { localOnlyGuard } from './middleware/localOnly';
import { requireRequestAccess } from './middleware/sessionAccess';

/** The attention service as these routes need it (services/attention/attentionService.ts). */
export interface AttentionRouteService {
  claim(ownerUserId: string, id: string, windowId: string): AttentionClaimResultV1 | null;
  claimForDesktop(ownerUserId: string, id: string): AttentionClaimResultV1 | null;
  desktopAccepts(notification: Pick<AttentionNotificationV1, 'kind' | 'reason'>): boolean;
}

export interface AttentionRouteOptions {
  /** The feed the desktop stream subscribes to (default: the process's). */
  feed?: AttentionFeed;
  /**
   * Other frames the desktop notifier needs: the Companion's
   * `companion_changed`, after which the tray fetches its menu again. Gets a
   * writer for complete SSE frames; returns the unsubscribe.
   */
  desktopFrames?: (write: (frame: string) => void) => () => void;
}

const KEEPALIVE_MS = 15_000;

/**
 * Only this machine's own Michi app is the desktop notifier: a loopback Host
 * and a local-control request, never an authenticated remote caller (a remote
 * window gets its records on the background feed like any window).
 */
const desktopLocalOnly = localOnlyGuard('The desktop notifier feed is only for the Michi app on this machine');

/** No desktop notifier in the cloud: answered as if the routes did not exist. */
const desktopOnly: RequestHandler = (_req, res, next) => {
  if (process.env.MICHI_CLOUD === '1') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  next();
};

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
 *
 * GET  /api/attention/desktop/stream                      (ATTENTION_DESKTOP_STREAM_PATH)
 * POST /api/attention/desktop/notifications/:id/claim     → AttentionClaimResultV1
 *
 * Electron main's one subscription (electron/attentionNotifications.ts): the
 * local owner's attention_* frames, a snapshot first, notifications only as
 * far as the user's level lets them through (desktopAccepts), every
 * resolution; and `companion_changed` for the tray. While it is connected no
 * record wakes the app. Electron main claims a record for the desktop
 * notifier before it shows its banner, so a window that opens later does not
 * raise it again. Loopback and local control only; not in the cloud.
 */
export function setupAttentionRoutes(service: AttentionRouteService, options: AttentionRouteOptions = {}): express.Router {
  const router = express.Router();
  const feed = options.feed ?? defaultFeed;

  router.get(ATTENTION_DESKTOP_STREAM_PATH, desktopOnly, ...desktopLocalOnly, (_req, res) => {
    const observer = beginSse(res);
    if (!observer.write(': connected\n\n')) return;
    observer.addCleanup(feed.subscribe(LOCAL_AGENT_OWNER_ID, {
      send: (frame) => { observer.write(frame); },
      desktop: { accepts: (notification) => service.desktopAccepts(notification) },
    }));
    const unsubscribe = options.desktopFrames?.((frame) => { observer.write(frame); });
    if (unsubscribe) observer.addCleanup(unsubscribe);
    observer.heartbeat(': keepalive\n\n', KEEPALIVE_MS);
  });

  router.post('/attention/desktop/notifications/:id/claim', desktopOnly, ...desktopLocalOnly, (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string' || !id) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    let result: AttentionClaimResultV1 | null;
    try {
      result = service.claimForDesktop(LOCAL_AGENT_OWNER_ID, id);
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
