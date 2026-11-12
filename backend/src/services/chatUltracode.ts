import { getDb } from './db';
import { getNode, getWorkspace } from './dbRepository';
import { DomainError } from './domainErrors';

// A chat's Ultracode choice (Claude): standing multi-agent orchestration, where
// the agent runs a workflow for every substantive task. Server-owned on the
// node like its permission mode; the runtime reads it at every spawn and turn
// (RuntimeConfigPort.features.ultracode) and decides whether the session can
// run it at all (only ordinary chats with the Workflow tool do).

function ownedChat(nodeId: string, userId?: string | null) {
  const node = getNode(nodeId);
  if (!node || node.kind !== 'chat' || node.deleted_at) return null;
  if (process.env.MICHI_CLOUD === '1' && (!userId || getWorkspace(node.workspace_id)?.owner_user_id !== userId)) return null;
  return node;
}

/** Save the choice for an ordinary chat of `userId`'s. */
export function writeNodeUltracode(nodeId: string, enabled: boolean, userId?: string | null): void {
  if (typeof enabled !== 'boolean') throw new DomainError('invalid_argument', 'ultracode_invalid', 'enabled must be boolean');
  const node = ownedChat(nodeId, userId);
  if (!node) throw new DomainError('not_found', 'chat_not_found', 'Chat not found');
  // A Meta agent maintenance transcript never runs Ultracode.
  if (node.maintenance_job_id) throw new DomainError('invalid_argument', 'ultracode_unsupported', 'Ultracode is not available in this chat');
  getDb().prepare('UPDATE nodes SET ultracode = ? WHERE id = ?').run(enabled ? 1 : 0, nodeId);
}

/** The chat runs Ultracode. Off for unknown, deleted or another user's nodes. */
export function resolveChatUltracode(nodeId: string, userId?: string | null): boolean {
  return ownedChat(nodeId, userId)?.ultracode === 1;
}
