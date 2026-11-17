import { useSyncExternalStore } from 'react';
import type { ChatMessage, ChatNodeState } from './chatTypes';

/**
 * A send that waits before it reaches the conversation (a remote still
 * confirming, older history still loading) shows at once: its bubble and the
 * reply's placeholder, under the ids the send then adds them with, so the
 * conversation's own messages take over the same rows when it lands. Only the
 * transcript shows it; the node, its status and what is sent are unchanged.
 */
type SendPreview = readonly [user: ChatMessage, assistant: ChatMessage];

const previews = new Map<string, SendPreview>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of [...listeners]) listener();
}

export function showSendPreview(nodeId: string, preview: SendPreview): void {
  previews.set(nodeId, preview);
  changed();
}

/** Ends that send's preview: it landed in the conversation, or it was not sent. */
export function clearSendPreview(nodeId: string, assistantId: string): void {
  if (previews.get(nodeId)?.[1].id !== assistantId) return;
  previews.delete(nodeId);
  changed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSendPreview(nodeId: string): SendPreview | undefined {
  const read = () => previews.get(nodeId);
  return useSyncExternalStore(subscribe, read, read);
}

/** The node as its transcript shows it: a waiting send at the end, streaming. */
export function withSendPreview(node: ChatNodeState | undefined, preview: SendPreview | undefined): ChatNodeState | undefined {
  if (!node || !preview || node.messages.some((message) => message.id === preview[1].id)) return node;
  return { ...node, status: 'streaming', messages: [...node.messages, ...preview] };
}
