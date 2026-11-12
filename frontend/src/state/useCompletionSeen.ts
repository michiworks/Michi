import { useEffect, useRef } from 'react';
import type { ChatAction, ChatNodeState } from './chatTypes';
import { isWindowAttentive } from './completionFacts';

/**
 * Records the focused node's completions as seen while this window is focused
 * and visible (Herdr's rule): when focus moves to the node, when the window
 * comes back to the front, and when a completion lands while the user is
 * looking. The seen count then rides on the node's view mark to the backend
 * (workspacePersistence.ts), which resolves the node's notifications.
 * Nothing happens for a node without server completion facts, or with
 * nothing new to see.
 */
export function useFocusedNodeSeen(
  focusedNodeId: string | null,
  completionSeq: number | undefined,
  seenCompletionSeq: number | undefined,
  dispatch: (action: ChatAction) => void,
  attentive: () => boolean = isWindowAttentive,
): void {
  const unseenRef = useRef(false);
  unseenRef.current = completionSeq !== undefined && completionSeq > (seenCompletionSeq ?? 0);
  const attentiveRef = useRef(attentive);
  attentiveRef.current = attentive;
  useEffect(() => {
    if (focusedNodeId === null) return;
    const mark = () => {
      if (!unseenRef.current || !attentiveRef.current()) return;
      dispatch({ type: 'node-viewed', nodeId: focusedNodeId, viewedAt: Date.now(), seen: true });
    };
    mark();
    window.addEventListener('focus', mark);
    document.addEventListener('visibilitychange', mark);
    return () => {
      window.removeEventListener('focus', mark);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [focusedNodeId, completionSeq, dispatch]);
}

/**
 * The same rule for conversations a surface other than a pane shows: the ⌘J
 * panel open on Chat (companionPanel's useCompanionPanelShownNodeIds).
 * Presence does not report those surfaces, so without this the server would
 * keep their notifications, and their unread marks, until the conversation
 * was opened in a pane.
 */
export function useShownNodesSeen(
  nodeIds: readonly string[],
  nodes: Readonly<Record<string, ChatNodeState>>,
  dispatch: (action: ChatAction) => void,
  attentive: () => boolean = isWindowAttentive,
): void {
  const unseenRef = useRef<string[]>([]);
  unseenRef.current = nodeIds.filter((nodeId) => {
    const node = nodes[nodeId];
    return node?.completionSeq !== undefined && node.completionSeq > (node.seenCompletionSeq ?? 0);
  });
  const attentiveRef = useRef(attentive);
  attentiveRef.current = attentive;
  // Runs again when what is shown changes, or a completion lands on it.
  const key = nodeIds.map((nodeId) => `${nodeId}\u0000${nodes[nodeId]?.completionSeq ?? ''}`).join('\u0001');
  useEffect(() => {
    if (!key) return undefined;
    const mark = () => {
      if (!unseenRef.current.length || !attentiveRef.current()) return;
      const viewedAt = Date.now();
      for (const nodeId of unseenRef.current) dispatch({ type: 'node-viewed', nodeId, viewedAt, seen: true });
    };
    mark();
    window.addEventListener('focus', mark);
    document.addEventListener('visibilitychange', mark);
    return () => {
      window.removeEventListener('focus', mark);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [key, dispatch]);
}
