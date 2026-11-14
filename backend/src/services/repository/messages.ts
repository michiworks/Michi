import { getDb } from '../db';
import { MESSAGE_SQL } from '../turnPersistence.recipes';
import { isNodeTombstoned } from './tombstones';

export interface MessageRow {
  id: string;
  node_id: string;
  role: string;
  content: string;
  blocks?: string | null;
  tool_calls?: string | null;
  metadata?: string | null;
  seq: number;
  created_at: number;
  /** Per-row sync version (sync L2, migration 0006). NULL = predates versioning
   *  / no claim. Stamped by leaf save* via COALESCE; guard reads it in L2.2. */
  rev?: number | null;
}

// --- Message CRUD ---

export function listMessages(nodeId: string, userId?: string): MessageRow[] {
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    return getDb().prepare(
      'SELECT m.* FROM messages m JOIN nodes n ON m.node_id = n.id JOIN workspaces w ON n.workspace_id = w.id WHERE m.node_id = ? AND w.owner_user_id = ? ORDER BY m.seq ASC'
    ).all(nodeId, userId) as unknown as MessageRow[];
  }
  return getDb().prepare('SELECT * FROM messages WHERE node_id = ? ORDER BY seq ASC').all(nodeId) as unknown as MessageRow[];
}

export function saveMessage(msg: MessageRow, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    const owned = getDb().prepare(
      'SELECT 1 FROM nodes n JOIN workspaces w ON n.workspace_id = w.id WHERE n.id = ? AND w.owner_user_id = ?'
    ).get(msg.node_id, userId);
    if (!owned) return;
  }
  // Tombstone guard — messages can't outlive their owning node.
  if (isNodeTombstoned(msg.node_id)) return;
  getDb().prepare(MESSAGE_SQL.upsert)
    .run({ blocks: null, tool_calls: null, metadata: null, rev: null, ...msg });
}

export function getMessageCount(nodeId: string, userId?: string): number {
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    const row = getDb().prepare(
      'SELECT COUNT(*) as cnt FROM messages m JOIN nodes n ON m.node_id = n.id JOIN workspaces w ON n.workspace_id = w.id WHERE m.node_id = ? AND w.owner_user_id = ?'
    ).get(nodeId, userId) as unknown as { cnt: number };
    return row.cnt;
  }
  const row = getDb().prepare('SELECT COUNT(*) as cnt FROM messages WHERE node_id = ?').get(nodeId) as unknown as { cnt: number };
  return row.cnt;
}

/**
 * Owner/workspace-scoped message counts for a node, broken out by role.
 *
 * A single `GROUP BY role` round trip rather than three separate `COUNT(*)`
 * queries — total/user/assistant are reported together in one Pane
 * Inspection descriptor section and must never be able to drift relative to
 * each other from two queries racing a concurrent write between them.
 *
 * Empty assistant placeholder rows (inserted by `coreBeginTurn` at turn
 * start, before any streamed content exists) are ordinary `messages` rows
 * and are counted like any other — this function does not special-case
 * `content = ''`.
 *
 * `total` is a true `COUNT(*)` over all rows for the node, not `user +
 * assistant` — the `role` column has no CHECK constraint, so an unexpected
 * role value can never make the three numbers inconsistent with each other.
 */
export function getMessageCountsByNode(
  nodeId: string,
  userId?: string,
): { total: number; user: number; assistant: number } {
  return messageCountsForNodes([nodeId], userId).get(nodeId) ?? { total: 0, user: 0, assistant: 0 };
}

type MessageCounts = { total: number; user: number; assistant: number };

/** getMessageCountsByNode for up to 900 nodes at once; a node without messages is absent. */
function messageCountsForNodes(nodeIds: readonly string[], userId?: string): Map<string, MessageCounts> {
  const placeholders = nodeIds.map(() => '?').join(',');
  const rows = (
    process.env.MICHI_CLOUD === '1' && userId !== undefined
      ? getDb().prepare(
          `SELECT m.node_id as node_id, m.role as role, COUNT(*) as cnt
           FROM messages m JOIN nodes n ON m.node_id = n.id JOIN workspaces w ON n.workspace_id = w.id
           WHERE m.node_id IN (${placeholders}) AND w.owner_user_id = ?
           GROUP BY m.node_id, m.role`
        ).all(...nodeIds, userId)
      : getDb().prepare(
          `SELECT node_id, role, COUNT(*) as cnt FROM messages WHERE node_id IN (${placeholders}) GROUP BY node_id, role`
        ).all(...nodeIds)
  ) as unknown as Array<{ node_id: string; role: string; cnt: number }>;
  const counts = new Map<string, MessageCounts>();
  for (const row of rows) {
    const existing = counts.get(row.node_id) ?? { total: 0, user: 0, assistant: 0 };
    existing.total += row.cnt;
    if (row.role === 'user') existing.user = row.cnt;
    else if (row.role === 'assistant') existing.assistant = row.cnt;
    counts.set(row.node_id, existing);
  }
  return counts;
}

/**
 * Coverage signal for `getCompletedTurnCount` — whether durable turn history
 * covers the node's assistant messages. `'partial'` means at least one assistant
 * message has no matching durable turn, including mixed legacy/new history.
 * A genuinely empty node has complete coverage and a known count of zero.
 */
export type TurnHistoryCoverage = 'complete' | 'partial';

/**
 * Owner/workspace-scoped count of durable turn rows with `status =
 * 'completed'` for a node. `cancelled`/`error`/`active` turns do not count.
 * Self-turns (`turns.user_message_id IS NULL` — see `beginSelfTurn` in
 * `chatHub.ts`, which omits `userMessage` from the snapshot passed to
 * `coreBeginTurn`) count the same as ordinary turns; this function does not
 * filter on `user_message_id` at all.
 *
 * Returns `null` for `count` — with `coverage: 'partial'` — when the node
 * has an assistant message not tracked by `turns`. Starting new turns does not
 * fill gaps in legacy history; completed counts cannot be inferred from messages.
 */
export function getCompletedTurnCount(
  nodeId: string,
  userId?: string,
): { count: number | null; coverage: TurnHistoryCoverage } {
  return completedTurnsForNodes([nodeId], userId).get(nodeId)!;
}

type CompletedTurns = { count: number | null; coverage: TurnHistoryCoverage };

/** getCompletedTurnCount for up to 900 nodes at once, with an entry for every id. */
function completedTurnsForNodes(nodeIds: readonly string[], userId?: string): Map<string, CompletedTurns> {
  const cloudScoped = process.env.MICHI_CLOUD === '1' && userId !== undefined;
  const placeholders = nodeIds.map(() => '?').join(',');
  // A new durable turn does not make older, untracked assistant messages complete.
  const untracked = 'NOT EXISTS (SELECT 1 FROM turns t WHERE t.node_id = m.node_id AND t.assistant_message_id = m.id)';
  const untrackedRows = (
    cloudScoped
      ? getDb().prepare(
          `SELECT m.node_id as node_id, COUNT(*) as cnt FROM messages m
           JOIN nodes n ON m.node_id = n.id JOIN workspaces w ON n.workspace_id = w.id
           WHERE m.node_id IN (${placeholders}) AND m.role = 'assistant' AND w.owner_user_id = ? AND ${untracked}
           GROUP BY m.node_id`
        ).all(...nodeIds, userId)
      : getDb().prepare(
          `SELECT m.node_id as node_id, COUNT(*) as cnt FROM messages m
           WHERE m.node_id IN (${placeholders}) AND m.role = 'assistant' AND ${untracked} GROUP BY m.node_id`
        ).all(...nodeIds)
  ) as unknown as Array<{ node_id: string; cnt: number }>;
  const completedRows = (
    cloudScoped
      ? getDb().prepare(
          `SELECT t.node_id as node_id, COUNT(*) as cnt FROM turns t
           JOIN nodes n ON t.node_id = n.id JOIN workspaces w ON n.workspace_id = w.id
           WHERE t.node_id IN (${placeholders}) AND t.status = 'completed' AND w.owner_user_id = ? GROUP BY t.node_id`
        ).all(...nodeIds, userId)
      : getDb().prepare(
          `SELECT node_id, COUNT(*) as cnt FROM turns WHERE node_id IN (${placeholders}) AND status = 'completed' GROUP BY node_id`
        ).all(...nodeIds)
  ) as unknown as Array<{ node_id: string; cnt: number }>;
  const untrackedNodes = new Set(untrackedRows.filter((row) => row.cnt > 0).map((row) => row.node_id));
  const completed = new Map(completedRows.map((row) => [row.node_id, row.cnt]));
  return new Map(nodeIds.map((nodeId): [string, CompletedTurns] => [nodeId, untrackedNodes.has(nodeId)
    ? { count: null, coverage: 'partial' }
    : { count: completed.get(nodeId) ?? 0, coverage: 'complete' }]));
}
