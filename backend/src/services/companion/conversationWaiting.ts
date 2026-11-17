import { CHAT_STREAM_EVENTS, type ChatStreamEvent } from 'michi-shared';
import { currentAssistantNodeId } from '../../assistant/store';
import { log } from '../logger';
import { companionEvents, type CompanionEventBus } from './delivery';
import { resolveMichiWaitingItem } from './sources/michi';

/** The part of chatHub this reads: its window-scoped feed, foreground turns included (chatHub.subscribeBackground). */
export interface ConversationWaitingHub {
  subscribeBackground(subscriber: {
    send(chatId: string, event: ChatStreamEvent, selfInitiated?: boolean): void;
    includeForeground?: boolean;
    close(): void;
  }): () => void;
}

export interface ConversationWaitingDeps {
  hub: ConversationWaitingHub;
  /** V, the agent's conversation (default currentAssistantNodeId). */
  conversationNodeId?: () => string | null;
  bus?: CompanionEventBus;
  /** Clears a stored Today wait only when the current conversation no longer waits. */
  resolveWaitingItem?: (nodeId: string) => boolean;
}

/** V's turns watched at once; the oldest goes first past it (a turn whose end this never saw). */
const MAX_TURNS = 100;

/**
 * The tray's "<name> is waiting for you" (GET /companion/tray reads it from
 * chatHub): V asking for an approval or an answer, or no longer, is a
 * `companion_changed` (`conversation`), after which the tray fetches its menu
 * again. Every conversation's answered request or turn transition also
 * clears its stale Today item, without waiting for two source polls.
 * Notifying the request is the attention service's. Returns the unsubscribe.
 */
export function watchConversationWaiting(deps: ConversationWaitingDeps): () => void {
  const bus = deps.bus ?? companionEvents;
  const conversationNodeId = deps.conversationNodeId ?? currentAssistantNodeId;
  const resolveWaitingItem = deps.resolveWaitingItem ?? resolveMichiWaitingItem;
  /** V's turns that waited on the user, by turn (or node, for frames that name none). */
  const waited = new Set<string>();
  const isV = (nodeId: string): boolean => {
    try {
      return nodeId === conversationNodeId();
    } catch {
      return false;
    }
  };
  const changed = () => bus.emitChanged('conversation');
  return deps.hub.subscribeBackground({
    includeForeground: true,
    send: (chatId, event) => {
      try {
        const nodeId = event.data.nodeId ?? chatId;
        const key = event.data.turnId ?? nodeId;
        switch (event.event) {
          case CHAT_STREAM_EVENTS.turnStart:
          case CHAT_STREAM_EVENTS.permissionResolved:
          case CHAT_STREAM_EVENTS.userInputResolved:
          case CHAT_STREAM_EVENTS.done:
          case CHAT_STREAM_EVENTS.error:
            if (resolveWaitingItem(nodeId)) bus.emitChanged('items');
        }
        switch (event.event) {
          case CHAT_STREAM_EVENTS.permissionRequest:
          case CHAT_STREAM_EVENTS.userInputRequest:
            if (!isV(nodeId)) return;
            waited.add(key);
            if (waited.size > MAX_TURNS) waited.delete(waited.values().next().value as string);
            changed();
            return;
          case CHAT_STREAM_EVENTS.permissionResolved:
          case CHAT_STREAM_EVENTS.userInputResolved:
            if (waited.has(key)) changed();
            return;
          case CHAT_STREAM_EVENTS.done:
          case CHAT_STREAM_EVENTS.error:
            if (waited.delete(key)) changed();
            return;
          default:
            return;
        }
      } catch (error) {
        // Companion updates must never break a turn's feed.
        log.warn('chat', 'conversation waiting signal failed', { err: error instanceof Error ? error.message : String(error) });
      }
    },
    close: () => {},
  });
}
