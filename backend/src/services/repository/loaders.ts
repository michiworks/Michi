// Hydration reads: whole-workspace loads, the lean meta payload and tree message pages,
// with each error node's latest turn receipt.
import { composerDraftHasPendingSpawnPrompt, LEAN_NODE_FIELD_COLUMNS } from 'michi-shared';
import { getDb, runInTransaction } from '../db';
import { getWorkspace, listWorkspaces, type WorkspaceRow } from './workspaces';
import { listTrees, type TreeRow } from './trees';
import { listNodes, type NodeRow } from './nodes';
import { listEdges, type EdgeRow } from './edges';
import type { MessageRow } from './messages';
import { LATEST_TURN_ORDER } from './turns';
import { listContexts, type ContextRow } from './contexts';

/**
 * The receipt of a node's latest turn, attached to hydration payloads for nodes
 * whose row says `error`. The frontend reads the classification from here
 * instead of guessing it from the node row: `turns.error` is written only by
 * finalization or startup recovery, never by a client snapshot, while
 * `nodes.last_applied_turn_id` is a replay watermark a client may sync back.
 * Read-only: `saveNode` never accepts these fields, and backup import rebuilds
 * node rows from an explicit column list.
 */
interface NodeTurnSummary {
  last_turn_id?: string | null;
  last_turn_status?: string | null;
  last_turn_error?: string | null;
  last_turn_completed_at?: number | null;
}

export interface FullWorkspaceData {
  workspace: WorkspaceRow;
  trees: TreeRow[];
  nodes: Array<NodeRow & NodeTurnSummary>;
  edges: EdgeRow[];
  messages: MessageRow[];
  contexts: ContextRow[];
}

/**
 * Attach each error node's latest turn receipt (see NodeTurnSummary). Other
 * nodes are returned as they are; the lookup is one query per call.
 */
function withLastTurnSummaries<T extends NodeRow>(nodes: T[]): Array<T & NodeTurnSummary> {
  const errorNodeIds = nodes.filter((node) => node.status === 'error').map((node) => node.id);
  if (errorNodeIds.length === 0) return nodes;
  const latest = latestTurns(errorNodeIds);
  return nodes.map((node) => {
    const turn = latest.get(node.id);
    return turn ? {
      ...node,
      last_turn_id: turn.turn_id,
      last_turn_status: turn.status,
      last_turn_error: turn.error,
      last_turn_completed_at: turn.completed_at,
    } : node;
  });
}

/**
 * A node's latest turn. `last_seq` is the replay cursor its stored messages
 * were written at: checkpoints and finalization write both in one transaction,
 * and unlike `nodes.last_applied_seq`, no client sync writes it.
 */
export interface LatestTurnRow {
  node_id: string;
  turn_id: string;
  status: string;
  last_seq: number;
  error: string | null;
  completed_at: number | null;
}

function latestTurns(nodeIds: string[]): Map<string, LatestTurnRow> {
  const latest = new Map<string, LatestTurnRow>();
  const CHUNK = 900;
  for (let i = 0; i < nodeIds.length; i += CHUNK) {
    const chunk = nodeIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = getDb().prepare(
      `SELECT node_id, turn_id, status, last_seq, error, completed_at FROM turns t
       WHERE node_id IN (${placeholders}) ORDER BY ${LATEST_TURN_ORDER}`,
    ).all(...chunk) as unknown as LatestTurnRow[];
    for (const row of rows) {
      if (!latest.has(row.node_id)) latest.set(row.node_id, row);
    }
  }
  return latest;
}

// --- Bulk loaders ---

export function loadFullWorkspace(id: string, userId?: string): FullWorkspaceData | null {
  const workspace = getWorkspace(id, userId);
  if (!workspace) return null;
  const trees = listTrees(id, userId);
  const nodes = listNodes(id, userId);
  const edges = listEdges(id, userId);
  const nodeIds = nodes.map(n => n.id);
  let messages: MessageRow[] = [];
  if (nodeIds.length > 0) {
    // Batch load messages for all nodes in this workspace
    const placeholders = nodeIds.map(() => '?').join(',');
    messages = getDb().prepare(
      `SELECT * FROM messages WHERE node_id IN (${placeholders}) ORDER BY seq ASC`
    ).all(...nodeIds) as unknown as MessageRow[];
  }
  const contexts = listContexts(id, userId);
  return { workspace, trees, nodes: withLastTurnSummaries(nodes), edges, messages, contexts };
}

export function loadAllWorkspaces(userId?: string): FullWorkspaceData[] {
  const workspaces = listWorkspaces(userId);
  return workspaces.map(ws => loadFullWorkspace(ws.id, userId)).filter((d): d is FullWorkspaceData => d !== null);
}

/**
 * Structure + per-node message COUNT, with NO message bodies. This is the
 * lazy-load hydration payload: the frontend loads every workspace's structural
 * graph (trees/nodes/edges/contexts) plus a `message_count` per node, then
 * fetches the actual message bodies one tree at a time via `loadTreeMessages`.
 *
 * `messages` is intentionally always `[]` here so the shape stays assignable to
 * FullWorkspaceData — the count rides on each NodeRow as `message_count`.
 */
export interface NodeRowWithCount extends NodeRow, NodeTurnSummary {
  message_count: number;
}

export interface MetaWorkspaceData extends Omit<FullWorkspaceData, 'nodes' | 'messages'> {
  nodes: NodeRowWithCount[];
  messages: never[];
}

export function loadWorkspaceMeta(id: string, userId?: string): MetaWorkspaceData | null {
  const workspace = getWorkspace(id, userId);
  if (!workspace) return null;
  const trees = listTrees(id, userId);
  const nodes = listNodes(id, userId);
  const edges = listEdges(id, userId);
  const contexts = listContexts(id, userId);

  // One grouped COUNT for the whole workspace instead of N per-node queries.
  const countByNode = new Map<string, number>();
  const nodeIds = nodes.map(n => n.id);
  if (nodeIds.length > 0) {
    const placeholders = nodeIds.map(() => '?').join(',');
    const rows = getDb().prepare(
      `SELECT node_id, COUNT(*) as cnt FROM messages WHERE node_id IN (${placeholders}) GROUP BY node_id`
    ).all(...nodeIds) as unknown as Array<{ node_id: string; cnt: number }>;
    for (const r of rows) countByNode.set(r.node_id, r.cnt);
  }

  const nodesWithCount: NodeRowWithCount[] = withLastTurnSummaries(nodes).map(n => ({
    ...n,
    message_count: countByNode.get(n.id) ?? 0,
  }));

  return { workspace, trees, nodes: nodesWithCount, edges, messages: [], contexts };
}

/**
 * Nodes a merge thread shows outside its own tree: each merge source and its
 * branch ancestors (the Map draws them with their overviews before their
 * trees' bodies load).
 */
function mergeSourceChains(edges: readonly EdgeRow[]): Set<string> {
  const parent = new Map<string, string>();
  const sources: string[] = [];
  for (const edge of edges) {
    if (edge.kind === 'merge') sources.push(edge.source_node_id);
    else if (!edge.kind || edge.kind === 'branch') parent.set(edge.target_node_id, edge.source_node_id);
  }
  const chains = new Set<string>();
  for (const source of sources) {
    for (let id: string | undefined = source; id && !chains.has(id); id = parent.get(id)) chains.add(id);
  }
  return chains;
}

/**
 * A meta row without the lean fields that hold a value (shared/leanNodeFields).
 * A tree page brings them with its bodies. Kept: a draft holding the spawn
 * outbox (auto-spawn reads it before any body loads) and the overview of a
 * node a merge thread shows from another tree.
 */
function leanMetaNodeRow(row: NodeRowWithCount, keepOverview: ReadonlySet<string>): NodeRowWithCount {
  const lean: Partial<NodeRowWithCount> = { ...row };
  if (row.branch_overview != null && !keepOverview.has(row.id)) delete lean.branch_overview;
  if (row.follow_ups != null || row.follow_ups_source_message_id != null) {
    for (const column of LEAN_NODE_FIELD_COLUMNS.follow_ups) delete lean[column as keyof NodeRowWithCount];
  }
  if (row.composer_draft != null && !composerDraftHasPendingSpawnPrompt(row.composer_draft)) delete lean.composer_draft;
  return lean as NodeRowWithCount;
}

export function loadAllWorkspacesMeta(userId?: string, options: { lean?: boolean } = {}): MetaWorkspaceData[] {
  const db = getDb();
  const isCloud = process.env.MICHI_CLOUD === '1' && userId !== undefined;

  // Batch: fetch ALL rows for every table in one query each, then group by
  // workspace_id in JS. This replaces the previous N+1 pattern (6 queries per
  // workspace) with 6 queries total, independent of workspace count.
  const workspaces = listWorkspaces(userId);
  if (workspaces.length === 0) return [];

  const wsIds = new Set(workspaces.map(w => w.id));

  let allTrees: TreeRow[];
  let allNodes: NodeRow[];
  let allEdges: EdgeRow[];
  let allContexts: ContextRow[];

  if (isCloud) {
    allTrees = db.prepare(
      'SELECT t.* FROM trees t JOIN workspaces w ON t.workspace_id = w.id WHERE w.owner_user_id = ? ORDER BY t.last_active_at DESC'
    ).all(userId) as unknown as TreeRow[];
    allNodes = db.prepare(
      'SELECT n.* FROM nodes n JOIN workspaces w ON n.workspace_id = w.id WHERE w.owner_user_id = ? AND n.purged_at IS NULL'
    ).all(userId) as unknown as NodeRow[];
    allEdges = db.prepare(
      'SELECT e.* FROM edges e JOIN workspaces w ON e.workspace_id = w.id WHERE w.owner_user_id = ?'
    ).all(userId) as unknown as EdgeRow[];
    allContexts = db.prepare(
      'SELECT c.* FROM contexts c JOIN workspaces w ON c.workspace_id = w.id WHERE w.owner_user_id = ? ORDER BY c.created_at ASC'
    ).all(userId) as unknown as ContextRow[];
  } else {
    allTrees = db.prepare('SELECT * FROM trees ORDER BY last_active_at DESC').all() as unknown as TreeRow[];
    allNodes = db.prepare('SELECT * FROM nodes WHERE purged_at IS NULL').all() as unknown as NodeRow[];
    allEdges = db.prepare('SELECT * FROM edges').all() as unknown as EdgeRow[];
    allContexts = db.prepare('SELECT * FROM contexts ORDER BY created_at ASC').all() as unknown as ContextRow[];
  }

  // Group by workspace_id
  const treesByWs = new Map<string, TreeRow[]>();
  for (const t of allTrees) {
    if (!wsIds.has(t.workspace_id)) continue;
    const arr = treesByWs.get(t.workspace_id);
    if (arr) arr.push(t); else treesByWs.set(t.workspace_id, [t]);
  }
  // Nodes are grouped below, after the error nodes receive their turn receipts.
  const edgesByWs = new Map<string, EdgeRow[]>();
  for (const e of allEdges) {
    if (!wsIds.has(e.workspace_id)) continue;
    const arr = edgesByWs.get(e.workspace_id);
    if (arr) arr.push(e); else edgesByWs.set(e.workspace_id, [e]);
  }
  const contextsByWs = new Map<string, ContextRow[]>();
  for (const c of allContexts) {
    if (!wsIds.has(c.workspace_id)) continue;
    const arr = contextsByWs.get(c.workspace_id);
    if (arr) arr.push(c); else contextsByWs.set(c.workspace_id, [c]);
  }

  // Batched message counts — single GROUP BY across ALL nodes
  const allNodeIds = allNodes.filter(n => wsIds.has(n.workspace_id)).map(n => n.id);
  const countByNode = new Map<string, number>();
  if (allNodeIds.length > 0) {
    // SQLite has a variable limit (~999 by default). Chunk if needed.
    const CHUNK = 900;
    for (let i = 0; i < allNodeIds.length; i += CHUNK) {
      const chunk = allNodeIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT node_id, COUNT(*) as cnt FROM messages WHERE node_id IN (${placeholders}) GROUP BY node_id`
      ).all(...chunk) as unknown as Array<{ node_id: string; cnt: number }>;
      for (const r of rows) countByNode.set(r.node_id, r.cnt);
    }
  }

  // One receipt lookup for every error node across all workspaces.
  const nodesByWs = new Map<string, Array<NodeRow & NodeTurnSummary>>();
  for (const n of withLastTurnSummaries(allNodes.filter(n => wsIds.has(n.workspace_id)))) {
    const arr = nodesByWs.get(n.workspace_id);
    if (arr) arr.push(n); else nodesByWs.set(n.workspace_id, [n]);
  }

  return workspaces.map(ws => {
    const nodes = nodesByWs.get(ws.id) ?? [];
    const edges = edgesByWs.get(ws.id) ?? [];
    const keepOverview = options.lean ? mergeSourceChains(edges) : null;
    const nodesWithCount: NodeRowWithCount[] = nodes.map(n => {
      const row = { ...n, message_count: countByNode.get(n.id) ?? 0 };
      return keepOverview ? leanMetaNodeRow(row, keepOverview) : row;
    });
    return {
      workspace: ws,
      trees: treesByWs.get(ws.id) ?? [],
      nodes: nodesWithCount,
      edges,
      messages: [] as never[],
      contexts: contextsByWs.get(ws.id) ?? [],
    };
  });
}

/**
 * Message bodies for every node in ONE tree, ordered by (node, seq). This is
 * the on-demand fetch behind lazy loading: the caller already has the tree's
 * structure from the meta payload and asks for its bodies when the tree is
 * activated / opened.
 *
 * Scoped to the tree via `nodes.tree_id`, so it never over-fetches sibling
 * trees. In cloud mode the workspace-owner check gates access (the route
 * applies `requireWorkspaceOwner`); the query itself is workspace-scoped.
 *
 * Each node's latest turn is read in the same transaction. A renderer that
 * installs these bodies replays a running turn from that turn's `last_seq`;
 * a cursor read at any other moment would replay output twice.
 */
export function loadTreeMessageSnapshot(workspaceId: string, treeId: string, userId?: string,
): { messages: MessageRow[]; turns: LatestTurnRow[] } {
  return runInTransaction(() => {
    const nodeIds = treeNodeIds(workspaceId, treeId, userId);
    if (nodeIds.length === 0) return { messages: [], turns: [] };
    const placeholders = nodeIds.map(() => '?').join(',');
    const messages = getDb().prepare(
      `SELECT * FROM messages WHERE node_id IN (${placeholders}) ORDER BY node_id ASC, seq ASC`
    ).all(...nodeIds) as unknown as MessageRow[];
    return { messages, turns: [...latestTurns(nodeIds).values()] };
  });
}

// Workspace + user scoped via listNodes.
function treeNodes(workspaceId: string, treeId: string, userId?: string, nodeId?: string): NodeRow[] {
  return listNodes(workspaceId, userId).filter(n => n.tree_id === treeId && (!nodeId || n.id === nodeId));
}

function treeNodeIds(workspaceId: string, treeId: string, userId?: string, nodeId?: string): string[] {
  return treeNodes(workspaceId, treeId, userId, nodeId).map(n => n.id);
}

export interface MessagePageCursor { seq: number; id: string }

/** The lean node fields (shared/leanNodeFields), as stored, read with a page's bodies. */
export type TreePageNodeFields = Pick<NodeRow, 'branch_overview' | 'follow_ups' | 'follow_ups_source_message_id' | 'composer_draft'>;

export interface TreeMessagePageEntry {
  nodeId: string;
  total: number;
  before: MessagePageCursor | null;
  /** On a node's latest page: what lean metadata may have left out. */
  node?: TreePageNodeFields;
}

/** Keyset pages of display history; never used as the runtime's full context. */
export function loadTreeMessagePage(workspaceId: string, treeId: string,
  options: { limit: number; nodeId?: string; before?: MessagePageCursor }, userId?: string,
): {
  messages: MessageRow[];
  pages: TreeMessagePageEntry[];
  turns: LatestTurnRow[];
} {
  return runInTransaction(() => readTreeMessagePage(treeNodes(workspaceId, treeId, userId, options.nodeId), options));
}

function pageNodeFields(node: NodeRow): TreePageNodeFields {
  return {
    branch_overview: node.branch_overview ?? null,
    follow_ups: node.follow_ups ?? null,
    follow_ups_source_message_id: node.follow_ups_source_message_id ?? null,
    composer_draft: node.composer_draft ?? null,
  };
}

function readTreeMessagePage(nodes: NodeRow[], options: { limit: number; before?: MessagePageCursor }) {
  const db = getDb();
  const messages: MessageRow[] = [];
  const pages: TreeMessagePageEntry[] = [];
  const count = db.prepare('SELECT COUNT(*) AS total FROM messages WHERE node_id = ?');
  const recent = db.prepare('SELECT * FROM messages WHERE node_id = ? ORDER BY seq DESC, id DESC LIMIT ?');
  const older = db.prepare('SELECT * FROM messages WHERE node_id = ? AND (seq < ? OR (seq = ? AND id < ?)) ORDER BY seq DESC, id DESC LIMIT ?');
  for (const node of nodes) {
    const nodeId = node.id;
    const cursor = options.before;
    const rows = (cursor
      ? older.all(nodeId, cursor.seq, cursor.seq, cursor.id, options.limit + 1)
      : recent.all(nodeId, options.limit + 1)) as unknown as MessageRow[];
    const hasMore = rows.length > options.limit;
    const page = rows.slice(0, options.limit).reverse();
    messages.push(...page);
    pages.push({ nodeId, total: (count.get(nodeId) as { total: number }).total,
      before: hasMore ? { seq: page[0].seq, id: page[0].id } : null,
      // Older pages follow a latest page that brought these already.
      ...(cursor ? {} : { node: pageNodeFields(node) }) });
  }
  return { messages, pages, turns: [...latestTurns(nodes.map(n => n.id)).values()] };
}
