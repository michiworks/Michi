import type { Project, ProjectEdge } from '../../../state/chatTypes';
import { isListedThread, isVisibleConversationNode } from '../../../state/conversationVisibility';
import { isBranchEdge } from '../../../state/tree';

type MapNodeVisibilityState = {
  deletedAt?: number;
  kind?: 'chat' | 'digest';
  pageId?: string | null;
  mergeSources?: string[];
};

type MapProject = Pick<Project, 'chatIds' | 'trees' | 'edges' | 'activeTreeId'>;

/** Branch and merge edges shape the Map; link and digest-source edges only
 *  decorate it. */
export function isMapGraphEdge(edge: Pick<ProjectEdge, 'kind'>): boolean {
  return edge.kind === undefined || edge.kind === 'branch' || edge.kind === 'merge';
}

/**
 * The active thread's Map nodes in breadth-first walk order from the tree
 * root and, for a merge thread, from its sources and their ancestors. Both
 * layouts take these ids in this order; ELK considers model order.
 */
export function mapGraphNodeIds(
  project: MapProject | null | undefined,
  nodes: Record<string, MapNodeVisibilityState | undefined>,
): string[] {
  if (!project?.activeTreeId) return [];
  const activeTree = project.trees.find((tree) => tree.id === project.activeTreeId);
  const rootNode = activeTree ? nodes[activeTree.rootNodeId] : undefined;
  if (!activeTree || !rootNode || !isListedThread(activeTree, rootNode)) return [];

  const children = new Map<string, string[]>();
  const branchParent = new Map<string, string>();
  for (const edge of project.edges) {
    if (!isMapGraphEdge(edge)) continue;
    const next = children.get(edge.source) ?? [];
    next.push(edge.target);
    children.set(edge.source, next);
    // Track branch parents so we can walk UP from merge sources to tree roots.
    if (isBranchEdge(edge)) {
      branchParent.set(edge.target, edge.source);
    }
  }

  // Seed the BFS with the tree root. For merge trees, also seed with the
  // merge sources and their entire ancestor chains (walk up branch edges to
  // each source's tree root) so the map shows the full context that was merged.
  const seedSet = new Set<string>([activeTree.rootNodeId]);
  if (activeTree.kind === 'merge' && rootNode.mergeSources) {
    for (const srcId of rootNode.mergeSources) {
      // Walk up from each merge source to its tree root via branch edges.
      let cur: string | undefined = srcId;
      while (cur && !seedSet.has(cur)) {
        seedSet.add(cur);
        cur = branchParent.get(cur);
      }
    }
  }

  const reachable = new Set<string>();
  const queue = [...seedSet];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    const node = nodes[id];
    if (!node || node.deletedAt || !isVisibleConversationNode(node) || node.kind === 'digest') continue;
    reachable.add(id);
    for (const childId of children.get(id) ?? []) queue.push(childId);
  }

  const inProject = new Set(project.chatIds);
  return [...reachable].filter((id) => inProject.has(id));
}

/** The same nodes as mapGraphNodeIds, in the workspace's chat order. */
export function visibleMapNodeIds(
  project: MapProject | null | undefined,
  nodes: Record<string, MapNodeVisibilityState | undefined>,
): string[] {
  const shown = new Set(mapGraphNodeIds(project, nodes));
  return project ? project.chatIds.filter((id) => shown.has(id)) : [];
}
