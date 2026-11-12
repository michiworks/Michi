import express, { type Request, type Response } from 'express';
import { SSE_HEARTBEAT_MS, isCheckinNodeId, type MemoryErrorResponse, type MemoryStatus } from 'michi-shared';
import { beginSse } from '../services/httpSse';
import { log } from '../services/logger';
import { wakeMemoryExtraction } from '../services/memory/extractionService';
import { subscribeMemoryChanges } from '../services/memory/memoryChangeFeed';
import { requestAgentOwnerOrNull } from '../services/agentOwner';
import {
  MemoryError,
  approveMemory,
  createMemory,
  forgetMemory,
  getConversationMemoryMode,
  listMemories,
  markNoticeSeen,
  memorySettingsView,
  rejectMemory,
  resetMemories,
  setConversationMemoryMode,
  setMemorySettings,
  updateMemory,
  type MemoryCaller,
} from '../services/memory/memoryService';
import { forgetRecalledTurn, recalledTurnScope, replySourcesView } from '../services/memory/replySources';
import { memoryProfileView, profileLineMemoryIds, requestProfileRebuild } from '../services/memory/userProfile';
import { requireRequestAccess } from './middleware/sessionAccess';

/**
 * Michi Memory REST API (C2), used by Settings → Memory and a conversation's
 * memory setting. The owner is the session's user in cloud mode and the
 * local identity on the desktop, as for the other owner-scoped routes; no
 * request field can name another owner. Another owner's memory, workspace or
 * conversation answers 404, like a missing one.
 */

class RequestError extends Error {}

const STATUS_FOR_CODE: Record<MemoryError['code'], number> = {
  invalid_argument: 400,
  not_found: 404,
  version_conflict: 409,
  invalid_state: 409,
  memory_disabled: 409,
};

function caller(req: Request): MemoryCaller | null {
  const ownerUserId = requestAgentOwnerOrNull(req.user?.id);
  return ownerUserId ? { ownerUserId } : null;
}

function route(fn: (req: Request, res: Response, caller: MemoryCaller) => void) {
  return (req: Request, res: Response): void => {
    const who = caller(req);
    if (!who) {
      const body: MemoryErrorResponse = { error: 'unauthorized', code: 'unauthorized' };
      res.status(401).json(body);
      return;
    }
    try {
      fn(req, res, who);
    } catch (error) {
      if (error instanceof MemoryError || error instanceof RequestError) {
        const code = error instanceof MemoryError ? error.code : 'invalid_argument';
        const body: MemoryErrorResponse = { error: error.message, code };
        if (error instanceof MemoryError && error.currentVersion !== undefined) body.currentVersion = error.currentVersion;
        res.status(STATUS_FOR_CODE[code]).json(body);
        return;
      }
      log.error('workspace', 'memory request failed', { method: req.method, path: req.path, error: (error as Error).message });
      res.status(500).json({ error: 'Memory request failed' });
    }
  };
}

/** A JSON object body holding only `allowed` keys. */
function jsonBody(req: Request, allowed: readonly string[]): Record<string, unknown> {
  const body: unknown = req.body ?? {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new RequestError('Request body must be a JSON object');
  const unknownKey = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknownKey) throw new RequestError(`Unsupported field: ${unknownKey}`);
  return body as Record<string, unknown>;
}

function queryString(req: Request, name: string): string | undefined {
  const value = req.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new RequestError(`${name} must be given once`);
  return value.trim() || undefined;
}

/** status=active,pending or status=active&status=pending */
function queryStatuses(req: Request): MemoryStatus[] | undefined {
  const raw = req.query.status;
  if (raw === undefined) return undefined;
  const values = (Array.isArray(raw) ? raw : [raw]).flatMap((value) => {
    if (typeof value !== 'string') throw new RequestError('status is invalid');
    return value.split(',').map((part) => part.trim()).filter(Boolean);
  });
  return values.length > 0 ? values as MemoryStatus[] : undefined;
}

function queryLimit(req: Request): number | undefined {
  const raw = queryString(req, 'limit');
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new RequestError('limit must be a positive integer');
  return Number(raw);
}

function memoryIdParam(req: Request): string {
  return String(req.params.id ?? '');
}

function nodeIdParam(req: Request): string {
  return String(req.params.nodeId ?? '');
}

/** GET /nodes/:nodeId/memory-sources takes 1 to MESSAGES_MAX assistant message ids, each 1 to MESSAGE_ID_MAX characters. */
const MESSAGES_MAX = 100;
const MESSAGE_ID_MAX = 200;

function messageIdsParam(req: Request): string[] {
  const raw = queryString(req, 'messages');
  const parts = raw === undefined ? [] : raw.split(',').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => !part || part.length > MESSAGE_ID_MAX)) {
    throw new RequestError(`messages must list 1 to ${MESSAGES_MAX} assistant message ids, comma-separated, each at most ${MESSAGE_ID_MAX} characters`);
  }
  const ids = [...new Set(parts)];
  if (ids.length > MESSAGES_MAX) throw new RequestError(`messages must list at most ${MESSAGES_MAX} ids`);
  return ids;
}

export function setupMemoryRoutes(): express.Router {
  const router = express.Router();
  router.use(['/memories', '/memory-settings', '/memory-profile', '/nodes/:nodeId/memory-mode', '/nodes/:nodeId/memory-sources', '/memory-recall'],
    requireRequestAccess);

  /**
   * Persistent SSE feed of the caller's memory changes (C4), one
   * `memory_changed` frame per MemoryChangedEvent. Only the caller's own
   * changes are sent; closing the response only detaches this subscriber.
   */
  router.get('/memories/changes/stream', (req, res) => {
    const who = caller(req);
    if (!who) {
      const body: MemoryErrorResponse = { error: 'unauthorized', code: 'unauthorized' };
      res.status(401).json(body);
      return;
    }
    const observer = beginSse(res);
    if (!observer.write(': connected\n\n')) return;
    observer.addCleanup(subscribeMemoryChanges(who.ownerUserId, (event) => {
      observer.write(`event: memory_changed\ndata: ${JSON.stringify(event)}\n\n`);
    }));
    observer.heartbeat(': keepalive\n\n', SSE_HEARTBEAT_MS.memoryChanges);
  });

  router.get('/memories', route((req, res, who) => {
    const scope = queryString(req, 'scope');
    if (scope !== undefined && scope !== 'user' && scope !== 'workspace') throw new RequestError('scope must be user or workspace');
    res.json(listMemories(who, {
      scope,
      workspaceId: queryString(req, 'workspaceId'),
      status: queryStatuses(req),
      query: queryString(req, 'q'),
      cursor: queryString(req, 'cursor'),
      limit: queryLimit(req),
    }));
  }));

  // Added by hand in Settings: always explicit and active.
  router.post('/memories', route((req, res, who) => {
    const body = jsonBody(req, ['scope', 'kind', 'body', 'topic']);
    const memory = createMemory(who, {
      scope: body.scope as never,
      kind: body.kind as never,
      body: body.body as string,
      ...(body.topic !== undefined ? { topic: body.topic as string | null } : {}),
      status: 'active',
      origin: 'explicit',
    });
    res.status(201).json({ memory });
  }));

  router.patch('/memories/:id', route((req, res, who) => {
    const body = jsonBody(req, ['body', 'scope', 'kind', 'topic', 'expectedVersion']);
    if (typeof body.expectedVersion !== 'number') throw new RequestError('expectedVersion is required');
    const memory = updateMemory(who, memoryIdParam(req), {
      ...(body.body !== undefined ? { body: body.body as string } : {}),
      ...(body.scope !== undefined ? { scope: body.scope as never } : {}),
      ...(body.kind !== undefined ? { kind: body.kind as never } : {}),
      ...(body.topic !== undefined ? { topic: body.topic as string | null } : {}),
    // The user edited it: the memory is theirs for consolidation, which never changes it.
    }, body.expectedVersion, { byUser: true });
    res.json({ memory });
  }));

  // As memory_delete: every version goes, with tombstones so extraction never saves it again; conversations are unchanged.
  router.delete('/memories/:id', route((req, res, who) => {
    forgetMemory(who, memoryIdParam(req));
    res.status(204).end();
  }));

  // "Delete all memories": the client confirms with the user first and says so here.
  router.post('/memories/reset', route((req, res, who) => {
    const body = jsonBody(req, ['confirm']);
    if (body.confirm !== true) throw new RequestError('confirm must be true');
    res.json(resetMemories(who));
  }));

  // Approve and reject serve older clients: this backend writes no pending memory and activates old ones at startup.
  router.post('/memories/:id/approve', route((req, res, who) => {
    res.json({ memory: approveMemory(who, memoryIdParam(req)) });
  }));

  router.post('/memories/:id/reject', route((req, res, who) => {
    rejectMemory(who, memoryIdParam(req));
    res.status(204).end();
  }));

  router.get('/memory-settings', route((_req, res, who) => {
    res.json(memorySettingsView(who.ownerUserId));
  }));

  // The answer is the mode in effect: 'explicit' from an older client is stored and returned as 'auto'.
  // noticeSeen: true records that the one-time notice was shown.
  router.put('/memory-settings', route((req, res, who) => {
    const body = jsonBody(req, ['mode', 'noticeSeen']);
    if (body.mode === undefined && body.noticeSeen === undefined) throw new RequestError('mode or noticeSeen is required');
    if (body.noticeSeen !== undefined && body.noticeSeen !== true) throw new RequestError('noticeSeen can only be true');
    if (body.mode !== undefined) setMemorySettings(who.ownerUserId, { mode: body.mode as never });
    if (body.noticeSeen === true) markNoticeSeen(who.ownerUserId);
    res.json(memorySettingsView(who.ownerUserId));
  }));

  // ── the profile of the user ("About the user") ──

  router.get('/memory-profile', route((_req, res, who) => {
    res.json(memoryProfileView(who.ownerUserId));
  }));

  // The next automatic memory run rebuilds it; the answer says a rebuild waits until it has.
  router.post('/memory-profile/rebuild', route((req, res, who) => {
    jsonBody(req, []);
    requestProfileRebuild(who.ownerUserId, Date.now());
    wakeMemoryExtraction();
    res.status(202).json(memoryProfileView(who.ownerUserId));
  }));

  // Remove: the memories a line cites are deleted (the line goes with them), and the profile is rebuilt without them.
  // version, when given, must be the profile's (GET /api/memory-profile) for the index to name the same line.
  router.post('/memory-profile/remove-line', route((req, res, who) => {
    const body = jsonBody(req, ['index', 'version']);
    if (typeof body.index !== 'number' || !Number.isSafeInteger(body.index) || body.index < 0) throw new RequestError('index must be the index of a line');
    if (body.version !== undefined) {
      const version = memoryProfileView(who.ownerUserId).version;
      if (body.version !== version) throw new MemoryError('version_conflict', 'The profile changed since it was read', version);
    }
    const ids = profileLineMemoryIds(who.ownerUserId, body.index);
    if (!ids) throw new MemoryError('not_found', 'Profile line not found');
    for (const id of ids) {
      try {
        forgetMemory(who, id);
      } catch (error) {
        // Removed with an earlier one's versions.
        if (!(error instanceof MemoryError) || error.code !== 'not_found') throw error;
      }
    }
    requestProfileRebuild(who.ownerUserId, Date.now());
    wakeMemoryExtraction();
    res.json(memoryProfileView(who.ownerUserId));
  }));

  // ── a conversation's memory setting ──

  router.get('/nodes/:nodeId/memory-mode', route((req, res, who) => {
    res.json({ mode: getConversationMemoryMode(who, nodeIdParam(req)) });
  }));

  // A check-in node (`n-cmph-…`) is the backend's alone, so no client writes its setting or reads its reply sources:
  // refused before anything reads it, as the persistence routes refuse a node write (persistence.ts refuseReservedNodeParam).
  const refuseCheckinNode = (req: Request, res: Response, next: express.NextFunction): void => {
    const nodeId = nodeIdParam(req);
    if (!isCheckinNodeId(nodeId)) {
      next();
      return;
    }
    res.status(400).json({ code: 'reserved_node_id', error: `node id ${nodeId} is reserved for Michi's check-ins` });
  };
  router.put('/nodes/:nodeId/memory-mode', refuseCheckinNode, route((req, res, who) => {
    const body = jsonBody(req, ['mode']);
    res.json(setConversationMemoryMode(who, nodeIdParam(req), body.mode));
  }));

  // ── what a reply was based on (services/memory/replySources.ts) ──

  // The memories and past-conversation turns these assistant messages repeated (V's too); another owner's conversation answers 404.
  router.get('/nodes/:nodeId/memory-sources', refuseCheckinNode, route((req, res, who) => {
    res.json(replySourcesView(who, nodeIdParam(req), messageIdsParam(req)));
  }));

  // Don't recall: the turn is hidden from recall and barred from extraction; its conversation is unchanged.
  router.post('/memory-recall/hide', route((req, res, who) => {
    const body = jsonBody(req, ['docId']);
    if (typeof body.docId !== 'number' || !Number.isSafeInteger(body.docId) || body.docId <= 0) {
      throw new RequestError('docId must be the id of a past conversation turn');
    }
    const result = forgetRecalledTurn(recalledTurnScope(who.ownerUserId, body.docId));
    if (!result) throw new MemoryError('not_found', 'Conversation turn not found');
    res.json(result);
  }));

  return router;
}
