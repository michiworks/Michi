import type { ChatNodeState, Project } from '../../../../state/chatTypes';
import { chatLabel } from '../../../../state/chatStore';
import { isArchiveGroupId } from '../../../../state/trashActions';
import { descendants } from '../../../../state/tree';
import { threadDisplayTitle } from '../../../../state/displayTitle';
import { nodeMessageCount } from '../../../../state/nodeMessageCount';

/**
 * One archived thing, as Settings › Archived lists it. Two mechanisms look
 * the same to the user: a whole thread (`tree.archivedAt`) and one node
 * trimmed out of its thread (a deletion group prefixed `arch-`, restorable
 * from its trimSnapshot). `kind` routes unarchive and Move to Trash.
 */
export type ArchiveEntry = {
  key: string;
  project: Project;
  archivedAt: number;
  title: string;
  root: ChatNodeState | undefined;
  nodeCount: number;
  messageCount: number;
} & (
  | { kind: 'tree'; treeId: string }
  | { kind: 'node'; groupId: string; /** The thread the node was archived from, when it still exists. */ fromTitle: string | null }
);

/** The thread a node sits in, by walking up to its tree's root. */
function threadTitle(project: Project, nodes: Record<string, ChatNodeState>, nodeId: string | null): string | null {
  const seen = new Set<string>();
  let current = nodeId ? nodes[nodeId] : undefined;
  while (current?.parentNodeId && nodes[current.parentNodeId] && !seen.has(current.nodeId)) {
    seen.add(current.nodeId);
    current = nodes[current.parentNodeId];
  }
  if (!current) return null;
  const tree = project.trees.find(item => item.rootNodeId === current!.nodeId);
  return tree?.name || current.title || chatLabel(current) || null;
}

export function buildArchiveEntries(projects: readonly Project[], nodes: Record<string, ChatNodeState>): ArchiveEntry[] {
  const byProject = new Map(projects.map(project => [project.id, project]));
  const entries: ArchiveEntry[] = [];

  const groups = new Map<string, ChatNodeState[]>();
  for (const node of Object.values(nodes)) {
    if (!isArchiveGroupId(node.deletionGroupId)) continue;
    const members = groups.get(node.deletionGroupId!) ?? [];
    members.push(node);
    groups.set(node.deletionGroupId!, members);
  }
  for (const [groupId, members] of groups) {
    const ids = new Set(members.map(node => node.nodeId));
    const root = members.find(node => !node.parentNodeId || !ids.has(node.parentNodeId)) ?? members[0];
    const project = byProject.get(root.projectId);
    if (!project) continue;
    const snapshot = root.trimSnapshot;
    // A former root's thread lives on under the child it promoted.
    const fromNodeId = snapshot?.wasTreeRoot
      ? project.trees.find(tree => tree.id === snapshot.wasTreeRoot!.treeId)?.rootNodeId ?? null
      : snapshot?.parentId ?? null;
    const fromTitle = threadTitle(project, nodes, fromNodeId);
    entries.push({
      key: `node:${groupId}`, kind: 'node', groupId, project, root, fromTitle,
      archivedAt: Math.max(...members.map(node => node.deletedAt ?? 0)),
      title: root.title || chatLabel(root) || 'Untitled node',
      nodeCount: members.length,
      messageCount: members.reduce((sum, node) => sum + nodeMessageCount(node), 0),
    });
  }

  for (const project of projects) {
    const liveEdges = project.edges.filter(edge => !nodes[edge.source]?.deletedAt && !nodes[edge.target]?.deletedAt);
    for (const tree of project.trees) {
      const root = nodes[tree.rootNodeId];
      // A thread moved to Trash stays archived underneath; Trash lists it now.
      if (!tree.archivedAt || !root || root.deletedAt) continue;
      const members = [tree.rootNodeId, ...descendants(tree.rootNodeId, liveEdges)].map(id => nodes[id]).filter((node): node is ChatNodeState => !!node && !node.deletedAt);
      entries.push({
        key: `tree:${tree.id}`, kind: 'tree', treeId: tree.id, project, root,
        archivedAt: tree.archivedAt,
        title: threadDisplayTitle(tree, root, 'Untitled thread'),
        nodeCount: members.length,
        messageCount: members.reduce((sum, node) => sum + nodeMessageCount(node), 0),
      });
    }
  }
  return entries;
}

export type ArchiveSort = 'newest' | 'oldest' | 'name';

/** Matching entries in their workspaces, the workspace archived into most recently first (or by name). */
export function groupArchiveEntries(entries: readonly ArchiveEntry[], { query, workspaceId, sort }: { query: string; workspaceId: string | null; sort: ArchiveSort }) {
  const needle = query.trim().toLocaleLowerCase();
  const order = (a: ArchiveEntry, b: ArchiveEntry) => sort === 'name' ? a.title.localeCompare(b.title) : sort === 'oldest' ? a.archivedAt - b.archivedAt : b.archivedAt - a.archivedAt;
  const matching = entries
    .filter(entry => !workspaceId || entry.project.id === workspaceId)
    .filter(entry => !needle || entry.title.toLocaleLowerCase().includes(needle) || entry.project.name.toLocaleLowerCase().includes(needle))
    .sort(order);
  const groups = new Map<string, { project: Project; entries: ArchiveEntry[] }>();
  for (const entry of matching) {
    const group = groups.get(entry.project.id) ?? { project: entry.project, entries: [] };
    group.entries.push(entry);
    groups.set(entry.project.id, group);
  }
  return { matching, groups: [...groups.values()] };
}
