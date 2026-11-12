import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTreeMessagePage, fetchWorkspaceStructure } from '../services/api/persistence';
import { useChatActions, useChatNode, useChatNodeReader, useChatProjects } from './chatStore';
import { installTreeMessagePage } from './treeMessageInstall';
import { findTreeIdForNode } from './tree';
import { serverEntityId } from '../config/backendIdentity';
import { LOCAL_BACKEND_CONNECTION_ID } from '../config/backendConnections';

export interface EmbeddedChatNodeDescriptor {
  backendConnectionId: string;
  workspaceId: string;
  treeId: string;
  nodeId: string;
}

export type EmbeddedChatNodeState = 'loading' | 'ready' | 'failed';

const EMBEDDED_PAGE_LIMIT = 200;
// Reads of a node whose messages or cursors moved while it was read.
const EMBEDDED_PAGE_READS = 2;

/** Loads an ordinary workspace node into the authoritative store for an embedded chat surface. */
export function useEmbeddedChatNode(descriptor: EmbeddedChatNodeDescriptor | null): {
  state: EmbeddedChatNodeState;
  retry: () => void;
  refreshWorkspace: (expectedNodeId?: string) => Promise<boolean>;
} {
  const { installWorkspaceSnapshot, dispatch } = useChatActions();
  const node = useChatNode(descriptor?.nodeId ?? '');
  const readNode = useChatNodeReader();
  const nodeRef = useRef(node);
  nodeRef.current = node;
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const projects = useChatProjects().projects;
  const present = !!node && node.projectId === descriptor?.workspaceId;
  const placeholder = present && node?.messagesLoaded === false && !node.historyBefore;
  const project = descriptor ? projects.find((item) => item.id === descriptor.workspaceId) : undefined;
  const treeId = descriptor?.treeId || (descriptor && project ? findTreeIdForNode(descriptor.nodeId, project) : null);

  const refreshWorkspace = useCallback(async (expectedNodeId = descriptor?.nodeId): Promise<boolean> => {
    if (!descriptor) return false;
    if (!expectedNodeId) return false;
    const readStartedAt = Date.now();
    // Structure only: the node's body loads as a placeholder's below.
    const raw = await fetchWorkspaceStructure(descriptor.workspaceId);
    const installed = installWorkspaceSnapshot(raw, readStartedAt);
    const rows = (raw as { nodes?: Array<{ id?: unknown }> } | null)?.nodes;
    const current = nodeRef.current;
    return installed && current?.nodeId === expectedNodeId && current.projectId === descriptor.workspaceId
      || Array.isArray(rows) && rows.some((row) => row?.id === serverEntityId(expectedNodeId, descriptor.backendConnectionId));
  }, [descriptor, installWorkspaceSnapshot]);

  useEffect(() => {
    if (!descriptor || present) return undefined;
    const controller = new AbortController();
    void fetchWorkspaceStructure(descriptor.workspaceId, controller.signal)
      .then((raw) => {
        if (controller.signal.aborted) return;
        const installed = installWorkspaceSnapshot(raw, Date.now());
        const rows = (raw as { nodes?: Array<{ id?: unknown }> } | null)?.nodes;
        if (!installed || nodeRef.current?.projectId !== descriptor.workspaceId) {
          if (!Array.isArray(rows) || !rows.some((row) => row?.id === serverEntityId(descriptor.nodeId, descriptor.backendConnectionId))) setFailed(true);
        }
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [descriptor, present, attempt, installWorkspaceSnapshot]);

  useEffect(() => {
    if (!descriptor || !present || !placeholder || !treeId) return undefined;
    const controller = new AbortController();
    const { nodeId } = descriptor;
    void (async () => {
      for (let read = 0; read < EMBEDDED_PAGE_READS; read++) {
        const start = readNode(nodeId);
        if (!start || start.messagesLoaded !== false) return;
        // This node's latest page, with the turn row read alongside its bodies;
        // older history pages in on scroll like any thread's.
        const page = await fetchTreeMessagePage(descriptor.workspaceId, treeId,
          descriptor.backendConnectionId === LOCAL_BACKEND_CONNECTION_ID ? undefined : descriptor.backendConnectionId,
          controller.signal, { nodeId, limit: EMBEDDED_PAGE_LIMIT });
        if (controller.signal.aborted) return;
        if (page.pages && !page.pages.some((item) => item.nodeId === nodeId)) throw new Error('The conversation is no longer in this thread');
        // As a tree read installs a page: not over moved messages or cursors,
        // and never as an empty conversation for one that has messages.
        const current = readNode(nodeId);
        const result = installTreeMessagePage({ nodesRef: { current: current ? { [nodeId]: current } : {} }, dispatch },
          page, [nodeId], new Map([[nodeId, start]]));
        if (result.missing.length > 0) throw new Error('The conversation came back without its messages');
        if (result.changed.length === 0) return;
      }
    })().catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [descriptor, present, placeholder, treeId, attempt, dispatch, readNode]);

  const retry = useCallback(() => {
    setFailed(false);
    setAttempt((count) => count + 1);
  }, []);

  if (failed) return { state: 'failed', retry, refreshWorkspace };
  return { state: present && !placeholder ? 'ready' : 'loading', retry, refreshWorkspace };
}
