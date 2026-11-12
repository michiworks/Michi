import type { MutableRefObject } from 'react';
import type { TreeMessagePage } from '../services/api';
import { buildMessagesByNode } from './chatHydration';
import type { ChatAction, ChatNodeState } from './chatTypes';
import { noteMessagesInstalled, noteMessagesNotInstalled } from './messageLoadDiagnostics';
import { sameTreeMessageAnchor } from './treeMessageRequests';

export interface TreeMessageInstallTarget {
  nodesRef: MutableRefObject<Record<string, ChatNodeState>>;
  dispatch: (action: ChatAction) => void;
  reconnectStreamingRef?: MutableRefObject<(nodeId: string) => void>;
}

/**
 * Install one read's bodies for `nodeIds` with `messages-loaded`, as the read
 * found them (`startNodes`). Returns which nodes were installed, which changed
 * while it was in flight (`changed`: read again), and which the response does
 * not account for (`missing`).
 *
 * - A node whose messages or replay cursors changed since the read started,
 *   or that gained content as a live turn, keeps its state: a stale snapshot
 *   never replaces it. Other fields (status, title) may change meanwhile; a
 *   count that grew past what the read found is read again (`changed`).
 * - A node with history (messageCount > 0) never becomes an empty thread
 *   unless the server reports its total as 0. A read of the wrong thread, or
 *   one that leaves the node out, answers without it.
 * - A streaming node whose checkpoint was just installed reattaches its live
 *   stream. dispatch updates nodesRef synchronously, so status is fresh.
 */
export function installTreeMessagePage(
  { nodesRef, dispatch, reconnectStreamingRef }: TreeMessageInstallTarget,
  page: TreeMessagePage,
  nodeIds: readonly string[],
  startNodes: ReadonlyMap<string, ChatNodeState>,
): { installed: string[]; changed: string[]; missing: string[] } {
  const loaded = buildMessagesByNode(page.messages);
  const byNode: typeof loaded = {};
  const changed: string[] = [];
  const missing: string[] = [];
  for (const nid of nodeIds) {
    const current = nodesRef.current[nid];
    const start = startNodes.get(nid);
    const total = page.pages?.find((item) => item.nodeId === nid)?.total;
    if (
      !sameTreeMessageAnchor(start, current)
      || current?.messagesLoaded !== false
      // A node that gained content while the fetch was in flight became a
      // live turn. A still-empty streaming node is a reconnect target; keep it.
      || (current.status === 'streaming' && current.messages.length > 0)
      // Its count grew while the read was on its way, past what the read found.
      || (total !== undefined && (current.messageCount ?? 0) > (start?.messageCount ?? 0)
        && (current.messageCount ?? 0) > total)
    ) {
      changed.push(nid);
      continue;
    }
    const rows = loaded[nid] ?? [];
    if (rows.length === 0 && (current.messageCount ?? 0) > 0 && total !== 0) {
      missing.push(nid);
      continue;
    }
    byNode[nid] = rows;
  }
  const installed = Object.keys(byNode);
  if (installed.length > 0) {
    dispatch({ type: 'messages-loaded', nodeIds: installed, messagesByNode: byNode,
      ...(page.pages ? { pages: page.pages.filter((item) => installed.includes(item.nodeId)) } : {}),
      ...(page.turns ? { turns: page.turns } : {}) });
    noteMessagesInstalled(installed);
    if (reconnectStreamingRef) {
      for (const nid of installed) {
        if (nodesRef.current[nid]?.status === 'streaming') reconnectStreamingRef.current(nid);
      }
    }
  }
  if (changed.length) noteMessagesNotInstalled(changed, 'changed');
  if (missing.length) noteMessagesNotInstalled(missing, 'not_in_response');
  return { installed, changed, missing };
}
