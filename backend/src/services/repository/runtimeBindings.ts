// Native session ids on node rows. updateNodeResumeBinding is still in ../dbRepository.ts;
// its header says why.
import { getDb } from '../db';

export function setNodeExternalSessionId(nodeId: string, externalSessionId: string): void {
  const result = getDb().prepare('UPDATE nodes SET external_session_id = ?, acp_session_id = ? WHERE id = ?')
         .run(externalSessionId, externalSessionId, nodeId);
  if (!result.changes) throw new Error(`Cannot bind native session: node ${nodeId} does not exist`);
}

/**
 * Test seam: read a node's native session id directly.
 * @testonly
 */
export function getNodeExternalSessionId(nodeId: string): string | null {
  const row = getDb().prepare('SELECT external_session_id FROM nodes WHERE id = ?')
                     .get(nodeId) as { external_session_id: string | null } | undefined;
  return row?.external_session_id ?? null;
}
