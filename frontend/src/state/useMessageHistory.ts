import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { fetchTreeMessagePage, type TreeMessagePage, type TreeMessagePageEntry } from '../services/api/persistence';
import { buildMessagesByNode } from './chatHydration';
import { installTreeMessagePage } from './treeMessageInstall';
import { findTreeIdForNode } from './tree';
import type { ChatAction, ChatNodeState, Project } from './chatTypes';
import { backendConnectionGeneration } from '../config/backendConnectionState';
import { projectConnectionId } from '../config/backendConnections';

export interface MessageHistoryActions {
  loadOlderMessages(nodeId: string): Promise<void>;
  ensureCompleteHistory(nodeIds: readonly string[]): Promise<Record<string, ChatNodeState>>;
}

// The server's page cap: completing a long history takes the fewest reads.
const HISTORY_PAGE_LIMIT = 200;
// Reads of a placeholder whose messages or cursors moved while it was read.
const PLACEHOLDER_READ_ATTEMPTS = 2;

/** Provider-scoped reads only: no durable browser mirror and no write retries. */
export function useMessageHistory(nodesRef: MutableRefObject<Record<string, ChatNodeState>>,
  projectsRef: MutableRefObject<Project[]>, dispatch: (action: ChatAction) => void,
  reconnectStreamingRef?: MutableRefObject<(nodeId: string) => void>,
): MessageHistoryActions {
  const reads = useRef(new Map<string, { controller: AbortController; promise: Promise<void> }>());
  useEffect(() => () => { for (const read of reads.current.values()) read.controller.abort(); reads.current.clear(); }, []);
  const read = useCallback((key: string, work: (signal: AbortSignal) => Promise<void>) => {
    const previous = reads.current.get(key);
    if (previous) return previous.promise;
    const controller = new AbortController();
    const entry = { controller, promise: Promise.resolve() };
    reads.current.set(key, entry);
    entry.promise = work(controller.signal).finally(() => {
      if (reads.current.get(key) === entry) reads.current.delete(key);
    });
    return entry.promise;
  }, []);

  const loadOlderMessages = useCallback(async (nodeId: string) => {
    const node = nodesRef.current[nodeId];
    const project = projectsRef.current.find(item => item.id === node?.projectId);
    const treeId = project && findTreeIdForNode(nodeId, project);
    const before = node?.historyBefore;
    if (!node || !before || !project || !treeId) return;
    const connectionId = projectConnectionId(project);
    const generation = backendConnectionGeneration(connectionId);
    await read(JSON.stringify(['older', nodeId, before, generation]), async signal => {
      const result = await fetchTreeMessagePage(project.id, treeId, project.backendConnectionId, signal, { nodeId, before });
      if (signal.aborted) return;
      if (generation !== backendConnectionGeneration(connectionId)) throw new DOMException('Remote connection changed', 'AbortError');
      const page = result.pages?.find(item => item.nodeId === nodeId);
      if (result.pages && !page) throw new Error('The remote conversation is no longer available');
      const messages = buildMessagesByNode(result.messages)[nodeId] ?? [];
      dispatch({ type: 'history-page-loaded', nodeId, expectedBefore: before,
        before: page?.before ?? null, total: page?.total ?? messages.length, messages });
    });
  }, [dispatch, nodesRef, projectsRef, read]);

  const ensureCompleteHistory = useCallback(async (nodeIds: readonly string[]) => {
    // One node at a time, one bounded page at a time: completing a context
    // node never reads its thread's other nodes, and opening many sources on a
    // high-latency link must not flood the shared forward or starve the active
    // turn's event stream.
    for (const id of new Set(nodeIds)) {
      const node = nodesRef.current[id];
      if (!node || node.messagesLoaded !== false) continue;
      const project = projectsRef.current.find(item => item.id === node.projectId);
      const treeId = project && findTreeIdForNode(id, project);
      if (!project || !treeId) continue;
      const connectionId = projectConnectionId(project);
      const generation = backendConnectionGeneration(connectionId);
      await read(JSON.stringify(['full', project.id, id, generation]), async signal => {
        for (let attempt = 0; attempt < PLACEHOLDER_READ_ATTEMPTS; attempt++) {
          const beforeNode = nodesRef.current[id];
          if (!beforeNode || beforeNode.messagesLoaded !== false) return;
          // A partial page is completed below its oldest loaded message; a
          // placeholder from its latest page down.
          const cursor = beforeNode.historyBefore;
          const pages: unknown[][] = [];
          let before = cursor;
          // The latest page's: its bounds (with lean node fields), and the turn row read with its bodies.
          let latest: Pick<TreeMessagePage, 'turns'> & { total?: number; bounds?: TreeMessagePageEntry } | undefined;
          do {
            const result = await fetchTreeMessagePage(project.id, treeId, project.backendConnectionId, signal,
              { nodeId: id, limit: HISTORY_PAGE_LIMIT, ...(before ? { before } : {}) });
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            if (generation !== backendConnectionGeneration(connectionId)) throw new DOMException('Remote connection changed', 'AbortError');
            const rows = result.messages.filter(raw => (raw as { node_id?: unknown } | null)?.node_id === id);
            if (!result.pages) {
              // A gateway without pages answers with every body of the thread at once.
              pages.unshift(cursor ? rows.filter(raw => {
                const row = raw as { seq: number; id: string };
                return row.seq < cursor.seq || (row.seq === cursor.seq && row.id < cursor.id);
              }) : rows);
              latest ??= { total: cursor ? undefined : rows.length };
              break;
            }
            const bounds = result.pages.find(item => item.nodeId === id);
            // No longer in that thread: leave it unloaded, which reports below.
            if (!bounds) return;
            latest ??= { total: bounds.total, turns: result.turns, bounds };
            pages.unshift(rows);
            const next = bounds.before ?? undefined;
            if (next && before && !(next.seq < before.seq || (next.seq === before.seq && next.id < before.id))) {
              throw new Error('Message history paging did not advance');
            }
            before = next;
          } while (before);
          const current = nodesRef.current[id];
          if (!current || current.messagesLoaded !== false) return;
          if (cursor) {
            if (current.historyBefore?.id === cursor.id && current.historyBefore.seq === cursor.seq) {
              const messages = buildMessagesByNode(pages.flat())[id] ?? [];
              dispatch({ type: 'history-page-loaded', nodeId: id, expectedBefore: cursor, before: null,
                messages, total: latest?.total ?? current.messages.length + messages.length });
            }
            return;
          }
          // The whole history as one page, installed as a tree read is: the
          // turn row sets the node's turn state, the lean node fields fill
          // what lean metadata deferred. A change beside the messages (a
          // title, a status) still installs; a moved message or cursor reads
          // again.
          const page: TreeMessagePage = {
            messages: pages.flat(),
            ...(latest?.bounds ? { pages: [{ ...latest.bounds, before: null }] } : {}),
            ...(latest?.turns ? { turns: latest.turns } : {}),
          };
          const installed = installTreeMessagePage({ nodesRef, dispatch, reconnectStreamingRef }, page, [id], new Map([[id, beforeNode]]));
          if (installed.changed.length === 0) return;
        }
      });
    }
    if (nodeIds.some(id => nodesRef.current[id]?.messagesLoaded === false)) {
      throw new Error('Conversation changed while loading history. Please try again.');
    }
    return nodesRef.current;
  }, [dispatch, nodesRef, projectsRef, read, reconnectStreamingRef]);
  return { loadOlderMessages, ensureCompleteHistory };
}
