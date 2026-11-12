// A check-in's throwaway node S as W2-G1a's createCheckinNode makes it
// (DESIGN-v2 §3.1 step 2): `n-cmph-<runId>` in the assistant workspace, its
// own tree, its purpose meta 'companion'. Written with plain SQL, so the
// assistant layer's tests do not depend on the engine's run rows.
import { checkinNodeId } from 'michi-shared';
import { assistantPurposeKey } from '../../src/assistant/identity';
import { getDb } from '../../src/services/db';

export function makeCheckinNode(workspaceId: string, runId = 'run-1', opts: { meta?: boolean } = {}): string {
  const nodeId = checkinNodeId(runId);
  const db = getDb();
  if (opts.meta !== false) db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(assistantPurposeKey(nodeId), 'companion');
  db.prepare('INSERT INTO trees (id, workspace_id, root_node_id, name, last_active_at, created_at) VALUES (?, ?, ?, NULL, 1, 1)')
    .run(`t-cmph-${runId}`, workspaceId, nodeId);
  db.prepare("INSERT INTO nodes (id, workspace_id, tree_id, kind, status, created_at) VALUES (?, ?, ?, 'chat', 'idle', 1)")
    .run(nodeId, workspaceId, `t-cmph-${runId}`);
  return nodeId;
}

/** The durable row chatHub writes for a running turn. */
export function activeTurnRow(nodeId: string, turnId: string, assistantId: string): void {
  getDb().prepare(`INSERT INTO turns (turn_id, node_id, user_message_id, assistant_message_id, status, started_at, updated_at)
    VALUES (?, ?, NULL, ?, 'active', 1, 1)`).run(turnId, nodeId, assistantId);
}
