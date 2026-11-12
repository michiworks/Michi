import { getDb } from '../db';

// --- Ownership helpers (used by ownership middleware) ---

/** Returns the workspace_id for a node/chat id, or null if not found.
 *  Single SQL hit — no caching. Used by requireChatOwner / requireNodeOwner. */
export function getNodeWorkspaceId(nodeId: string): string | null {
  const row = getDb()
    .prepare('SELECT workspace_id FROM nodes WHERE id = ?')
    .get(nodeId) as { workspace_id: string } | undefined;
  return row?.workspace_id ?? null;
}

export interface NodeSessionBinding {
  nodeId: string;
  workspaceId: string;
}

/**
 * Resolve a Michi node/workspace binding from either a node id or a runtime
 * session id. Prefer the node id path, then fall back to persisted ACP /
 * external session ids for older callers that only have the runtime id.
 */
export function getNodeSessionBinding(identifier: string, userId?: string | null): NodeSessionBinding | null {
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  if (process.env.MICHI_CLOUD === '1' && !userId) return null;

  const lookup = (column: 'id' | 'acp_session_id' | 'external_session_id'): NodeSessionBinding | null => {
    let sql = `SELECT n.id, n.workspace_id FROM nodes n`;
    const params: string[] = [trimmed];
    if (process.env.MICHI_CLOUD === '1' && userId) {
      sql += ' JOIN workspaces w ON w.id = n.workspace_id';
    }
    sql += ` WHERE n.${column} = ? AND n.purged_at IS NULL`;
    if (process.env.MICHI_CLOUD === '1' && userId) {
      sql += ' AND w.owner_user_id = ?';
      params.push(userId);
    }
    const row = getDb().prepare(sql).get(...params) as { id: string; workspace_id: string } | undefined;
    return row ? { nodeId: row.id, workspaceId: row.workspace_id } : null;
  };

  return lookup('id') ?? lookup('acp_session_id') ?? lookup('external_session_id');
}
