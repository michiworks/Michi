import { jsonConfigErrorResponse } from './jsonConfigErrorResponse';
import { urlOpenRequests } from '../services/urlOpenRequests';
import { requestOwnerUserId } from '../services/accessPolicy';
import { requireRequestAccess } from './middleware/sessionAccess';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { log } from '../services/logger';
import { getDb, runInTransaction } from '../services/db';
import { readPrefs, writePrefs, migrateFromSqlite } from '../services/prefsConfig';
import { readChatPermissionSettings, writeChatPermissionSettings, writeNodePermissionMode, resolveChatPermissionMode, resolveChatApproveForMe } from '../services/chatPermissions';
import { writeNodeUltracode } from '../services/chatUltracode';
import { ATTENTION_PROTOCOL, LEAN_NODE_FIELDS, isChatPermissionMode, isChatPermissionSettings, isCheckinNodeId } from 'michi-shared';
import { getNode } from '../services/dbRepository';
import {
  listWorkspaces, getWorkspace, saveWorkspace, deleteWorkspace,
  listTrees, saveTree, listNodes, saveNode, updateNodeTitle,
  listEdges, saveEdge, listMessages, saveMessage, getMessageCount,
  listContexts, saveContext, loadFullWorkspace, loadAllWorkspaces,
  loadAllWorkspacesMeta, loadWorkspaceMeta, loadTreeMessageSnapshot, loadTreeMessagePage,
  deleteEdge, deleteTree, moveTreeToWorkspace, softDeleteNode, restoreNode, deleteContext,
  getAiGlobalContext, setAiGlobalContext,
  emptyWorkspaceTrash, purgeWorkspaceNodes,
  trimNode, restoreTrimmedNode,
  WorkspaceRow, parseFolders, validateNoNesting, MAX_FOLDERS, FolderEntry,
} from '../services/dbRepository';
import { normalizeIncomingMessageRow } from '../services/messageSerialization';
import { requireWorkspaceOwner, requireNodeOwner } from './middleware/ownership';
import { ensureDurableGraphNode } from '../services/graphCommands';
import { applyWorkspaceCommands, MAX_COMMANDS_PER_BATCH } from '../services/domainCommands';
import { DomainError } from '../services/domainErrors';
import { recordStructureChange, runWithStructureOrigin, structureEvents, structureOriginOf } from '../services/structureEvents';
import { domainErrorResponse } from './domainErrorResponse';
import { ensureRequestedGraphNode } from './graphPrerequisite';
import { projectMessagesForTransport } from './toolOutputTransport';
import { loadProfileActivity } from '../services/profileActivity';
import { extractNodeTree, planNodeExtraction } from '../services/extractNodeTree';
import { acquireSessionRestoreLock } from '../services/nativeResume';
import { chatHub } from '../agents/chatHub';
import { dropSessionForOwner, getSessionForOwner } from '../agents/sessionRegistry';
import { chatOwner } from '../agents/ownerMapping';
import { getRuntime } from '../agents/registry';

/** A node id as Michi mints them (and as assistant links carry them). */
const NODE_ID_SHAPE = /^[A-Za-z0-9._:~@+=-]{1,128}$/;

/**
 * Check-in node ids (`n-cmph-…`, DESIGN-v2 §2.5) are the backend's alone:
 * only createCheckinNode makes one, and no client may save, patch or write
 * messages into one. The fields of a graph save that name a node.
 */
const NODE_ID_FIELDS = ['id', 'nodeId', 'node_id', 'rootNodeId', 'root_node_id', 'parentNodeId', 'parent_node_id',
  'sourceNodeId', 'source_node_id', 'targetNodeId', 'target_node_id', 'originNodeId', 'origin_node_id'] as const;

/** The first check-in node id a client's graph save names (its node, tree, edges or commands), or null. */
function reservedNodeIdIn(value: unknown, depth = 0): string | null {
  if (depth > 6 || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 1000)) {
      const found = reservedNodeIdIn(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const field of NODE_ID_FIELDS) {
    const id = record[field];
    if (typeof id === 'string' && isCheckinNodeId(id)) return id;
  }
  for (const key of ['node', 'tree', 'edges', 'commands', 'payload']) {
    const found = reservedNodeIdIn(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function refuseReservedNodeId(res: express.Response, id: string | null): boolean {
  if (!id) return false;
  res.status(400).json({ code: 'reserved_node_id', error: `node id ${id} is reserved for Michi's check-ins` });
  return true;
}

/**
 * `:nodeId` routes that write a node or its tree (messages, patch,
 * permissions, extract, trim and restore): a check-in node is never a
 * client's to write. Runs before the ownership check, so nothing reads it.
 */
function refuseReservedNodeParam<P extends { nodeId: string }>(req: express.Request<P>, res: express.Response, next: express.NextFunction): void {
  if (refuseReservedNodeId(res, isCheckinNodeId(req.params.nodeId) ? req.params.nodeId : null)) return;
  next();
}

/** A check-in node in this tree, or as its root (each check-in has a tree of its own), or null. */
function reservedNodeInTree(treeId: string): string | null {
  const rows = getDb().prepare('SELECT id FROM nodes WHERE tree_id = ? UNION SELECT root_node_id FROM trees WHERE id = ?')
    .all(treeId, treeId) as Array<{ id: string | null }>;
  return rows.map((row) => row.id).find((id): id is string => typeof id === 'string' && isCheckinNodeId(id)) ?? null;
}

export function setupPersistenceRoutes(): express.Router {
  const router = express.Router();
  router.use(requireRequestAccess);

  router.post('/workspaces/:id/nodes/:nodeId/extract-tree', refuseReservedNodeParam, requireWorkspaceOwner, async (req, res) => {
    const { id: workspaceId, nodeId } = req.params;
    const treeId = req.body?.treeId;
    if (typeof treeId !== 'string' || !treeId.trim() || treeId.length > 128) {
      return res.status(400).json({ error: 'treeId is required (up to 128 characters)' });
    }
    const releases: Array<() => void> = [];
    try {
      const userId = requestOwnerUserId(req);
      // The caller retains treeId across an uncertain response. A retry reads
      // the committed result without copying history or resetting a session again.
      if (listTrees(workspaceId, userId).some(tree => tree.id === treeId && tree.root_node_id === nodeId)) {
        return res.json(extractNodeTree(workspaceId, nodeId, treeId, userId));
      }
      const plan = planNodeExtraction(workspaceId, nodeId, userId);
      for (const id of [...plan.affected].sort()) releases.push(await acquireSessionRestoreLock(id));
      const current = planNodeExtraction(workspaceId, nodeId, userId);
      if (current.affected.some(id => !plan.affected.includes(id))) throw new Error('Branch changed; try extracting again');
      const assertIdle = () => {
        for (const id of current.affected) {
          if (chatHub.isBusy(id)) {
            throw new Error('Wait for replies to finish before extracting this branch');
          }
        }
      };
      assertIdle();
      // Rebuild this root from its new durable transcript on the next send.
      // Reusing its old runtime would retain the old parent-chain pointer.
      const owner = chatOwner(nodeId);
      const session = getSessionForOwner(nodeId, owner, userId ?? null);
      if (session) await getRuntime(session.runtimeId)?.releaseSession(nodeId, owner);
      dropSessionForOwner(nodeId, owner);
      assertIdle();
      res.json(extractNodeTree(workspaceId, nodeId, treeId, userId));
    } catch (error) {
      const message = (error as Error).message;
      res.status(/not found/i.test(message) ? 404 : 409).json({ error: message });
    } finally {
      releases.reverse().forEach(release => release());
    }
  });

  router.post('/workspaces/:id/open-url/claim', requireWorkspaceOwner, (req, res) => {
    if (process.env.MICHI_CLOUD === '1' && !req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    if (!getWorkspace(req.params.id, req.user?.id)) return res.status(404).json({ error: 'not_found' });
    const treeId = req.body?.treeId;
    if (treeId !== null && typeof treeId !== 'string') return res.status(400).json({ error: 'treeId required' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ request: urlOpenRequests.claim({ workspaceId: req.params.id, treeId, ownerUserId: req.user?.id ?? null }) });
  });

  router.get('/permissions/settings', (req, res) => {
    if (process.env.MICHI_CLOUD === '1' && !req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    res.json(readChatPermissionSettings(req.user?.id));
  });
  router.put('/permissions/settings', (req, res) => {
    if (process.env.MICHI_CLOUD === '1' && !req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    if (!isChatPermissionSettings(req.body)) return res.status(400).json({ error: 'global (boolean) and mode (ask, trust, yolo) required; approveForMe must be boolean' });
    writeChatPermissionSettings(req.body, req.user?.id);
    res.json(readChatPermissionSettings(req.user?.id));
  });
  router.put('/nodes/:nodeId/permissions', refuseReservedNodeParam, requireNodeOwner, async (req, res) => {
    if (process.env.MICHI_CLOUD === '1' && !req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    const { nodeId } = req.params;
    // The durable prerequisite this may create names no check-in node either (its tree, a parent).
    if (refuseReservedNodeId(res, reservedNodeIdIn(req.body?.graphPrerequisite))) return;
    if (!isChatPermissionMode(req.body?.mode)) return res.status(400).json({ error: 'mode must be ask, trust, or yolo' });
    const approveForMe = req.body?.approveForMe;
    if (approveForMe !== undefined && typeof approveForMe !== 'boolean') return res.status(400).json({ error: 'approveForMe must be boolean' });
    const missing = await ensureRequestedGraphNode(req, nodeId, req.body?.graphPrerequisite);
    if (missing) return res.status(missing.status).json(missing.body);
    try {
      writeNodePermissionMode(nodeId, req.body.mode, req.user?.id, false, approveForMe === true);
      res.json({ mode: req.body.mode, approveForMe: req.body.mode === 'ask' && approveForMe === true,
        effectiveMode: resolveChatPermissionMode(nodeId, req.user?.id), effectiveApproveForMe: resolveChatApproveForMe(nodeId, req.user?.id) });
    } catch (err) {
      const failure = domainErrorResponse(err);
      res.status(failure.status).json({ error: failure.error });
    }
  });

  // A chat's Ultracode choice: saved first (sessions read it at every spawn
  // and turn), then applied to its live session, which reports what took effect.
  router.put('/nodes/:nodeId/ultracode', refuseReservedNodeParam, requireNodeOwner, async (req, res) => {
    if (process.env.MICHI_CLOUD === '1' && !req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    const { nodeId } = req.params;
    // The durable prerequisite this may create names no check-in node either (its tree, a parent).
    if (refuseReservedNodeId(res, reservedNodeIdIn(req.body?.graphPrerequisite))) return;
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
    const missing = await ensureRequestedGraphNode(req, nodeId, req.body?.graphPrerequisite);
    if (missing) return res.status(missing.status).json(missing.body);
    try {
      writeNodeUltracode(nodeId, enabled, req.user?.id);
    } catch (err) {
      const failure = domainErrorResponse(err);
      return res.status(failure.status).json({ error: failure.error });
    }
    const session = getSessionForOwner(nodeId, chatOwner(nodeId), requestOwnerUserId(req) ?? null);
    try {
      await session?.setUltracode?.(enabled);
    } catch (err) {
      // Saved: the session takes it at its next turn or spawn.
      log.warn('chat', 'ultracode could not be applied to the live session', { nodeId, enabled, error: (err as Error).message });
    }
    res.json({ enabled, ...(session?.getSessionState ? { sessionState: session.getSessionState() } : {}) });
  });

  router.get('/persistence/capabilities', (_req, res) => {
    res.json({
      protocolVersion: 2,
      authoritativeTurnPersistence: true,
      durableNodePrerequisite: true,
      explicitCommands: true,
      backgroundWorkspaceSync: false,
      legacySyncAccepted: false,
      streamTransport: 'websocket-v1',
      // Pane Inspection API (design doc §11): advertised so the frontend can
      // distinguish an old gateway that predates this feature ("unsupported")
      // from a current gateway that legitimately has zero panes right now
      // ("supported, empty"). Bump only alongside a breaking contract change
      // in shared/src/paneInspection.ts.
      paneInspection: 'v1',
      // Server attention (shared/src/attention.ts): this backend decides
      // notifications and delivers them as attention_* frames on the
      // background feed, so a window can leave its local triggers off.
      attention: ATTENTION_PROTOCOL,
      // Chat agents have list_artifacts and search_artifacts (agents/artifactTools.ts)
      // and ensure-session reads artifactCount, so a frontend may name only
      // the pinned artifacts in a first message. An older backend has neither:
      // it gets the full list, at most 50 (frontend state/agentArtifacts.ts).
      artifactTools: 'v1',
      // POST /workspaces/:id/commands skips a context.upsert of a deleted
      // artifact (goneContextIds) and one under a name another artifact holds
      // (nameTakenContextIds) and commits the rest, where an older backend
      // failed the batch (a 500 its sender retried). So a frontend may send
      // an artifact's upsert only to ask which it is (state/workspacePersistence.ts
      // probeArtifacts).
      artifactWriteAnswers: 'v1',
      // POST /workspaces/:id/commands rejects a larger batch (code too_many_commands).
      maxCommandsPerBatch: MAX_COMMANDS_PER_BATCH,
    });
  });

  router.get('/profile/activity', (req, res) => {
    const timeZone = typeof req.query.timeZone === 'string' ? req.query.timeZone : 'UTC';
    const userId = requestOwnerUserId(req);
    if (process.env.MICHI_CLOUD === '1' && !userId) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      res.json(loadProfileActivity({ userId, timeZone }));
    } catch (err) {
      if (err instanceof RangeError) {
        return res.status(400).json({ error: err.message });
      }
      log.error('workspace', 'profile activity aggregation failed', { error: (err as Error).message });
      res.status(500).json({ error: 'Failed to load profile activity' });
    }
  });

  // Backend-owned node identity allocation. This intentionally does not write
  // SQLite: an unused allocation is harmless, while the existing graph command
  // path remains authoritative for creating the node/tree/edge rows.
  router.post('/node-ids/allocate', (req, res) => {
    const rawCount = req.body?.count ?? 1;
    if (!Number.isInteger(rawCount) || rawCount < 1 || rawCount > 100) {
      return res.status(400).json({ error: 'count must be an integer between 1 and 100' });
    }
    res.json({ nodeIds: Array.from({ length: rawCount }, () => `n-${randomUUID()}`) });
  });

  // List all workspaces (lightweight, no messages)
  router.get('/workspaces', (req, res) => {
    try {
      const userId: string | undefined = requestOwnerUserId(req);
      const workspaces = listWorkspaces(userId);
      res.json({ workspaces });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Bulk-load all workspaces in a single request.
  //   ?meta=1 → structure + per-node message_count, NO message bodies (the
  //             lazy-load hydration payload; bodies come per-tree below).
  //   &lean=1 → rows also leave out the lean node fields that hold a value,
  //             named in `leanNodeFields` (shared/leanNodeFields); tree pages
  //             bring them.
  //   (default) → full snapshot including every message body (legacy path).
  router.get('/workspaces/all', (req, res) => {
    try {
      const userId: string | undefined = requestOwnerUserId(req);
      const meta = req.query.meta === '1' || req.query.meta === 'true';
      const lean = meta && (req.query.lean === '1' || req.query.lean === 'true');
      // Taken before the read: a structure frame numbered past it may be
      // missing from this snapshot, so the window re-reads (see structureEvents).
      const structureCursor = structureEvents.cursor(userId);
      const data = meta ? loadAllWorkspacesMeta(userId, { lean }) : loadAllWorkspaces(userId).map(projectMessagesForTransport);
      res.json({ workspaces: data, structureCursor, ...(lean ? { leanNodeFields: LEAN_NODE_FIELDS } : {}) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Lazy-load: all message bodies for ONE tree. Fetched when a tree is
  // activated / opened and its nodes are still unloaded placeholders.
  router.get('/workspaces/:id/trees/:treeId/messages', requireWorkspaceOwner, (req, res) => {
    try {
      const userId: string | undefined = requestOwnerUserId(req);
      if (req.query.limit !== undefined) {
        const limit = Number(req.query.limit);
        const nodeId = typeof req.query.nodeId === 'string' ? req.query.nodeId : undefined;
        const beforeSeq = req.query.beforeSeq === undefined ? undefined : Number(req.query.beforeSeq);
        const beforeId = typeof req.query.beforeId === 'string' ? req.query.beforeId : undefined;
        if (typeof req.query.limit !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 200
          || (req.query.nodeId !== undefined && (!nodeId || nodeId.length > 256))
          || ((beforeSeq !== undefined || req.query.beforeId !== undefined)
            && (!nodeId || typeof req.query.beforeSeq !== 'string' || !Number.isSafeInteger(beforeSeq)
              || beforeSeq! < 0 || !beforeId || beforeId.length > 256))) {
          return res.status(400).json({ error: 'Invalid message page parameters' });
        }
        res.setHeader('Cache-Control', 'no-store');
        return res.json(projectMessagesForTransport(loadTreeMessagePage(req.params.id, req.params.treeId,
          { limit, nodeId, before: beforeSeq === undefined ? undefined : { seq: beforeSeq, id: beforeId! } }, userId)));
      }
      // Tool outputs travel without inline images and, when long, as head + tail; the rows stay whole.
      res.json(projectMessagesForTransport(loadTreeMessageSnapshot(req.params.id, req.params.treeId, userId)));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get full workspace with all nested data
  //   ?meta=1 → structure + per-node message_count, no message bodies (the
  //             structure re-read after a workspace_structure_changed frame).
  router.get('/workspaces/:id', requireWorkspaceOwner, (req, res) => {
    try {
      const userId: string | undefined = requestOwnerUserId(req);
      const meta = req.query.meta === '1' || req.query.meta === 'true';
      const data = meta ? loadWorkspaceMeta(req.params.id, userId) : loadFullWorkspace(req.params.id, userId);
      if (!data) return res.status(404).json({ error: 'Workspace not found' });
      res.json(meta ? data : projectMessagesForTransport(data));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Backend-first graph prerequisite. Creates only the workspace/tree/node
  // slice required by one chat-capable node; safe to retry with the same IDs.
  router.post('/workspaces/:id/graph/nodes/ensure', (req, res, next) => {
    if (refuseReservedNodeId(res, reservedNodeIdIn(req.body))) return;
    if (process.env.MICHI_CLOUD === '1' && getWorkspace(req.params.id)) {
      return requireWorkspaceOwner(req, res, next);
    }
    next();
  }, (req, res) => {
    try {
      if (!req.body?.workspace || req.body.workspace.id !== req.params.id || !req.body?.node) {
        return res.status(400).json({ error: 'workspace and node are required and workspace.id must match the route' });
      }
      const result = runWithStructureOrigin(structureOriginOf(req), () => ensureDurableGraphNode({
        ...req.body,
        ownerUserId: (requestOwnerUserId(req) ?? null),
      }));
      res.json({ ok: true, ...result });
    } catch (err) {
      const failure = domainErrorResponse(err);
      res.status(failure.status).json({ error: failure.error });
    }
  });

  router.post('/workspaces/:id/commands', (req, res, next) => {
    if (refuseReservedNodeId(res, reservedNodeIdIn(req.body?.commands))) return;
    if (process.env.MICHI_CLOUD === '1' && getWorkspace(req.params.id)) {
      return requireWorkspaceOwner(req, res, next);
    }
    next();
  }, (req, res) => {
    try {
      // A window's own command batch: its store already shows every change in it.
      const result = runWithStructureOrigin(structureOriginOf(req), () => applyWorkspaceCommands(req.params.id, {
        operationId: req.body?.operationId,
        commands: req.body?.commands,
        ownerUserId: (requestOwnerUserId(req) ?? null),
        // A window that matches artifacts by id only (domainCommands.ts takenOver).
        ...(req.body?.artifactIdentity === 'id' ? { artifactIdentity: 'id' as const } : {}),
      }));
      res.json({ ok: true, ...result });
    } catch (err) {
      const failure = domainErrorResponse(err);
      if (!(err instanceof DomainError)) return res.status(failure.status).json({ error: failure.error });
      // The batch's shape only: never ids or payload content.
      const commands: unknown = req.body?.commands;
      const operationId: unknown = req.body?.operationId;
      log.warn('workspace', 'workspace commands rejected', {
        status: failure.status,
        code: err.code,
        commandIndex: err.details?.commandIndex,
        commandCount: Array.isArray(commands) ? commands.length : undefined,
        operationIdLength: typeof operationId === 'string' ? operationId.length : undefined,
      });
      // `code` (and where it applies the failing command, or maxCommands) lets a client act without parsing `error`.
      res.status(failure.status).json({ ...err.details, error: failure.error, code: err.code });
    }
  });

  // Create or update workspace.
  // In cloud mode: on INSERT, stamp owner_user_id = req.user.id.
  //                on UPDATE, verify ownership via requireWorkspaceOwner
  //                           (middleware no-ops when row doesn't exist yet,
  //                            which is the create path).
  router.put('/workspaces/:id', (req, res, next) => {
    // For updates (row already exists) enforce ownership in cloud mode.
    // For inserts (new workspace) skip the check — we'll stamp the owner below.
    if (process.env.MICHI_CLOUD === '1') {
      const existing = getWorkspace(req.params.id);
      if (existing) {
        return requireWorkspaceOwner(req, res, next);
      }
    }
    next();
  }, (req, res) => {
    try {
      const existed = !!getWorkspace(req.params.id);
      const ws: WorkspaceRow = {
        id: req.params.id,
        name: req.body.name || 'Untitled',
        cwd: req.body.cwd ?? null,
        active_tree_id: req.body.active_tree_id ?? null,
        created_at: req.body.created_at ?? Date.now(),
        updated_at: Date.now(),
        settings: req.body.settings ? JSON.stringify(req.body.settings) : null,
        deleted_at: req.body.deleted_at ?? null,
        archived_at: req.body.archived_at ?? null,
        folders: req.body.folders ? JSON.stringify(req.body.folders) : null,
        // In cloud mode, stamp owner on INSERT; COALESCE in saveWorkspace
        // preserves the existing owner on UPDATE so this null is fine there.
        owner_user_id: (requestOwnerUserId(req) ?? null),
      };
      runWithStructureOrigin(structureOriginOf(req), () => saveWorkspace(ws));
      log.info('workspace', existed ? 'updated' : 'created', { id: ws.id, name: ws.name, cwd: ws.cwd ?? undefined });
      res.json({ ok: true });
    } catch (err) {
      log.error('workspace', 'save failed', { id: req.params.id, err: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Delete workspace (cascade)
  router.delete('/workspaces/:id', requireWorkspaceOwner, (req, res) => {
    try {
      const userId: string | undefined = requestOwnerUserId(req);
      deleteWorkspace(req.params.id, userId);
      log.info('workspace', 'deleted', { id: req.params.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('workspace', 'delete failed', { id: req.params.id, err: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Workspace folder management ──────────────────────────────────────────
  // POST /workspaces/:id/folders with { action, ... } payload.
  // Actions: add-folder, remove-folder, reorder-folders, update-folder-label.
  router.post('/workspaces/:id/folders', requireWorkspaceOwner, (req, res) => {
    try {
      const ws = getWorkspace(req.params.id);
      if (!ws) return res.status(404).json({ error: 'workspace not found' });

      const folders = parseFolders(ws);
      const { action } = req.body;

      if (action === 'add-folder') {
        const { path: folderPath, label } = req.body;
        if (!folderPath || typeof folderPath !== 'string') {
          return res.status(400).json({ error: 'path is required' });
        }
        if (folders.length >= MAX_FOLDERS) {
          return res.status(400).json({ error: `maximum ${MAX_FOLDERS} folders reached` });
        }
        // Validate path exists and is a directory
        const fs = require('node:fs');
        const pathMod = require('node:path');
        const resolved = pathMod.resolve(folderPath);
        try {
          const stat = fs.statSync(resolved);
          if (!stat.isDirectory()) {
            return res.status(400).json({ error: `"${folderPath}" is not a directory` });
          }
        } catch {
          return res.status(400).json({ error: `"${folderPath}" does not exist` });
        }
        // Nesting check
        const nestingError = validateNoNesting(folders, resolved);
        if (nestingError) return res.status(400).json({ error: nestingError });

        const newEntry: FolderEntry = {
          id: randomUUID().slice(0, 16),
          path: resolved,
          label: label || undefined,
          addedAt: Date.now(),
        };
        folders.push(newEntry);
        saveWorkspace({ ...ws, folders: JSON.stringify(folders), updated_at: Date.now() });
        log.info('workspace', 'folder added', { id: ws.id, path: resolved });
        return res.json({ ok: true, folders, added: newEntry });

      } else if (action === 'remove-folder') {
        const { folderId } = req.body;
        if (!folderId) return res.status(400).json({ error: 'folderId is required' });
        if (folders.length > 0 && folders[0].id === folderId) {
          return res.status(400).json({ error: 'cannot remove the working directory (first folder)' });
        }
        const idx = folders.findIndex(f => f.id === folderId);
        if (idx < 0) return res.status(404).json({ error: 'folder not found' });
        folders.splice(idx, 1);
        saveWorkspace({ ...ws, folders: JSON.stringify(folders), updated_at: Date.now() });
        log.info('workspace', 'folder removed', { id: ws.id, folderId });
        return res.json({ ok: true, folders });

      } else if (action === 'reorder-folders') {
        // folderIds is the desired order for indices 1+. Index 0 stays pinned.
        const { folderIds } = req.body;
        if (!Array.isArray(folderIds)) {
          return res.status(400).json({ error: 'folderIds must be an array' });
        }
        if (folders.length <= 1) return res.json({ ok: true, folders });
        const pinned = folders[0];
        const rest = folders.slice(1);
        const reordered = folderIds
          .map((id: string) => rest.find(f => f.id === id))
          .filter(Boolean) as FolderEntry[];
        // Append any folders not in the provided order (shouldn't happen but be safe)
        for (const f of rest) {
          if (!reordered.some(r => r.id === f.id)) reordered.push(f);
        }
        const newFolders = [pinned, ...reordered];
        saveWorkspace({ ...ws, folders: JSON.stringify(newFolders), updated_at: Date.now() });
        return res.json({ ok: true, folders: newFolders });

      } else if (action === 'update-folder-label') {
        const { folderId, label } = req.body;
        if (!folderId) return res.status(400).json({ error: 'folderId is required' });
        const target = folders.find(f => f.id === folderId);
        if (!target) return res.status(404).json({ error: 'folder not found' });
        target.label = label || undefined;
        saveWorkspace({ ...ws, folders: JSON.stringify(folders), updated_at: Date.now() });
        return res.json({ ok: true, folders });

      } else {
        return res.status(400).json({ error: `unknown action: ${action}` });
      }
    } catch (err) {
      log.error('workspace', 'folder action failed', {
        id: req.params.id, action: req.body?.action, err: (err as Error).message,
      });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Permanently empty a workspace's trash: physically delete every node with
  // deleted_at IS NOT NULL (along with their cascaded edges/messages and any
  // newly-orphaned trees). Returns the row count actually purged so the
  // frontend can show a confirmation and skip its own state update if zero.
  //
  // The frontend awaits this BEFORE clearing local state so an in-flight
  // POST /sync carrying the pre-purge snapshot cannot revive the nodes by
  // re-inserting them: with the rows physically gone server-side and the
  // sync pause-flag held until our local state catches up, no stale snapshot
  // can write them back in the same tab.
  router.post('/workspaces/:id/trash/empty', requireWorkspaceOwner, (req, res) => {
    try {
      const purged = emptyWorkspaceTrash(req.params.id);
      log.info('workspace', 'trash emptied', { id: req.params.id, purged });
      res.json({ ok: true, purged });
    } catch (err) {
      log.error('workspace', 'empty trash failed', {
        id: req.params.id, err: (err as Error).message,
      });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Permanently purge a specific list of nodes from a workspace. Used by the
  // single-group "delete permanently" action in Trash. Body: { nodeIds: string[] }.
  // Same cascade behaviour as /trash/empty. Empty array is a no-op (200).
  router.delete('/workspaces/:id/nodes', requireWorkspaceOwner, (req, res) => {
    try {
      const nodeIds: string[] = Array.isArray(req.body?.nodeIds) ? req.body.nodeIds : [];
      // A check-in purges its own node when its run ends (DESIGN-v2 §3.1); no client does.
      if (refuseReservedNodeId(res, nodeIds.find((nodeId) => typeof nodeId === 'string' && isCheckinNodeId(nodeId)) ?? null)) return;
      if (nodeIds.length === 0) return res.json({ ok: true, purged: 0 });
      const purged = purgeWorkspaceNodes(req.params.id, nodeIds);
      log.info('workspace', 'nodes purged', { id: req.params.id, requested: nodeIds.length, purged });
      res.json({ ok: true, purged });
    } catch (err) {
      log.error('workspace', 'purge nodes failed', {
        id: req.params.id, err: (err as Error).message,
      });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Move a tree (with its nodes and intra-tree edges) to another workspace.
  router.post('/trees/:treeId/move', (req, res) => {
    try {
      const { treeId } = req.params;
      const fromWorkspaceId = String(req.body?.fromWorkspaceId ?? '');
      const toWorkspaceId = String(req.body?.toWorkspaceId ?? '');
      if (!fromWorkspaceId || !toWorkspaceId) {
        return res.status(400).json({ error: 'fromWorkspaceId and toWorkspaceId required' });
      }
      // A check-in's tree stays where the backend made it.
      if (refuseReservedNodeId(res, reservedNodeInTree(treeId))) return;
      // Cloud-mode: caller must own BOTH source and target workspaces.
      if (process.env.MICHI_CLOUD === '1') {
        const userId = requestOwnerUserId(req);
        const src = getWorkspace(fromWorkspaceId);
        const dst = getWorkspace(toWorkspaceId);
        if (!src || src.owner_user_id !== userId) return res.status(404).json({ error: 'not_found' });
        if (!dst || dst.owner_user_id !== userId) return res.status(404).json({ error: 'not_found' });
      }
      if (fromWorkspaceId === toWorkspaceId) {
        return res.json({ ok: true, movedNodes: 0, movedEdges: 0, droppedEdges: 0 });
      }
      const userId: string | undefined = requestOwnerUserId(req);
      const result = moveTreeToWorkspace(treeId, fromWorkspaceId, toWorkspaceId, userId);
      log.info('tree', 'moved', { treeId, fromWorkspaceId, toWorkspaceId, ...result });
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = (err as Error).message;
      log.error('tree', 'move failed', { treeId: req.params.treeId, err: msg });
      res.status(/not found/.test(msg) ? 404 : 500).json({ error: msg });
    }
  });

  // Which workspace and thread hold a live node: a window loads one thread
  // it doesn't have yet (an assistant link to a thread made in another
  // window) without reading every workspace. Deleted nodes and workspaces
  // are not found; requireNodeOwner hides other owners' nodes in cloud mode.
  // The id is checked before anything (the ownership check included) reads it.
  const requireNodeIdShape = (req: express.Request<{ nodeId: string }>, res: express.Response, next: express.NextFunction) => {
    if (!NODE_ID_SHAPE.test(req.params.nodeId ?? '')) {
      res.status(400).json({ error: 'nodeId must be 1-128 characters of letters, digits and ._:~@+=-' });
      return;
    }
    next();
  };
  router.get('/nodes/:nodeId/workspace', requireNodeIdShape, requireNodeOwner, (req, res) => {
    const { nodeId } = req.params;
    const node = getNode(nodeId);
    const workspace = node ? getWorkspace(node.workspace_id) : null;
    if (!node || node.deleted_at != null || !workspace || workspace.deleted_at != null) {
      return res.status(404).json({ error: 'not_found' });
    }
    res.json({ workspaceId: workspace.id, treeId: node.tree_id ?? null });
  });

  // Save a single message to a node
  router.post('/nodes/:nodeId/messages', refuseReservedNodeParam, requireNodeOwner, (req, res) => {
    try {
      const userId: string | undefined = requestOwnerUserId(req);
      saveMessage(normalizeIncomingMessageRow(
        req.body ?? {},
        req.params.nodeId,
        req.body.seq ?? getMessageCount(req.params.nodeId, userId),
      ), userId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Update node fields (title, position, etc.)
  router.patch('/nodes/:nodeId', refuseReservedNodeParam, requireNodeOwner, (req, res) => {
    try {
      const { title, position_x, position_y, status, minimized, pane_width } = req.body;
      const db = getDb();
      const sets: string[] = [];
      const params: any[] = [];
      if (title !== undefined) { sets.push('title = ?'); params.push(title); }
      if (position_x !== undefined) { sets.push('position_x = ?'); params.push(position_x); }
      if (position_y !== undefined) { sets.push('position_y = ?'); params.push(position_y); }
      if (status !== undefined) { sets.push('status = ?'); params.push(status); }
      if (minimized !== undefined) { sets.push('minimized = ?'); params.push(minimized); }
      if (pane_width !== undefined) { sets.push('pane_width = ?'); params.push(pane_width); }
      if (sets.length === 0) return res.json({ ok: true });
      const before = title !== undefined ? getNode(req.params.nodeId) : null;
      params.push(req.params.nodeId);
      db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ? AND purged_at IS NULL`).run(...params);
      if (before && (before.title ?? null) !== (title ?? null)) {
        runWithStructureOrigin(structureOriginOf(req), () => recordStructureChange({
          entity: 'node', op: 'renamed', workspaceId: before.workspace_id, nodeId: before.id,
          ...(before.tree_id ? { treeId: before.tree_id } : {}),
        }));
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Single-node trim: send the node to trash AND reparent its children up.
  // Body { deletedAt: number, groupId: string } so the timestamp/group come
  // from the client (which is the source of truth for the trash UI). Returns
  // { trimmed: 1 } on success, { trimmed: 0 } if the node was not found in
  // the given workspace (e.g. already purged via a sibling tab).
  router.post('/workspaces/:id/nodes/:nodeId/trim', refuseReservedNodeParam, requireWorkspaceOwner, (req, res) => {
    try {
      const deletedAt = Number(req.body?.deletedAt);
      const groupId = String(req.body?.groupId ?? '');
      if (!Number.isFinite(deletedAt) || !groupId) {
        return res.status(400).json({ error: 'deletedAt (number) and groupId (string) required' });
      }
      const result = trimNode(req.params.id, req.params.nodeId, deletedAt, groupId);
      log.info('workspace', 'node trimmed', { workspaceId: req.params.id, nodeId: req.params.nodeId, ...result });
      res.json({ ok: true, ...result });
    } catch (err) {
      log.error('workspace', 'node trim failed', {
        workspaceId: req.params.id, nodeId: req.params.nodeId, err: (err as Error).message,
      });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Restore a previously-trimmed node. Returns { restored: false } if the
  // node has no trim_snapshot (caller should fall back to /restore for
  // subtree-deleted nodes — that path is handled in chatStore today and
  // doesn't need its own backend hook).
  router.post('/workspaces/:id/nodes/:nodeId/restore-trim', refuseReservedNodeParam, requireWorkspaceOwner, (req, res) => {
    try {
      const result = restoreTrimmedNode(req.params.id, req.params.nodeId);
      log.info('workspace', 'node trim restored', { workspaceId: req.params.id, nodeId: req.params.nodeId, ...result });
      res.json({ ok: true, ...result });
    } catch (err) {
      log.error('workspace', 'node restore-trim failed', {
        workspaceId: req.params.id, nodeId: req.params.nodeId, err: (err as Error).message,
      });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Per-workspace toggle: AI global context (list_threads / search_messages / read_node tools).
  // Stored inside workspaces.settings JSON. Default ON.
  router.get('/workspaces/:id/ai-global-context', requireWorkspaceOwner, (req, res) => {
    try {
      const userId: string | undefined = requestOwnerUserId(req);
      const enabled = getAiGlobalContext(req.params.id, userId);
      res.json({ enabled });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:id/ai-global-context', requireWorkspaceOwner, (req, res) => {
    const { id } = req.params;
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    try {
      const userId: string | undefined = requestOwnerUserId(req);
      setAiGlobalContext(id, enabled, userId);
      res.json({ ok: true, enabled });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── User preferences (persisted to ~/.michi/config.json) ────────────────
  router.get('/prefs', (req, res) => {
    try {
      const permissions = readChatPermissionSettings(req.user?.id);
      const permissionPrefs = { globalPermissions: permissions.global, permissionMode: permissions.mode,
        permissionApproveForMe: permissions.approveForMe === true, bypassPermissions: false };
      const prefs = readPrefs();
      if (!prefs) {
        // One-time migration: if config.json has no prefs yet, seed from SQLite.
        const db = getDb();
        const row = db.prepare("SELECT value FROM meta WHERE key = 'user_prefs'").get() as { value: string } | undefined;
        if (row) {
          const legacy = JSON.parse(row.value);
          migrateFromSqlite(legacy);
          return res.json({ prefs: { ...readPrefs(), ...permissionPrefs } });
        }
        return res.json({ prefs: permissionPrefs });
      }
      res.json({ prefs: { ...prefs, ...permissionPrefs } });
    } catch (err) {
      const mapped = jsonConfigErrorResponse(err);
      res.status(mapped?.status ?? 500).json(mapped?.body ?? { error: (err as Error).message });
    }
  });

  router.put('/prefs', (req, res) => {
    try {
      writePrefs(req.body);
      res.json({ ok: true });
    } catch (err) {
      const mapped = jsonConfigErrorResponse(err);
      res.status(mapped?.status ?? 500).json(mapped?.body ?? { error: (err as Error).message });
    }
  });

  return router;
}
