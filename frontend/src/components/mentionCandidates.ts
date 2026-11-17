import { useCallback, useContext, useRef } from 'react';
import { ChatNodeStoreContext } from '../state/chatStore';
import type { ChatNodeState, Project } from '../state/chatTypes';
import { findTreeIdForNode } from '../state/tree';
import { backendConnectionIdForWorkspace, LOCAL_BACKEND_CONNECTION_ID } from '../config/backendConnections';
import { collectCrossTreeGroups, CROSS_TREE_MENTION_CAP } from './crossTreeMentions';
import { NO_MENTION_CANDIDATES, type CrossTreeGroup, type MentionCandidates } from './mentionItems';

/** The chat nodes of `nodeId`'s thread, in the workspace's order. */
function sameThreadNodes(nodes: Record<string, ChatNodeState>, project: Project, nodeId: string): ChatNodeState[] {
  const treeId = findTreeIdForNode(nodeId, project);
  if (!treeId) return [];
  return project.chatIds.flatMap((id) => {
    const node = nodes[id];
    return node && !node.deletedAt && node.kind === 'chat' && findTreeIdForNode(id, project) === treeId ? [node] : [];
  });
}

/**
 * The threads of every live local user workspace, each titled with its
 * workspace, CROSS_TREE_MENTION_CAP in all: what the <name> assistant mentions.
 */
function localWorkspaceGroups(nodes: Record<string, ChatNodeState>, projects: readonly Project[]): CrossTreeGroup[] {
  let count = 0;
  return projects
    .filter((project) => !project.system && !project.deletedAt && !project.archivedAt
      && backendConnectionIdForWorkspace(project.id) === LOCAL_BACKEND_CONNECTION_ID)
    .flatMap((project) => collectCrossTreeGroups(nodes, project, null).map((group) => ({ ...group, treeTitle: `${project.name} · ${group.treeTitle}` })))
    .flatMap((group) => {
      const groupNodes = group.nodes.slice(0, Math.max(0, CROSS_TREE_MENTION_CAP - count));
      count += groupNodes.length;
      return groupNodes.length ? [{ ...group, nodes: groupNodes }] : [];
    });
}

/**
 * A thread pane's: the nodes of its own thread, then the workspace's other
 * threads (collectCrossTreeGroups). The assistant's pane (`assistant`) lists
 * every local user workspace's threads instead of its own workspace's.
 */
export function paneMentionCandidates(nodes: Record<string, ChatNodeState>, { nodeId, project, projects, assistant }: {
  nodeId: string;
  project: Project | null | undefined;
  projects: readonly Project[];
  assistant: boolean;
}): MentionCandidates {
  const treeId = project ? findTreeIdForNode(nodeId, project) : null;
  return {
    sameTree: project ? sameThreadNodes(nodes, project, nodeId) : [],
    crossTree: assistant ? localWorkspaceGroups(nodes, projects)
      : project && treeId ? collectCrossTreeGroups(nodes, project, treeId) : [],
  };
}

/**
 * The @ menu's conversations as a getter: `build` (which may close over this
 * render's props) runs on the store's nodes as they are when the menu asks.
 * Built in a structural selector instead, they cost every open composer up
 * to ~150 ms on each structure change of a large workspace (11-09 audit
 * P0-11), for a menu that is rarely open. Outside a chat provider there are
 * no nodes to list.
 */
export function useMentionCandidates(build: (nodes: Record<string, ChatNodeState>) => MentionCandidates): () => MentionCandidates {
  const store = useContext(ChatNodeStoreContext);
  const buildRef = useRef(build);
  buildRef.current = build;
  return useCallback(() => (store ? buildRef.current(store.getNodes()) : NO_MENTION_CANDIDATES), [store]);
}
