import { isServiceTierId } from 'michi-shared';
import { getDb } from './db';
import { getNode, getWorkspace } from './dbRepository';
import { DomainError } from './domainErrors';

// A chat's speed tier (Codex: Ultrafast). Server-owned on the node like its
// Ultracode choice; the runtime reads it at every turn
// (RuntimeConfigPort.features.serviceTier) and sends it only while the chat's
// model lists the tier, standard otherwise.

function ownedChat(nodeId: string, userId?: string | null) {
  const node = getNode(nodeId);
  if (!node || node.kind !== 'chat' || node.deleted_at) return null;
  if (process.env.MICHI_CLOUD === '1' && (!userId || getWorkspace(node.workspace_id)?.owner_user_id !== userId)) return null;
  return node;
}

/** Save the tier (null: standard) for a chat of `userId`'s. */
export function writeNodeServiceTier(nodeId: string, serviceTier: string | null, userId?: string | null): void {
  if (serviceTier !== null && !isServiceTierId(serviceTier)) throw new DomainError('invalid_argument', 'service_tier_invalid', 'serviceTier must be a tier id or null');
  if (!ownedChat(nodeId, userId)) throw new DomainError('not_found', 'chat_not_found', 'Chat not found');
  getDb().prepare('UPDATE nodes SET service_tier = ? WHERE id = ?').run(serviceTier, nodeId);
}

/** The chat's tier, null for standard; undefined for unknown, deleted or another user's nodes. */
export function resolveChatServiceTier(nodeId: string, userId?: string | null): string | null | undefined {
  const node = ownedChat(nodeId, userId);
  if (!node) return undefined;
  return isServiceTierId(node.service_tier) ? node.service_tier : null;
}
