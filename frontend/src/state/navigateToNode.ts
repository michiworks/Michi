import type { Project } from './chatTypes';
import { findTreeIdForNode } from './tree';

export interface NavigateToNodeDeps {
  projects: Project[];
  activeProjectId: string | null;
  selectProject: (projectId: string) => void;
  openPane: (nodeId: string) => void;
  openPaneInTree: (projectId: string, treeId: string | null, nodeId: string) => void;
  activateTree: (treeId: string, targetProjectId?: string) => void;
  setFocusedNodeId: (nodeId: string | null) => void;
}

/**
 * The thread whose slot shows `nodeId`. A node no branch edge reaches (a
 * digest) has none of its own: it goes back to `treeIdHint` (the thread it was
 * recorded in), else its first source's thread, else the workspace's shown one.
 */
function homeTreeId(nodeId: string, project: Project, treeIdHint?: string): string | null {
  const own = findTreeIdForNode(nodeId, project);
  if (own) return own;
  if (treeIdHint && project.trees.some((tree) => tree.id === treeIdHint && !tree.archivedAt)) return treeIdHint;
  for (const edge of project.edges) {
    if (edge.kind !== 'digest-source' || edge.target !== nodeId) continue;
    const sourceTreeId = findTreeIdForNode(edge.source, project);
    if (sourceTreeId) return sourceTreeId;
  }
  return project.activeTreeId;
}

/**
 * Open `nodeId`'s pane wherever it lives — switching workspace and/or thread
 * when needed — and land both the focused pane and the sidebar focus on it,
 * so the sidebar reveal effect (WorkspaceTree) expands down to its row.
 *
 * Whenever the destination differs from the current slot (different workspace
 * OR different thread), the pane is seeded via `openPaneInTree` BEFORE the
 * switch: `openPane` writes through the still-active paneKey, so calling it
 * around `selectProject`/`activateTree` (state updates that haven't committed
 * yet) drops the pane into the OLD slot, and the workspace-switch auto-open
 * effect then focuses the destination tree's root instead of the target node.
 * Same stale-slot family as the cross-tree bug fixed in CommandPalette
 * (9c13635), which left the cross-workspace → active-tree path broken.
 */
export function navigateToNode(
  deps: NavigateToNodeDeps,
  nodeId: string,
  projectId?: string,
  treeIdHint?: string,
): void {
  const project =
    (projectId ? deps.projects.find((p) => p.id === projectId) : undefined) ??
    deps.projects.find((p) => p.chatIds.includes(nodeId));
  if (!project) {
    // Unknown home (shouldn't happen for live nodes) — keep legacy behavior.
    deps.openPane(nodeId);
    return;
  }
  const treeId = homeTreeId(nodeId, project, treeIdHint);
  const crossesProject = project.id !== deps.activeProjectId;
  const crossesTree = treeId !== project.activeTreeId;
  if (crossesProject) deps.selectProject(project.id);
  if (crossesProject || crossesTree) {
    deps.openPaneInTree(project.id, treeId, nodeId);
    if (treeId) deps.activateTree(treeId, project.id);
  } else {
    deps.openPane(nodeId);
  }
  deps.setFocusedNodeId(nodeId);
}
