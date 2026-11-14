import { useCallback, useRef, type MutableRefObject } from 'react';
import type { ChatNodeState, Project } from './chatTypes';
import { paneItemTitle, type PaneItem } from './paneItems';
import { threadTitle } from './spaceConversations/liveStatus';
import { recordUndo, recordUndoGroup } from './undoStack';

/** The store's actions as they act, each saying whether it did. */
export interface RawUndoableActions {
  archiveTree: (treeId: string) => boolean;
  unarchiveTree: (treeId: string) => boolean;
  deleteTree: (treeId: string) => string | null;
  restoreDeletion: (groupId: string) => string | null;
  moveTreeToWorkspace: (treeId: string, targetProjectId: string) => Promise<boolean>;
  renameNode: (nodeId: string, title: string) => void;
  renameTree: (treeId: string, name: string, targetProjectId?: string) => void;
  pinTree: (treeId: string) => void;
  unpinTree: (treeId: string) => void;
  pinNode: (nodeId: string) => void;
  unpinNode: (nodeId: string) => void;
  pinProject: (projectId: string) => void;
  unpinProject: (projectId: string) => void;
  deleteNode: (nodeId: string) => string | null;
  trimNode: (nodeId: string) => string | null;
  archiveNode: (nodeId: string) => string | null;
  renameProject: (projectId: string, name: string) => void;
  archiveProject: (projectId: string) => void;
  unarchiveProject: (projectId: string) => void;
  deleteProject: (projectId: string) => void;
  restoreProject: (projectId: string) => void;
  closePane: (paneId: string) => void;
  restorePaneInSlot: (slot: { projectId: string; treeId: string | null }, paneId: string, index: number, focused: boolean) => void;
  registerPaneItem: (item: PaneItem) => void;
  revealNode: (nodeId: string) => boolean;
  selectProject: (projectId: string) => void;
  activateTree: (treeId: string, targetProjectId?: string) => void;
  clearTreeSelection: () => void;
}

export interface UndoableActionState {
  projectsRef: MutableRefObject<Project[]>;
  nodesRef: MutableRefObject<Record<string, ChatNodeState>>;
  activeProjectIdRef: MutableRefObject<string | null>;
  paneItemsRef: MutableRefObject<Record<string, PaneItem>>;
  /** Every pane of the active slot (not only those shown) and its focused one, as this render sees them. */
  slotPanes: readonly string[] | undefined;
  focusedPane: string | null;
  treeSelection: ReadonlySet<string>;
}

/** Pane kinds whose closing ends something that cannot come back: a shell, a web page. */
const SURFACE_PANES = new Set<PaneItem['kind']>(['terminal', 'browser']);

const NO_PANES: readonly string[] = [];

const quoted = (title: string) => `“${title}”`;

/**
 * The store's user actions, each recording how to undo it on the window's
 * undo history (state/undoStack.ts) once it has acted. The raw actions stay
 * unrecorded for the store's own use; an undo calls the newest of them, so
 * it acts on the state as it is then.
 */
export function useUndoableActions(raw: RawUndoableActions, state: UndoableActionState) {
  const latest = useRef(raw);
  latest.current = raw;
  const { projectsRef, nodesRef, activeProjectIdRef, paneItemsRef, slotPanes = NO_PANES, focusedPane, treeSelection } = state;

  const findTree = useCallback((treeId: string) => {
    for (const project of projectsRef.current) {
      const tree = project.trees.find((t) => t.id === treeId);
      if (tree) return { project, tree };
    }
    return null;
  }, [projectsRef]);
  const treeTitle = useCallback((rootNodeId: string) => threadTitle(nodesRef.current[rootNodeId]), [nodesRef]);
  const workspaceName = useCallback((projectId: string) => projectsRef.current.find((p) => p.id === projectId)?.name || 'workspace', [projectsRef]);
  /** Whether the thread is the one on screen, so undoing what took it away shows it again. */
  const isShown = useCallback((projectId: string, treeId: string) => (
    activeProjectIdRef.current === projectId && projectsRef.current.find((p) => p.id === projectId)?.activeTreeId === treeId
  ), [activeProjectIdRef, projectsRef]);

  /** Undo of a Trash or Archived move: the group put back, and shown again when it was on screen. */
  const restoreGroup = useCallback((groupId: string, reveal: boolean) => () => {
    const root = latest.current.restoreDeletion(groupId);
    if (!root) return false;
    if (reveal) latest.current.revealNode(root);
    return true;
  }, []);

  const archiveTree = useCallback((treeId: string): boolean => {
    const found = findTree(treeId);
    const shown = found ? isShown(found.project.id, treeId) : false;
    if (!latest.current.archiveTree(treeId) || !found) return false;
    const rootNodeId = found.tree.rootNodeId;
    recordUndo({
      label: `Archived ${quoted(treeTitle(rootNodeId))}`,
      toast: true,
      undo: () => {
        if (!latest.current.unarchiveTree(treeId)) return false;
        if (shown) latest.current.revealNode(rootNodeId);
        return true;
      },
    });
    return true;
  }, [findTree, isShown, treeTitle]);

  const unarchiveTree = useCallback((treeId: string): boolean => {
    const found = findTree(treeId);
    if (!latest.current.unarchiveTree(treeId) || !found) return false;
    recordUndo({ label: `Unarchived ${quoted(treeTitle(found.tree.rootNodeId))}`, undo: () => latest.current.archiveTree(treeId) });
    return true;
  }, [findTree, treeTitle]);

  const deleteTree = useCallback((treeId: string): string | null => {
    const found = findTree(treeId);
    const shown = found ? isShown(found.project.id, treeId) : false;
    const groupId = latest.current.deleteTree(treeId);
    if (groupId && found) recordUndo({ label: `Moved ${quoted(treeTitle(found.tree.rootNodeId))} to Trash`, toast: true, undo: restoreGroup(groupId, shown) });
    return groupId;
  }, [findTree, isShown, restoreGroup, treeTitle]);

  const moveTreeToWorkspace = useCallback(async (treeId: string, targetProjectId: string): Promise<void> => {
    const found = findTree(treeId);
    if (!await latest.current.moveTreeToWorkspace(treeId, targetProjectId) || !found) return;
    const sourceId = found.project.id;
    recordUndo({
      label: `Moved ${quoted(treeTitle(found.tree.rootNodeId))} to ${workspaceName(targetProjectId)}`,
      toast: true,
      undo: () => latest.current.moveTreeToWorkspace(treeId, sourceId),
    });
  }, [findTree, treeTitle, workspaceName]);

  const renameNode = useCallback((nodeId: string, title: string) => {
    const before = nodesRef.current[nodeId]?.title?.trim();
    const after = title.trim();
    latest.current.renameNode(nodeId, title);
    // Untitled has no name to go back to: the reducer keeps a title once it has one.
    if (!before || !after || before === after) return;
    recordUndo({
      label: `Renamed ${quoted(before)} to ${quoted(after)}`,
      undo: () => {
        if (!nodesRef.current[nodeId] || nodesRef.current[nodeId].deletedAt) return false;
        latest.current.renameNode(nodeId, before);
        return true;
      },
    });
  }, [nodesRef]);

  const renameTree = useCallback((treeId: string, name: string, targetProjectId?: string) => {
    const projectId = targetProjectId ?? activeProjectIdRef.current;
    const tree = projectsRef.current.find((p) => p.id === projectId)?.trees.find((t) => t.id === treeId);
    if (tree) renameNode(tree.rootNodeId, name);
  }, [activeProjectIdRef, projectsRef, renameNode]);

  const pinTree = useCallback((treeId: string) => {
    const found = findTree(treeId);
    latest.current.pinTree(treeId);
    if (found) recordUndo({ label: `Pinned ${quoted(treeTitle(found.tree.rootNodeId))}`, undo: () => latest.current.unpinTree(treeId) });
  }, [findTree, treeTitle]);
  const unpinTree = useCallback((treeId: string) => {
    const found = findTree(treeId);
    const pinnedAt = found?.tree.pinnedAt;
    latest.current.unpinTree(treeId);
    if (found && pinnedAt) recordUndo({ label: `Unpinned ${quoted(treeTitle(found.tree.rootNodeId))}`, undo: () => latest.current.pinTree(treeId) });
  }, [findTree, treeTitle]);
  const pinNode = useCallback((nodeId: string) => {
    latest.current.pinNode(nodeId);
    recordUndo({ label: `Pinned ${quoted(threadTitle(nodesRef.current[nodeId]))}`, undo: () => latest.current.unpinNode(nodeId) });
  }, [nodesRef]);
  const unpinNode = useCallback((nodeId: string) => {
    const pinned = !!nodesRef.current[nodeId]?.pinnedAt;
    latest.current.unpinNode(nodeId);
    if (pinned) recordUndo({ label: `Unpinned ${quoted(threadTitle(nodesRef.current[nodeId]))}`, undo: () => latest.current.pinNode(nodeId) });
  }, [nodesRef]);
  const pinProject = useCallback((projectId: string) => {
    latest.current.pinProject(projectId);
    recordUndo({ label: `Pinned ${quoted(workspaceName(projectId))}`, undo: () => latest.current.unpinProject(projectId) });
  }, [workspaceName]);
  const unpinProject = useCallback((projectId: string) => {
    const pinned = !!projectsRef.current.find((p) => p.id === projectId)?.pinnedAt;
    latest.current.unpinProject(projectId);
    if (pinned) recordUndo({ label: `Unpinned ${quoted(workspaceName(projectId))}`, undo: () => latest.current.pinProject(projectId) });
  }, [projectsRef, workspaceName]);

  /** A branch moved to Trash or Archived, put back (and shown again when it was open) by its group. */
  const pruneRecorded = useCallback((nodeId: string, act: (id: string) => string | null, verb: (title: string) => string) => {
    const wasOpen = slotPanes.includes(nodeId);
    const title = threadTitle(nodesRef.current[nodeId]);
    const groupId = act(nodeId);
    if (groupId) recordUndo({ label: verb(quoted(title)), toast: true, undo: restoreGroup(groupId, wasOpen) });
    return groupId;
  }, [nodesRef, restoreGroup, slotPanes]);
  const deleteNode = useCallback((nodeId: string) => pruneRecorded(nodeId, (id) => latest.current.deleteNode(id), (t) => `Moved ${t} to Trash`), [pruneRecorded]);
  const trimNode = useCallback((nodeId: string) => pruneRecorded(nodeId, (id) => latest.current.trimNode(id), (t) => `Moved ${t} to Trash`), [pruneRecorded]);
  const archiveNode = useCallback((nodeId: string) => pruneRecorded(nodeId, (id) => latest.current.archiveNode(id), (t) => `Archived ${t}`), [pruneRecorded]);

  const renameProject = useCallback((projectId: string, name: string) => {
    const before = projectsRef.current.find((p) => p.id === projectId)?.name;
    latest.current.renameProject(projectId, name);
    if (before === undefined || before === name) return;
    recordUndo({ label: `Renamed workspace ${quoted(before)} to ${quoted(name)}`, undo: () => latest.current.renameProject(projectId, before) });
  }, [projectsRef]);
  const archiveProject = useCallback((projectId: string) => {
    const name = workspaceName(projectId);
    const wasActive = activeProjectIdRef.current === projectId;
    latest.current.archiveProject(projectId);
    recordUndo({
      label: `Archived ${quoted(name)}`,
      toast: true,
      undo: () => {
        latest.current.unarchiveProject(projectId);
        if (wasActive) latest.current.selectProject(projectId);
      },
    });
  }, [activeProjectIdRef, workspaceName]);
  const unarchiveProject = useCallback((projectId: string) => {
    latest.current.unarchiveProject(projectId);
    recordUndo({ label: `Unarchived ${quoted(workspaceName(projectId))}`, undo: () => latest.current.archiveProject(projectId) });
  }, [workspaceName]);
  const deleteProject = useCallback((projectId: string) => {
    const name = workspaceName(projectId);
    const wasActive = activeProjectIdRef.current === projectId;
    latest.current.deleteProject(projectId);
    recordUndo({
      label: `Moved ${quoted(name)} to Trash`,
      toast: true,
      undo: () => {
        if (!projectsRef.current.some((p) => p.id === projectId)) return false;
        latest.current.restoreProject(projectId);
        if (wasActive) latest.current.selectProject(projectId);
        return true;
      },
    });
  }, [activeProjectIdRef, projectsRef, workspaceName]);
  const restoreProject = useCallback((projectId: string) => {
    latest.current.restoreProject(projectId);
    recordUndo({ label: `Restored ${quoted(workspaceName(projectId))}`, undo: () => latest.current.deleteProject(projectId) });
  }, [workspaceName]);

  const bulkArchiveTrees = useCallback(() => {
    const ids = [...treeSelection];
    recordUndoGroup(() => ids.forEach((id) => archiveTree(id)), (n) => `Archived ${n} threads`, { toast: true });
    latest.current.clearTreeSelection();
  }, [archiveTree, treeSelection]);
  const bulkDeleteTrees = useCallback(() => {
    const ids = [...treeSelection];
    recordUndoGroup(() => ids.forEach((id) => deleteTree(id)), (n) => `Moved ${n} threads to Trash`, { toast: true });
    latest.current.clearTreeSelection();
  }, [deleteTree, treeSelection]);
  const bulkUnarchiveTrees = useCallback(() => {
    const ids = [...treeSelection];
    recordUndoGroup(() => ids.forEach((id) => unarchiveTree(id)), (n) => `Unarchived ${n} threads`);
    latest.current.clearTreeSelection();
  }, [treeSelection, unarchiveTree]);

  const closePane = useCallback((paneId: string) => {
    const project = projectsRef.current.find((p) => p.id === activeProjectIdRef.current);
    const index = slotPanes.indexOf(paneId);
    const item = paneItemsRef.current[paneId];
    const focused = focusedPane === paneId;
    latest.current.closePane(paneId);
    if (!project || index < 0 || (item && SURFACE_PANES.has(item.kind))) return;
    const slot = { projectId: project.id, treeId: project.activeTreeId };
    const node = nodesRef.current[paneId];
    recordUndo({
      label: `Closed ${quoted(item ? paneItemTitle(item) : threadTitle(node))}`,
      undo: () => {
        const now = nodesRef.current[paneId];
        if (!item && (!now || now.deletedAt)) return false;
        const owner = projectsRef.current.find((p) => p.id === slot.projectId && !p.deletedAt);
        if (!owner || (slot.treeId && !owner.trees.some((t) => t.id === slot.treeId))) return false;
        if (item) latest.current.registerPaneItem(item);
        latest.current.restorePaneInSlot(slot, paneId, index, focused);
        // Closed in another thread than the one on screen now: go back to it.
        if (activeProjectIdRef.current !== slot.projectId) latest.current.selectProject(slot.projectId);
        if (slot.treeId && owner.activeTreeId !== slot.treeId) latest.current.activateTree(slot.treeId, slot.projectId);
        return true;
      },
    });
  }, [activeProjectIdRef, focusedPane, nodesRef, paneItemsRef, projectsRef, slotPanes]);

  return {
    archiveTree,
    unarchiveTree,
    deleteTree,
    moveTreeToWorkspace,
    renameNode,
    renameTree,
    pinTree,
    unpinTree,
    pinNode,
    unpinNode,
    pinProject,
    unpinProject,
    deleteNode,
    trimNode,
    archiveNode,
    renameProject,
    archiveProject,
    unarchiveProject,
    deleteProject,
    restoreProject,
    bulkArchiveTrees,
    bulkDeleteTrees,
    bulkUnarchiveTrees,
    closePane,
  };
}
