import type { ChatNodeState } from './chatTypes';

type CountedNode = Pick<ChatNodeState, 'messages' | 'messagesLoaded' | 'messageCount' | 'historyBefore' | 'olderMessageCount'>;

/** Messages before the loaded page that only the server holds. */
export function unloadedOlderMessageCount(node: CountedNode): number {
  if (!node.historyBefore) return 0;
  return node.olderMessageCount ?? Math.max(0, (node.messageCount ?? 0) - node.messages.length);
}

/** The node's message count, whether or not its messages are loaded. */
export function nodeMessageCount(node: CountedNode): number {
  if (node.messagesLoaded === true) return node.messages.length;
  if (node.historyBefore) return unloadedOlderMessageCount(node) + node.messages.length;
  return Math.max(node.messageCount ?? 0, node.messages.length);
}
