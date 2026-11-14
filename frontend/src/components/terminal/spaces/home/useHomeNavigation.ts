import React from 'react';
import type { SpaceActivityItem } from 'michi-shared';
import { openSpacesPage } from '../../../../state/metaChat/spacesPages';
import { useSpacesSourceNav } from './homeLinks';

/** A Michi conversation a home row names, and the message to show when the row is about one. */
export interface HomeThreadTarget {
  nodeId: string;
  /** The conversation's workspace when the row knows it; null asks the backend where it is now (moved, or gone). */
  workspaceId: string | null;
  messageId?: string | null;
  /** Continue puts the cursor in the conversation's composer. */
  focus?: boolean;
}

/**
 * Where the home pages' rows lead: a conversation opens in the conversation
 * area with a way back to Spaces, and a page change opens its page (a home as
 * its home view) with the block flashed. `currentPageId` is the page on
 * screen, which flashes in place instead of reopening.
 */
export function useHomeNavigation(backendConnectionId: string, currentPageId: string | null) {
  const sourceNav = useSpacesSourceNav();

  const openThread = React.useCallback((thread: HomeThreadTarget) => sourceNav.openConversationFromSpaces({
    backendConnectionId, workspaceId: thread.workspaceId, nodeId: thread.nodeId, messageId: thread.messageId ?? null, focus: thread.focus === true,
  }), [backendConnectionId, sourceNav]);

  // A Spaces Home row names no workspace: the page says where it lives.
  const openPage = React.useCallback((pageId: string, workspaceId: string | null, blockId: string | null) => {
    void openSpacesPage({
      pageId, backendConnectionId, currentPageId,
      ...(workspaceId ? { workspaceId } : {}),
      ...(blockId ? { blockId } : {}),
    });
  }, [backendConnectionId, currentPageId]);

  const openActivity = React.useCallback((item: SpaceActivityItem) => {
    if (item.kind === 'conversation') void openThread({ nodeId: item.threadNodeId, workspaceId: item.workspaceId });
    else openPage(item.pageId, item.workspaceId, null);
  }, [openPage, openThread]);

  return { openThread, openPage, openActivity };
}
