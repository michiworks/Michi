import { DomainError, serializeDomainError } from './domainErrors';
import { assertActiveTree, assertEdgePlacement, assertNodePlacement, assertTreeRoot, type NodePlacementLookup } from './nodePlacement';
import { assertGraphNodeInput, requiredGraphId as requiredId } from './graphCommandValidation';
import type { TreeRowChange } from './graphCommandTypes';
/**
 * Database Worker Thread
 *
 * Runs SQLite write operations on a dedicated worker thread so the Express
 * main thread's event loop is never blocked by database I/O.
 *
 * Communication is via `parentPort` messages:
 *   → { id, command, args }
 *   ← { id, result } | { id, error }
 *
 * The worker owns its own DatabaseSync connection (WAL allows concurrent
 * readers on the main thread). Transactions stay thread-local.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import {
  mergeServerOwnedSettings,
  type DurableTurnSnapshot,
} from 'michi-shared';
// turnPersistence.recipes imports are now consumed via turnPersistence.core

if (!parentPort) throw new Error('dbWorkerThread must run as a Worker');

// ── Database setup ─────────────────────────────────────────────────────────

const dbPath: string = workerData.dbPath;
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 15000');

const stmtCache = new Map<string, StatementSync>();

function cached(sql: string): StatementSync {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

function runInTransaction<T>(fn: () => T): T {
  const maxRetries = 3;
  for (let attempt = 0; ; attempt++) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      if (isSqliteBusy(err) && attempt < maxRetries) {
        sleepSyncMs(100 * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }
}

/** Detect SQLite BUSY / database-is-locked errors. */
function isSqliteBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('database is locked') || msg.includes('sqlite_busy');
}

/** Synchronous millisecond sleep (does not yield the event loop). */
function sleepSyncMs(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

// ── Helpers (replicated from dbRepository — minimal subset) ────────────────

type Row = Record<string, SQLInputValue>;

function getRow(sql: string, ...params: SQLInputValue[]): Row | undefined {
  return cached(sql).get(...params) as Row | undefined;
}

function allRows(sql: string, ...params: SQLInputValue[]): Row[] {
  return cached(sql).all(...params) as unknown as Row[];
}

function run(sql: string, ...params: SQLInputValue[]): { changes: number } {
  return cached(sql).run(...params) as unknown as { changes: number };
}

function runNamed(sql: string, params: Record<string, SQLInputValue>): void {
  cached(sql).run(params);
}

// ── Tombstone guards ───────────────────────────────────────────────────────

function asValue(v: unknown): SQLInputValue {
  return v as SQLInputValue;
}

function isWorkspaceTombstoned(workspaceId: string): boolean {
  const row = getRow('SELECT purged_at FROM workspaces WHERE id = ?', workspaceId);
  return (row as { purged_at: number | null } | undefined)?.purged_at != null;
}

function isNodeTombstoned(nodeId: string): boolean {
  const row = getRow('SELECT purged_at FROM nodes WHERE id = ?', nodeId);
  return (row as { purged_at: number | null } | undefined)?.purged_at != null;
}

/** Same lookup as dbRepository.getNode: a tombstoned node is not found. */
function getNode(nodeId: SQLInputValue): Row | undefined {
  return getRow('SELECT * FROM nodes WHERE id = ? AND purged_at IS NULL', nodeId);
}

// ── Graph prerequisite (ensureDurableGraphNode) ────────────────────────────


interface SaveWorkspaceInput {
  id: string;
  name: string;
  cwd: string | null;
  active_tree_id: string | null;
  created_at: number;
  updated_at: number;
  settings: string | null;
  deleted_at: number | null;
  archived_at: number | null;
  pinned_at?: number | null;
  backend: string;
  owner_user_id: string | null;
  folders?: string | null;
}

function saveWorkspace(ws: SaveWorkspaceInput): void {
  const existing = getRow('SELECT purged_at, settings FROM workspaces WHERE id = ?', ws.id) as
    { purged_at: number | null; settings: string | null } | undefined;
  if (existing && existing.purged_at !== null) return;
  const params: Record<string, SQLInputValue> = {
    id: ws.id,
    name: ws.name,
    cwd: ws.cwd ?? null,
    active_tree_id: ws.active_tree_id ?? null,
    created_at: ws.created_at,
    updated_at: ws.updated_at,
    // Same rule as dbRepository.saveWorkspace: server-owned settings keys come only from the stored row.
    settings: mergeServerOwnedSettings(existing?.settings, ws.settings),
    deleted_at: ws.deleted_at ?? null,
    archived_at: ws.archived_at ?? null,
    pinned_at: ws.pinned_at ?? null,
    backend: ws.backend ?? 'kiro',
    owner_user_id: ws.owner_user_id ?? null,
    folders: ws.folders ?? null,
  };
  runNamed(`
    INSERT INTO workspaces (id, name, cwd, active_tree_id, created_at, updated_at, settings, deleted_at, archived_at, pinned_at, backend, owner_user_id, folders)
    VALUES (@id, @name, @cwd, @active_tree_id, @created_at, @updated_at, @settings, @deleted_at, @archived_at, @pinned_at, @backend, @owner_user_id, @folders)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, cwd=excluded.cwd,
      active_tree_id=excluded.active_tree_id, updated_at=excluded.updated_at, settings=excluded.settings,
      deleted_at=excluded.deleted_at, archived_at=excluded.archived_at, pinned_at=excluded.pinned_at,
      backend=excluded.backend,
      owner_user_id=COALESCE(excluded.owner_user_id, workspaces.owner_user_id),
      folders=excluded.folders
  `, params);
}

/**
 * Same upsert as dbRepository.saveTree. ensureDurableGraphNode, like
 * graphCommands, rejects a tree replayed with another root before saving it,
 * so the root_node_id update never re-roots a tree. This thread has no
 * structure bus: the change dbRepository.saveTree passes to
 * recordTreeRowChange is returned instead, and the main thread records it
 * once this transaction has committed.
 */
function saveTree(tree: Record<string, SQLInputValue>, _userId?: string): TreeRowChange | null {
  const wsId = tree.workspace_id as string;
  if (isWorkspaceTombstoned(wsId)) return null;
  const existing = getRow('SELECT workspace_id, name, archived_at FROM trees WHERE id = ?', tree.id) as
    TreeRowChange['before'] | undefined;
  runNamed(`
    INSERT INTO trees (id, workspace_id, root_node_id, name, archived_at, pinned_at, last_active_at, created_at, rev)
    VALUES (@id, @workspace_id, @root_node_id, @name, @archived_at, @pinned_at, @last_active_at, @created_at, @rev)
    ON CONFLICT(id) DO UPDATE SET
      root_node_id=excluded.root_node_id, name=excluded.name,
      archived_at=excluded.archived_at, pinned_at=excluded.pinned_at,
      last_active_at=excluded.last_active_at,
      rev=COALESCE(excluded.rev, trees.rev)
  `, { name: null, archived_at: null, pinned_at: null, rev: null, ...tree });
  // An upsert never moves a tree: the stored workspace stands.
  return {
    before: existing ?? null,
    after: {
      id: tree.id as string,
      workspace_id: existing?.workspace_id ?? wsId,
      name: (tree.name as string | null) ?? null,
      archived_at: (tree.archived_at as number | null) ?? null,
    },
  };
}

/**
 * The insert dbRepository.saveNode makes for a new node. Like it, the node
 * takes maintenance_job_id and scheduled_only_job_id from its stored parent,
 * never from the input, so a branch stays restricted and hidden where its
 * parent is, and a temporary chat's branch is one too (memory_mode 'off',
 * memory/temporaryChat.ts inheritedMemoryMode; that module reads the main
 * thread's database, so this thread does not import it).
 * ensureDurableGraphNode calls this only for a node getNode does not find, so
 * the conflict clause does not run.
 */
function saveNode(node: Record<string, SQLInputValue>, _userId?: string): void {
  const wsId = node.workspace_id as string;
  if (isWorkspaceTombstoned(wsId)) return;
  if (isNodeTombstoned(node.id as string)) return;
  const parentMarkers = node.parent_node_id
    ? getRow('SELECT maintenance_job_id, scheduled_only_job_id, memory_mode FROM nodes WHERE id = ?', node.parent_node_id)
    : undefined;
  runNamed(`
    INSERT INTO nodes (
      id, workspace_id, tree_id, parent_node_id, kind, title, status, minimized,
      spawned_by_agent, current_mode_id, composer_draft, created_at, maintenance_job_id, scheduled_only_job_id, memory_mode
    ) VALUES (
      @id, @workspace_id, @tree_id, @parent_node_id, @kind, @title, @status, @minimized,
      @spawned_by_agent, @current_mode_id, @composer_draft, @created_at, @maintenance_job_id, @scheduled_only_job_id, @memory_mode
    )
    ON CONFLICT(id) DO NOTHING
  `, {
    ...node,
    maintenance_job_id: parentMarkers?.maintenance_job_id ?? null,
    scheduled_only_job_id: parentMarkers?.scheduled_only_job_id ?? null,
    memory_mode: parentMarkers?.memory_mode === 'off' ? 'off' : null,
  });
}

/**
 * Same tombstone guards and upsert as dbRepository.saveEdge. A replay takes
 * the new anchor_message_id and created_at and keeps the first fork boundary.
 * ensureDurableGraphNode rejects an edge replayed with other endpoints or
 * kind before saving it, so those columns keep their values.
 */
function saveEdge(edge: Record<string, SQLInputValue>, _userId?: string): void {
  const wsId = edge.workspace_id as string;
  if (
    isWorkspaceTombstoned(wsId)
    || isNodeTombstoned(edge.source_node_id as string)
    || isNodeTombstoned(edge.target_node_id as string)
  ) return;
  runNamed(`
    INSERT INTO edges (id, workspace_id, source_node_id, target_node_id, kind, anchor_message_id,
      fork_boundary_message_id, fork_kind, created_at, rev)
    VALUES (@id, @workspace_id, @source_node_id, @target_node_id, @kind, @anchor_message_id,
      @fork_boundary_message_id, @fork_kind, @created_at, @rev)
    ON CONFLICT(id) DO UPDATE SET
      source_node_id=excluded.source_node_id,
      target_node_id=excluded.target_node_id,
      kind=excluded.kind,
      anchor_message_id=excluded.anchor_message_id,
      fork_boundary_message_id=COALESCE(edges.fork_boundary_message_id, excluded.fork_boundary_message_id),
      fork_kind=COALESCE(excluded.fork_kind, edges.fork_kind),
      created_at=excluded.created_at,
      rev=COALESCE(excluded.rev, edges.rev)
  `, { rev: null, ...edge });
}

function ensureDurableGraphNode(input: Record<string, unknown>): Record<string, SQLInputValue | null | Row | Row[] | TreeRowChange> {
  assertGraphNodeInput(input);
  return runInTransaction(() => {
    const workspace = input.workspace as Record<string, unknown>;
    const node = input.node as Record<string, unknown>;
    const tree = input.tree as Record<string, unknown> | undefined;
    const edges = input.edges;
    const ownerUserId = (input.ownerUserId as string) ?? null;
    const isCloud = process.env.MICHI_CLOUD === '1';

    const workspaceId = requiredId(workspace.id as string, 'workspace.id');
    const nodeId = requiredId(node.id as string, 'node.id');

    const existingWorkspace = getRow('SELECT * FROM workspaces WHERE id = ? AND purged_at IS NULL', workspaceId) as Row | undefined;
    if (isCloud && existingWorkspace && existingWorkspace.owner_user_id !== ownerUserId) {
      throw new DomainError('not_found', 'workspace_not_found', 'workspace not found');
    }

    saveWorkspace({
      id: workspaceId,
      name: ((workspace.name as string) || '').trim() || 'Untitled',
      cwd: (workspace.cwd as string) ?? null,
      active_tree_id: (workspace.activeTreeId as string) ?? null,
      created_at: workspace.createdAt as number,
      updated_at: Date.now(),
      settings: workspace.settings === undefined
        ? (existingWorkspace?.settings as string) ?? null
        : workspace.settings
          ? JSON.stringify(workspace.settings)
          : null,
      deleted_at: (existingWorkspace?.deleted_at as number) ?? null,
      archived_at: (existingWorkspace?.archived_at as number) ?? null,
      pinned_at: (existingWorkspace?.pinned_at as number) ?? null,
      backend: (existingWorkspace?.backend as string) ?? 'kiro',
      owner_user_id: ownerUserId ?? (existingWorkspace?.owner_user_id as string) ?? null,
      folders: (existingWorkspace?.folders as string) ?? null,
    });

    let treeRow: Row | null = null;
    let treeChange: TreeRowChange | null = null;
    if (tree) {
      const treeId = requiredId(tree.id as string, 'tree.id');
      if (node.treeId && node.treeId !== treeId) {
        throw new DomainError('conflict', 'node_tree_mismatch', 'node.treeId must match tree.id');
      }
      const existingTree = getRow(
        'SELECT workspace_id, root_node_id FROM trees WHERE id = ?', treeId,
      );
      if (existingTree?.workspace_id !== undefined && existingTree.workspace_id !== workspaceId) {
        throw new DomainError('conflict', 'tree_workspace_mismatch', `tree ${treeId} belongs to a different workspace`);
      }
      if (existingTree && existingTree.root_node_id !== tree.rootNodeId) {
        throw new DomainError('conflict', 'tree_identity_mismatch', `tree ${treeId} was replayed with a different root`);
      }
      treeChange = saveTree({
        id: treeId,
        workspace_id: workspaceId,
        root_node_id: requiredId(tree.rootNodeId as string, 'tree.rootNodeId'),
        name: asValue((tree.name as string) ?? null),
        archived_at: asValue((tree.archivedAt as number) ?? null),
        pinned_at: asValue((tree.pinnedAt as number) ?? null),
        last_active_at: tree.lastActiveAt as number,
        created_at: tree.createdAt as number,
      });
      const trees = allRows('SELECT * FROM trees WHERE workspace_id = ?', workspaceId);
      treeRow = trees.find((t) => t.id === treeId) ?? null;
    }

    const placement: NodePlacementLookup = {
      getTree: (id) => getRow('SELECT workspace_id FROM trees WHERE id = ?', id) as { workspace_id: string } | undefined,
      getNode: (id) => getNode(id) as { workspace_id: string; tree_id: string | null } | undefined,
    };
    assertNodePlacement(workspaceId, (node.treeId as string) ?? null, (node.parentNodeId as string) ?? null, placement);

    const existingNode = getNode(nodeId);
    if (existingNode) {
      if (
        existingNode.workspace_id !== workspaceId
        || (existingNode.tree_id ?? null) !== ((node.treeId as string) ?? null)
        || (existingNode.parent_node_id ?? null) !== ((node.parentNodeId as string) ?? null)
      ) {
        throw new DomainError('conflict', 'node_identity_mismatch', `node ${nodeId} was replayed with different graph identity`);
      }
    } else {
      saveNode({
        id: nodeId,
        workspace_id: workspaceId,
        tree_id: asValue((node.treeId as string) ?? null),
        parent_node_id: asValue((node.parentNodeId as string) ?? null),
        kind: (node.kind as string) ?? 'chat',
        title: asValue((node.title as string) ?? null),
        status: 'idle',
        minimized: 0,
        spawned_by_agent: node.spawnedByAgent ? 1 : 0,
        current_mode_id: asValue((node.currentModeId as string) ?? null),
        composer_draft: asValue((node.composerDraft as string) ?? null),
        created_at: node.createdAt as number,
      });
    }

    if (tree) {
      assertTreeRoot(workspaceId, { id: tree.id as string, workspace_id: workspaceId, root_node_id: tree.rootNodeId as string }, placement);
    }
    const ws = getRow('SELECT * FROM workspaces WHERE id = ? AND purged_at IS NULL', workspaceId);
    assertActiveTree(ws?.active_tree_id as string | null | undefined, () => allRows('SELECT id FROM trees WHERE workspace_id = ?', workspaceId));

    for (const edge of edges) {
      if (edge.targetNodeId !== nodeId) {
        throw new DomainError('conflict', 'edge_target_mismatch', 'graph prerequisite edges must target the ensured node');
      }
      assertEdgePlacement(workspaceId, edge as { kind: string; sourceNodeId: string; targetNodeId: string }, placement);
      const existingEdge = getRow(
        'SELECT workspace_id, source_node_id, target_node_id, kind FROM edges WHERE id = ?',
        asValue(edge.id),
      );
      if (existingEdge && existingEdge.workspace_id !== workspaceId) {
        throw new DomainError('conflict', 'edge_workspace_mismatch', `edge ${edge.id} belongs to a different workspace`);
      }
      if (
        existingEdge
        && (
          existingEdge.source_node_id !== edge.sourceNodeId
          || existingEdge.target_node_id !== edge.targetNodeId
          || existingEdge.kind !== edge.kind
        )
      ) {
        throw new DomainError('conflict', 'edge_identity_mismatch', `edge ${edge.id} was replayed with different graph identity`);
      }
      saveEdge({
        id: requiredId(edge.id as string, 'edge.id'),
        workspace_id: workspaceId,
        source_node_id: asValue(edge.sourceNodeId),
        target_node_id: asValue(edge.targetNodeId),
        kind: asValue(edge.kind),
        anchor_message_id: asValue((edge.anchorMessageId as string) ?? null),
        fork_boundary_message_id: edge.kind === 'branch'
          ? asValue((edge.anchorMessageId as string) ?? null) : null,
        fork_kind: null,
        created_at: asValue((edge.createdAt as number) ?? null),
      });
    }

    run('UPDATE workspaces SET persistence_version = 2 WHERE id = ?', workspaceId);
    const finalWorkspace = getRow('SELECT * FROM workspaces WHERE id = ? AND purged_at IS NULL', workspaceId);
    const finalNode = getNode(nodeId);
    if (!finalWorkspace || !finalNode) throw new Error('graph prerequisite transaction did not materialize canonical rows');
    const edgeIds = new Set(edges.map((e) => e.id));
    const allEdges = allRows('SELECT * FROM edges WHERE workspace_id = ?', workspaceId);
    return {
      workspace: finalWorkspace,
      tree: treeRow,
      node: finalNode,
      edges: allEdges.filter((e) => edgeIds.has(e.id as string)),
      // For dbWorkerClient only: it records this change and strips it from the result.
      treeChange,
    };
  });
}

// ── Resume binding ─────────────────────────────────────────────────────────

function persistResumeBinding(args: {
  nodeId: string;
  acp_session_id: string;
  runtime_id: string;
  runtime_engine?: string | null;
  provider_id: string | null;
  model_id: string | null;
  reasoning: string | null;
  resume_fingerprint: string | null;
  current_mode_id: string | null;
}): void {
  const nodeExists = getRow('SELECT id FROM nodes WHERE id = ?', args.nodeId);
  if (!nodeExists) throw new Error(`Cannot persist resume binding: node ${args.nodeId} does not exist`);
  run(`
    UPDATE nodes
       SET acp_session_id = ?,
           external_session_id = ?,
           runtime_id = ?,
           runtime_engine = ?,
           provider_id = ?,
           model_id = ?,
           reasoning = ?,
           resume_fingerprint = ?,
           current_mode_id = COALESCE(?, current_mode_id)
     WHERE id = ?
  `,
    args.acp_session_id,
    (args.runtime_id === 'codex' || args.runtime_id === 'claude') && args.acp_session_id !== args.nodeId
      ? args.acp_session_id : null,
    args.runtime_id,
    args.runtime_id === 'kiro' ? args.runtime_engine ?? 'v2' : null,
    args.provider_id,
    args.model_id,
    args.reasoning,
    args.resume_fingerprint,
    args.current_mode_id,
    args.nodeId,
  );
}

// ── Turn lifecycle — delegated to turnPersistence.core ──────────────────────

import {
  coreBeginTurn,
  coreCheckpointTurn,
  coreFinalizeTurn,
  type DbPrimitives,
  type CoreTurnRow,
} from './turnPersistence.core';

/**
 * Worker-side DbPrimitives adapter.
 *
 * Same contract as the main-thread adapter: coerce bigint → number on
 * `run().changes`, use the Worker's own `cached()` statement pool and
 * `runInTransaction()`.
 */
const workerDb: DbPrimitives = {
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return cached(sql).get(...(params as SQLInputValue[])) as T | undefined;
  },
  run(sql: string, ...params: unknown[]): { changes: number } {
    const result = cached(sql).run(...(params as SQLInputValue[]));
    return { changes: Number(result.changes) };
  },
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return cached(sql).all(...(params as SQLInputValue[])) as unknown as T[];
  },
  runNamed(sql: string, params: Record<string, unknown>): void {
    cached(sql).run(params as Record<string, SQLInputValue>);
  },
  runInTransaction,
};

function workerBeginTurn(snapshot: DurableTurnSnapshot): CoreTurnRow {
  return coreBeginTurn(workerDb, snapshot);
}

function workerCheckpointTurn(snapshot: DurableTurnSnapshot): CoreTurnRow {
  return coreCheckpointTurn(workerDb, snapshot);
}

function workerFinalizeTurn(snapshot: DurableTurnSnapshot): CoreTurnRow {
  return coreFinalizeTurn(workerDb, snapshot);
}

// ── Message dispatch ───────────────────────────────────────────────────────

parentPort.on('message', (msg: { id: number; command: string; args: unknown }) => {
  const { id, command, args } = msg;
  try {
    let result: unknown;
    switch (command) {
      case 'ensureDurableGraphNode':
        result = ensureDurableGraphNode(args as Record<string, unknown>);
        break;
      case 'persistResumeBinding':
        result = persistResumeBinding(args as Parameters<typeof persistResumeBinding>[0]);
        break;
      case 'beginTurn':
        result = workerBeginTurn(args as DurableTurnSnapshot);
        break;
      case 'checkpointTurn':
        result = workerCheckpointTurn(args as DurableTurnSnapshot);
        break;
      case 'finalizeTurn':
        result = workerFinalizeTurn(args as DurableTurnSnapshot);
        break;
      case 'ping':
        result = 'pong';
        break;
      default:
        throw new Error(`unknown worker command: ${command}`);
    }
    parentPort!.postMessage({ id, result });
  } catch (err) {
    parentPort!.postMessage({ id, error: (err as Error).message, domainError: serializeDomainError(err) });
  }
});

parentPort.postMessage({ type: 'ready' });
