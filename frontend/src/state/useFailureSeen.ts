import { useEffect, useRef } from 'react';
import type { ChatAction, ChatNodeState } from './chatTypes';
import { isWindowAttentive } from './completionFacts';
import { isPaneSeenInWindow, watchPaneStrip } from './attention/targetVisibility';
import { useDashboardUncovered } from './panePresenceVisibility';

/** A failure the user has not viewed the node since: what the sidebar marks Failed. */
function failedAtUnseen(node: ChatNodeState | undefined): number | undefined {
  if (node?.status !== 'error' || node.errorCompletedAt === undefined) return undefined;
  return node.errorCompletedAt > (node.viewedAt ?? 0) ? node.errorCompletedAt : undefined;
}

/**
 * Records a failed conversation as viewed while a pane of `openPanes` (the
 * active tree's layout, usePaneState) shows it and this window is in front,
 * so the sidebar's Failed mark (nodeAttention, sidebarSelectors.ts) clears as
 * it does on focus, and stays cleared: the view rides to the backend as
 * viewed_at (workspacePersistence.ts). Shown is isPaneSeenInWindow: nothing
 * lies over the Dashboard (a dialog or other modal; on a phone, the Michi
 * panel or the drawer) and the strip has laid out at least 60% of the pane. A pane beside
 * the focused one counts; one scrolled out of the strip, not laid out yet,
 * covered, on a background tab, or a conversation the ⌘J panel shows does not.
 *
 * It looks when a failure lands or the layout changes, again once the strip
 * has settled (watchPaneStrip), after the strip scrolls or resizes, when the
 * cover lifts and when the window comes to the front. Only viewedAt moves:
 * completions stay unseen, so unread still needs focus (useCompletionSeen.ts).
 * The mark is at least the failure's time, which is the backend's clock, so a
 * gateway running ahead of this window cannot keep the mark on a failure the
 * user has on screen.
 */
export function useShownFailuresSeen(
  openPanes: readonly string[],
  nodes: Readonly<Record<string, ChatNodeState>>,
  dispatch: (action: ChatAction) => void,
  attentive: () => boolean = isWindowAttentive,
  shown: (paneId: string, openPanes: readonly string[]) => boolean = isPaneSeenInWindow,
): void {
  const failures = openPanes.flatMap((nodeId) => {
    const failedAt = failedAtUnseen(nodes[nodeId]);
    return failedAt === undefined ? [] : [{ nodeId, failedAt }];
  });
  const failuresRef = useRef(failures);
  failuresRef.current = failures;
  const openPanesRef = useRef(openPanes);
  openPanesRef.current = openPanes;
  const attentiveRef = useRef(attentive);
  attentiveRef.current = attentive;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const uncovered = useDashboardUncovered();
  // Runs again when a failure lands or is viewed, or the layout changes while one is unviewed.
  const key = failures.length === 0 ? '' : [
    failures.map(({ nodeId, failedAt }) => `${nodeId}\u0000${failedAt}`).join('\u0001'),
    openPanes.join('\u0001'),
  ].join('\u0002');
  useEffect(() => {
    if (!key) return undefined;
    // A failure is viewed once: the ref empties only on the next render, and
    // a focus can follow a visibilitychange before it.
    const viewed = new Set<string>();
    const mark = () => {
      if (!failuresRef.current.length || !attentiveRef.current()) return;
      const panes = openPanesRef.current;
      const now = Date.now();
      for (const { nodeId, failedAt } of failuresRef.current) {
        const failure = `${nodeId}\u0000${failedAt}`;
        if (viewed.has(failure) || !shownRef.current(nodeId, panes)) continue;
        viewed.add(failure);
        dispatch({ type: 'node-viewed', nodeId, viewedAt: Math.max(now, failedAt) });
      }
    };
    mark();
    const stopWatching = watchPaneStrip(mark);
    window.addEventListener('focus', mark);
    document.addEventListener('visibilitychange', mark);
    return () => {
      stopWatching();
      window.removeEventListener('focus', mark);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [key, uncovered, dispatch]);
}
