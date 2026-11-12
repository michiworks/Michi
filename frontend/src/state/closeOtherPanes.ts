import { useCallback } from 'react';
import { useChatActions, useChatPanes } from './chatStore';
import type { PaneItem } from './paneItems';

/**
 * What Close Others closes for `keepId`: every other pane in the tree's slot
 * except browser items, in either mode. The browser dock has its own Close
 * Others for those, and a page lost by accident cannot be reopened.
 */
function closeOthersTargets(
  keepId: string,
  { openPanes, tabPanes, paneItems = {} }: { openPanes: string[]; tabPanes?: string[]; paneItems?: Record<string, PaneItem> },
): string[] {
  // Single-page mode shows one page of the slot; its tabs are the rest.
  return (tabPanes ?? openPanes).filter((id) => id !== keepId && paneItems[id]?.kind !== 'browser');
}

/** Close Others for a pane caption, tab, phone title or switcher row, and when it applies. */
export function useCloseOtherPanes(): { closeOtherPanes: (keepId: string) => void; canCloseOtherPanes: (keepId: string) => boolean } {
  const panes = useChatPanes();
  const { closePane, focusPane, setPaneWidth } = useChatActions();
  const closeOtherPanes = useCallback((keepId: string) => {
    for (const id of closeOthersTargets(keepId, panes)) closePane(id);
    focusPane(keepId);
    // A lone pane with no width of its own fills the window.
    setPaneWidth(keepId, undefined);
  }, [panes, closePane, focusPane, setPaneWidth]);
  const canCloseOtherPanes = useCallback((keepId: string) => closeOthersTargets(keepId, panes).length > 0, [panes]);
  return { closeOtherPanes, canCloseOtherPanes };
}
