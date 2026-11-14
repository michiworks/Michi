/**
 * A temporary chat is a conversation whose memory setting is off
 * (nodes.memory_mode 'off', migration 0076). The user picks it when the
 * conversation starts (ensure-session's `temporary`, startTemporaryConversation);
 * it cannot change once the conversation has a message or a turn, and a branch
 * of it, or a conversation it starts, is one too (repository/nodes.ts saveNode).
 * It reads and writes no memory, and no agent reads it but its own: other
 * conversations' thread and pane tools, send_to_thread, the conversation feed,
 * Agent Runs and scheduled jobs neither list nor read it, as other sessions
 * cannot see a system workspace (globalContext.ts hiddenFrom). The user's own
 * sidebar, history and search show it as usual.
 */
import { readConversationMemoryMode } from './memoryRepository';

/** Whether a stored nodes.memory_mode makes a temporary chat. */
export function isTemporaryMemoryMode(mode: string | null | undefined): boolean {
  return mode === 'off';
}

/** The memory_mode a new node stores, from its parent's: a temporary chat's branch is one too; anything else starts as learn (NULL). */
export function inheritedMemoryMode(parentMemoryMode: string | null | undefined): 'off' | null {
  return isTemporaryMemoryMode(parentMemoryMode) ? 'off' : null;
}

/** SQL over the nodes row `alias`: not a temporary chat. */
export function notTemporaryChatSql(alias: string): string {
  return `${alias}.memory_mode IS NOT 'off'`;
}

export function isTemporaryChat(nodeId: string | null | undefined): boolean {
  return readConversationMemoryMode(nodeId) === 'off';
}

/**
 * Whether an agent in `readerNodeId` (null: in no conversation, as an Agent
 * Run or a scheduled job) is kept from `targetNodeId`: another conversation's
 * temporary chat. Lists leave it out; a read finds nothing.
 */
export function hiddenTemporaryChat(readerNodeId: string | null | undefined, targetNodeId: string): boolean {
  return targetNodeId !== readerNodeId && isTemporaryChat(targetNodeId);
}
