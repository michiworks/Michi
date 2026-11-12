import { parseSessionState, type AgentSessionState } from 'michi-shared';
import { executeChatCommand } from '../services/api/sessions';
import { compactChat } from '../services/api';
import type { PendingQueuedMessage } from './chatTypes';
import { resolveSlashRun, type SlashEntry } from './slashEntries';

export interface ChatCommand { name: string; value?: string }

/** Preserve command and skill boundaries when draining a queue; ordinary
 * adjacent messages still combine exactly as before. A skill's message runs
 * alone: a message merged before it would bury its command, one after it
 * would become its arguments. */
export function nextQueuedBatch(queue: readonly PendingQueuedMessage[], slashEntries: readonly SlashEntry[]): PendingQueuedMessage[] {
  const runsAlone = (entry: PendingQueuedMessage) => !!resolveSlashRun(entry.value, slashEntries, entry.slash?.entry);
  if (!queue.length) return [];
  if (runsAlone(queue[0])) return [queue[0]];
  const next = queue.findIndex(runsAlone);
  return queue.slice(0, next < 0 ? queue.length : next);
}

export async function executeComposerCommand(nodeId: string, command: ChatCommand): Promise<{
  success: boolean; message: string; sessionState?: AgentSessionState;
}> {
  if (command.name === 'compact') {
    const result = await compactChat(nodeId, command.value);
    return { success: result.started, message: result.detail ?? (result.started ? 'Compaction completed.' : 'Compaction is unavailable.') };
  }
  const result = await executeChatCommand(nodeId, command.name, command.value ? { value: command.value } : undefined);
  const data = result.data === undefined ? '' : typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
  return { success: result.success, message: [result.message, data].filter(Boolean).join('\n') || (result.success ? `/${command.name} completed.` : `/${command.name} is unavailable.`),
    sessionState: result.sessionState ? parseSessionState({ ...result.sessionState }) : undefined,
  };
}
