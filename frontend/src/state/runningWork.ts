import { useCallback, useEffect, useMemo, useRef } from 'react';
import { shallowArrayEqual, useNodesSelector } from './chatStore';
import type { ChatNodeState } from './chatTypes';
import { countActiveSubagents, hasPendingBackgroundSubagent } from './backgroundWork';
import { useBackgroundSubagentLiveness, useOpenWorkflowNodeIds, useOptionalWorkflowDomain } from './workflowDomain';

const NO_IDS: readonly string[] = [];

function sortedOrNone(ids: string[] | undefined): readonly string[] {
  return ids ? ids.sort() : NO_IDS;
}

/**
 * Conversations whose work goes on after their turn ended, which the sidebar
 * lists as running: an open workflow run, or a background subagent still
 * running (countActiveSubagents, as the pane-title badge counts it). The
 * same set until one starts or ends, so stream chunks and run progress do not
 * re-render callers.
 */
export function useRunningWorkNodeIds(): ReadonlySet<string> {
  const workflows = useOpenWorkflowNodeIds();
  const liveness = useBackgroundSubagentLiveness();
  const select = useCallback((nodes: Record<string, ChatNodeState>) => {
    let ids: string[] | undefined;
    for (const node of Object.values(nodes)) {
      if (node.kind !== 'chat' || node.deletedAt) continue;
      if (countActiveSubagents(node, liveness(node.projectId, node.nodeId)) > 0) (ids ??= []).push(node.nodeId);
    }
    return sortedOrNone(ids);
  }, [liveness]);
  const subagents = useNodesSelector(select, shallowArrayEqual);
  return useMemo(() => {
    if (subagents.length === 0) return workflows;
    const all = new Set(workflows);
    for (const id of subagents) all.add(id);
    return all;
  }, [workflows, subagents]);
}

/**
 * Keeps the workflow feed of every workspace with a background agent still
 * pending live, also once nothing shows that workspace: its liveness and its
 * agents' endings come on that feed, and without them the sidebar would list
 * an agent whose process is gone as running. Judged by the roster alone, so
 * the feed's answer cannot release the feed that gave it.
 */
export function useHoldBackgroundSubagentFeeds(): void {
  const subscribeWorkspace = useOptionalWorkflowDomain()?.subscribeWorkspace;
  const select = useCallback((nodes: Record<string, ChatNodeState>) => {
    let ids: Set<string> | undefined;
    for (const node of Object.values(nodes)) {
      if (node.kind !== 'chat' || node.deletedAt || ids?.has(node.projectId)) continue;
      if (hasPendingBackgroundSubagent(node)) (ids ??= new Set()).add(node.projectId);
    }
    return sortedOrNone(ids && [...ids]);
  }, []);
  const workspaceIds = useNodesSelector(select, shallowArrayEqual);
  // Held across changes of the list: a workspace that stays on it keeps its
  // subscription, rather than dropping its liveness and reconnecting.
  const held = useRef(new Map<string, () => void>());
  useEffect(() => {
    if (!subscribeWorkspace) return;
    const wanted = new Set(workspaceIds);
    for (const workspaceId of wanted) {
      if (!held.current.has(workspaceId)) held.current.set(workspaceId, subscribeWorkspace(workspaceId));
    }
    for (const [workspaceId, release] of held.current) {
      if (wanted.has(workspaceId)) continue;
      held.current.delete(workspaceId);
      release();
    }
  }, [subscribeWorkspace, workspaceIds]);
  useEffect(() => {
    const subscriptions = held.current;
    return () => {
      for (const release of subscriptions.values()) release();
      subscriptions.clear();
    };
  }, [subscribeWorkspace]);
}
