import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { toast } from 'sonner';
import {
  deleteWorkspace,
  moveTreeToWorkspace as apiMoveTreeToWorkspace,
} from '../services/api';
import { getElectron } from '../lib/electronBridge';
import { FOLDER_OVERLAP_MESSAGE, folderConflict, MAX_WORKSPACE_FOLDERS } from '../lib/workspaceFolders';
import { reduceProject } from './chatReducers';
import { hasUnseenCompletion } from './completionFacts';
import { pickLandingTreeId } from './conversationVisibility';
import { descendants } from './tree';
import { serializedEdgeId } from './edgeIds';
import type { ChatAction, ChatNodeState, FolderEntry, Project } from './chatTypes';
import type { Prefs } from './prefs';
import { backendConnectionIdForWorkspace, LOCAL_BACKEND_CONNECTION_ID, sameBackendConnection } from '../config/backendConnections';
import { backendEntityId } from '../config/backendIdentity';
import { firstLiveUserWorkspaceId, isSystemWorkspace } from './assistant/systemWorkspace';
import { userWorkspaceToReturnTo } from './assistant/userWorkspace';
import { treeMoveAdoptions, type StructureAdoption } from './structureAdoption';

interface UseProjectActionsArgs {
  projects: Project[];
  activeProjectId: string | null;
  chatsWorkspaceId: string;
  nodesRef: MutableRefObject<Record<string, ChatNodeState>>;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setActiveProjectId: Dispatch<SetStateAction<string | null>>;
  setNodes: Dispatch<SetStateAction<Record<string, ChatNodeState>>>;
}

export function useProjectActions({
  projects,
  activeProjectId,
  chatsWorkspaceId,
  nodesRef,
  setProjects,
  setActiveProjectId,
  setNodes,
}: UseProjectActionsArgs) {
  const createProject = useCallback(
    async (name?: string, cwd?: string, initFolders?: FolderEntry[], backendConnectionId?: string) => {
      const connectionId = backendConnectionId || LOCAL_BACKEND_CONNECTION_ID;
      const projectId = backendEntityId(connectionId, `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
      const finalName = (name && name.trim()) || nextUntitledName(projects);
      const now = Date.now();

      let resolvedCwd = cwd;
      if (!resolvedCwd && connectionId === LOCAL_BACKEND_CONNECTION_ID) {
        const electron = getElectron();
        if (electron?.resolveSkipCwd) {
          try {
            const r = await electron.resolveSkipCwd(projectId);
            resolvedCwd = r.path;
          } catch {
            // Fall through to undefined; backend will use process.cwd().
          }
        }
      }

      // If dialog provided full folder list, use it directly; otherwise synthesize from cwd
      const folders: FolderEntry[] = initFolders && initFolders.length > 0
        ? initFolders
        : resolvedCwd
          ? [{ id: projectId.slice(0, 16), path: resolvedCwd, addedAt: now }]
          : [];

      const project: Project = {
        id: projectId,
        name: finalName,
        backendConnectionId: connectionId === LOCAL_BACKEND_CONNECTION_ID ? undefined : connectionId,
        cwd: resolvedCwd,
        folders,
        chatIds: [],
        edges: [],
        createdAt: now,
        trees: [],
        activeTreeId: null,
        artifacts: [],
      };
      setProjects((prev) => [project, ...prev]);
      setActiveProjectId(projectId);
      return projectId;
    },
    [projects, setActiveProjectId, setProjects],
  );

  const enterChatsWorkspace = useCallback(async () => {
    const now = Date.now();
    setProjects((prev) => {
      const existing = prev.find((p) => p.id === chatsWorkspaceId);
      if (existing) {
        return prev.map((p) => {
          if (p.id !== chatsWorkspaceId) return p;
          const { archivedAt, deletedAt, ...rest } = p;
          return rest as Project;
        });
      }
      const fresh: Project = {
        id: chatsWorkspaceId,
        name: 'Chats',
        cwd: undefined,
        folders: [],
        chatIds: [],
        edges: [],
        createdAt: now,
        trees: [],
        activeTreeId: null,
        artifacts: [],
      };
      return [fresh, ...prev];
    });
    setActiveProjectId(chatsWorkspaceId);
    return chatsWorkspaceId;
  }, [chatsWorkspaceId, setActiveProjectId, setProjects]);

  const renameProject = useCallback((projectId: string, name: string) => {
    setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, name } : p)));
  }, [setProjects]);

  const setProjectCwd = useCallback((projectId: string, cwd: string) => {
    const trimmed = cwd.trim();
    if (!trimmed) return;
    setProjects((prev) => prev.map((p) => {
      if (p.id !== projectId) return p;
      const existing = p.folders ?? [];
      if (p.cwd === trimmed && existing[0]?.path === trimmed) return p;
      const selected = existing.find((folder) => folder.path === trimmed);
      // The first folder is the workspace default. Selecting an existing
      // secondary folder keeps both registrations; a new path replaces the
      // previous default. Runtime bindings belong to nodes and stay intact.
      const folders = selected
        ? [selected, ...existing.filter((folder) => folder.id !== selected.id)]
        : [{ id: Math.random().toString(36).slice(2, 10), path: trimmed, addedAt: Date.now() }, ...existing.slice(1)];
      return { ...p, cwd: trimmed, folders };
    }));
  }, [setProjects]);

  const addFolder = useCallback((projectId: string, folderPath: string, label?: string) => {
    const resolved = folderPath.trim();
    if (!resolved) return;
    setProjects((prev) => prev.map((p) => {
      if (p.id !== projectId) return p;
      const existing = p.folders ?? [];
      if (existing.length >= MAX_WORKSPACE_FOLDERS) return p;
      if (folderConflict(resolved, existing)) {
        // Schedule toast outside reducer (safe: setState is batched)
        setTimeout(() => toast.error(FOLDER_OVERLAP_MESSAGE), 0);
        return p;
      }
      const entry: FolderEntry = {
        id: Math.random().toString(36).slice(2, 10),
        path: resolved,
        label,
        addedAt: Date.now(),
      };
      return { ...p, cwd: existing[0]?.path ?? resolved, folders: [...existing, entry] };
    }));
  }, [setProjects]);

  const removeFolder = useCallback((projectId: string, folderId: string) => {
    setProjects((prev) => prev.map((p) => {
      if (p.id !== projectId) return p;
      const existing = p.folders ?? [];
      // Cannot remove folders[0] (the cwd)
      if (existing.length > 0 && existing[0].id === folderId) return p;
      return { ...p, folders: existing.filter((f) => f.id !== folderId) };
    }));
  }, [setProjects]);

  const updateFolderLabel = useCallback((projectId: string, folderId: string, label: string) => {
    setProjects((prev) => prev.map((p) => {
      if (p.id !== projectId) return p;
      const existing = p.folders ?? [];
      return {
        ...p,
        folders: existing.map((f) => f.id === folderId ? { ...f, label } : f),
      };
    }));
  }, [setProjects]);

  const setProjectInstructions = useCallback(
    (projectId: string, instructions: string) => {
      const next = instructions.length > 0 ? instructions : undefined;
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== projectId) return p;
          if (p.instructions === next) return p;
          if (next === undefined) {
            const { instructions: _omit, ...rest } = p;
            return rest as Project;
          }
          return { ...p, instructions: next };
        }),
      );
    },
    [setProjects],
  );

  const deleteProject = useCallback(
    (projectId: string) => {
      setProjects((prev) => {
        const next = prev.map((p) =>
          p.id === projectId ? { ...p, deletedAt: Date.now() } : p,
        );
        if (activeProjectId === projectId) setActiveProjectId(firstLiveUserWorkspaceId(next, projectId));
        return next;
      });
    },
    [activeProjectId, setActiveProjectId, setProjects],
  );

  const restoreProject = useCallback((projectId: string) => {
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId) return p;
        const { deletedAt, ...rest } = p;
        return rest as Project;
      }),
    );
  }, [setProjects]);

  const archiveProject = useCallback(
    (projectId: string) => {
      setProjects((prev) => {
        const next = prev.map((p) =>
          p.id === projectId ? { ...p, archivedAt: Date.now() } : p,
        );
        if (activeProjectId === projectId) setActiveProjectId(firstLiveUserWorkspaceId(next, projectId));
        return next;
      });
    },
    [activeProjectId, setActiveProjectId, setProjects],
  );

  const unarchiveProject = useCallback((projectId: string) => {
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId) return p;
        const { archivedAt, ...rest } = p;
        return rest as Project;
      }),
    );
  }, [setProjects]);

  const purgeProject = useCallback((projectId: string): Promise<void> => {
    const dead = projects.find((p) => p.id === projectId);
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    if (dead) {
      const next = { ...nodesRef.current };
      for (const nid of dead.chatIds) delete next[nid];
      nodesRef.current = next;
      setNodes(next);
    }
    // Returns the deletion Promise so Empty Trash can await all in-flight
    // workspace deletes before clearing local state and re-enabling sync.
    // Callers that don't care (legacy fire-and-forget UI) ignore the Promise;
    // log on failure for both paths.
    return deleteWorkspace(projectId).catch((err) => {
      console.warn('deleteWorkspace failed:', err);
      throw err;
    });
  }, [nodesRef, projects, setNodes, setProjects]);

  const selectProject = useCallback((projectId: string) => {
    setActiveProjectId(projectId);
  }, [setActiveProjectId]);

  return {
    createProject,
    enterChatsWorkspace,
    renameProject,
    setProjectCwd,
    addFolder,
    removeFolder,
    updateFolderLabel,
    setProjectInstructions,
    deleteProject,
    restoreProject,
    purgeProject,
    archiveProject,
    unarchiveProject,
    selectProject,
  };
}

interface UseTreeActionsArgs {
  projects: Project[];
  activeProjectId: string | null;
  nodesRef: MutableRefObject<Record<string, ChatNodeState>>;
  dispatch: (action: ChatAction) => void;
  renameNode: (nodeId: string, title: string) => void;
  /** Allocates a node id in `projectId`'s backend scope (default: the active workspace). */
  newNodeId: (projectId?: string) => string;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setNodes: Dispatch<SetStateAction<Record<string, ChatNodeState>>>;
  setPaneSlot: (projectId: string, treeId: string, panes: string[], focused: string | null) => void;
  ensurePaneSlot: (projectId: string, treeId: string, rootNodeId: string) => void;
  setFocusedNodeId: Dispatch<SetStateAction<string | null>>;
  /** Switch the active workspace (createThread leaves the assistant's hidden one). */
  selectProject?: (projectId: string) => void;
  /** useTrashActions' soft delete, shared so a thread and a branch delete alike. */
  deleteSubtree: (
    project: Project,
    rootId: string,
    updateProject?: (project: Project, nodes: Record<string, ChatNodeState>) => Project,
  ) => string;
  sidebarExpanded: Prefs['sidebarExpanded'];
  setSidebarExpanded: (value: Prefs['sidebarExpanded']) => void;
  /** Persistence: hold queued writes around a backend-made structure change. Optional in tests. */
  runWorkspaceMutation?: (projectId: string, mutation: () => Promise<void>) => Promise<void>;
  /** Persistence: what the backend already holds, so it is not written back. Optional in tests. */
  adoptBackendStructure?: (adoption: StructureAdoption) => void;
  /** Bump the structure version so useStructuralSelector consumers re-compute. */
  bumpStructureVersion?: () => void;
}

export function useTreeActions({
  projects,
  activeProjectId,
  nodesRef,
  dispatch,
  renameNode,
  newNodeId,
  setProjects,
  setNodes,
  setPaneSlot,
  ensurePaneSlot,
  setFocusedNodeId,
  selectProject,
  deleteSubtree,
  sidebarExpanded,
  setSidebarExpanded,
  runWorkspaceMutation,
  adoptBackendStructure,
  bumpStructureVersion,
}: UseTreeActionsArgs) {
  const createThread = useCallback((modeId?: string, options?: { temporary?: boolean }) => {
    let projectId = activeProjectId;
    if (!projectId) return null;
    // The assistant's hidden workspace is active only while its pane is open;
    // a thread started then goes to the user's workspace (the one they came
    // from), never where no list shows it.
    if (isSystemWorkspace(projects.find((p) => p.id === projectId))) {
      const back = userWorkspaceToReturnTo(projects);
      if (!back || !selectProject) return null;
      selectProject(back);
      projectId = back;
    }
    const targetId = projectId;
    // Scoped to the target: when the hidden assistant workspace was active,
    // the ref may not have caught up with the switch above yet.
    const nodeId = newNodeId(targetId);
    const treeId = backendEntityId(backendConnectionIdForWorkspace(targetId), `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const now = Date.now();
    dispatch({ type: 'create', nodeId, projectId: targetId, modeId, ...(options?.temporary ? { temporary: true } : {}) });
    setProjects((prev) =>
      prev.map((p) =>
        p.id === targetId
          ? reduceProject(p, { type: 'create-tree', treeId, rootNodeId: nodeId, now })
          : p,
      ),
    );
    setPaneSlot(targetId, treeId, [nodeId], nodeId);
    setFocusedNodeId(nodeId);
    if (sidebarExpanded.workspaces[targetId] === false) {
      setSidebarExpanded({
        ...sidebarExpanded,
        workspaces: {
          ...sidebarExpanded.workspaces,
          [targetId]: true,
        },
      });
    }
    return nodeId;
  }, [
    activeProjectId,
    projects,
    selectProject,
    dispatch,
    newNodeId,
    setFocusedNodeId,
    setPaneSlot,
    setProjects,
    setSidebarExpanded,
    sidebarExpanded,
  ]);

  const isTreeStreaming = useCallback(
    (project: Project, treeId: string) => {
      const tree = project.trees.find((t) => t.id === treeId);
      if (!tree) return false;
      const rootIdsInTree = [tree.rootNodeId, ...Array.from(descendants(tree.rootNodeId, project.edges))];
      for (const id of rootIdsInTree) {
        if (nodesRef.current[id]?.status === 'streaming') return true;
      }
      return false;
    },
    [nodesRef],
  );

  /** Whether it archived the thread (not while it streams). */
  const archiveTree = useCallback(
    (treeId: string): boolean => {
      const project = projects.find((p) => p.trees.some((t) => t.id === treeId));
      if (!project) return false;
      if (isTreeStreaming(project, treeId)) {
        toast.warning('Stop streaming nodes in this thread before archiving.');
        return false;
      }
      setProjects((prev) =>
        prev.map((p) =>
          p.id === project.id ? reduceProject(p, { type: 'archive-tree', treeId, now: Date.now(), nodes: nodesRef.current }) : p,
        ),
      );
      return true;
    },
    [isTreeStreaming, nodesRef, projects, setProjects],
  );

  const unarchiveTree = useCallback(
    (treeId: string): boolean => {
      const project = projects.find((p) => p.trees.some((t) => t.id === treeId));
      if (!project) return false;
      setProjects((prev) =>
        prev.map((p) =>
          p.id === project.id ? reduceProject(p, { type: 'unarchive-tree', treeId, now: Date.now() }) : p,
        ),
      );
      return true;
    },
    [projects, setProjects],
  );

  const pinTree = useCallback(
    (treeId: string) => {
      const project = projects.find((p) => p.trees.some((t) => t.id === treeId));
      if (!project) return;
      setProjects((prev) =>
        prev.map((p) =>
          p.id === project.id ? reduceProject(p, { type: 'pin-tree', treeId, now: Date.now() }) : p,
        ),
      );
    },
    [projects, setProjects],
  );

  const unpinTree = useCallback(
    (treeId: string) => {
      const project = projects.find((p) => p.trees.some((t) => t.id === treeId));
      if (!project) return;
      setProjects((prev) =>
        prev.map((p) =>
          p.id === project.id ? reduceProject(p, { type: 'unpin-tree', treeId }) : p,
        ),
      );
    },
    [projects, setProjects],
  );

  const pinProject = useCallback(
    (projectId: string) => {
      setProjects((prev) =>
        prev.map((p) => (p.id === projectId ? { ...p, pinnedAt: Date.now() } : p)),
      );
    },
    [setProjects],
  );

  const unpinProject = useCallback(
    (projectId: string) => {
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== projectId) return p;
          const { pinnedAt, ...rest } = p;
          return rest as typeof p;
        }),
      );
    },
    [setProjects],
  );

  // A thread's name is its root conversation's title.
  const renameTree = useCallback(
    (treeId: string, name: string, targetProjectId?: string) => {
      const projectId = targetProjectId ?? activeProjectId;
      const tree = projects.find((p) => p.id === projectId)?.trees.find((t) => t.id === treeId);
      if (tree) renameNode(tree.rootNodeId, name);
    },
    [activeProjectId, projects, renameNode],
  );

  const activateTree = useCallback(
    (treeId: string, targetProjectId?: string) => {
      const projectId = targetProjectId ?? activeProjectId;
      const project = projects.find((p) => p.id === projectId);
      if (!project) return;
      const tree = project.trees.find((t) => t.id === treeId);
      if (!tree) return;
      setProjects((prev) =>
        prev.map((p) => (p.id === project.id ? reduceProject(p, { type: 'activate-tree', treeId }) : p)),
      );
      ensurePaneSlot(project.id, treeId, tree.rootNodeId);
      if (project.id === activeProjectId) setFocusedNodeId(tree.rootNodeId);

      // Mark all nodes in the activated tree as read so the thread-level
      // unread badge clears even when child branches completed while unfocused.
      // Opening the thread is the user's own act, so its completions count as seen.
      const now = Date.now();
      const allIds = descendants(tree.rootNodeId, project.edges);
      allIds.add(tree.rootNodeId);
      for (const nid of allIds) {
        const node = nodesRef.current[nid];
        if (node && hasUnseenCompletion(node)) {
          dispatch({ type: 'node-viewed', nodeId: nid, viewedAt: now, seen: true });
        }
      }
    },
    [activeProjectId, dispatch, ensurePaneSlot, nodesRef, projects, setFocusedNodeId, setProjects],
  );

  const deleteTree = useCallback(
    (treeId: string): string | null => {
      const project = projects.find((p) => p.trees.some((t) => t.id === treeId));
      if (!project) return null;
      if (isTreeStreaming(project, treeId)) {
        toast.warning('Stop streaming nodes in this thread before deleting.');
        return null;
      }
      const tree = project.trees.find((t) => t.id === treeId);
      if (!tree) return null;
      return deleteSubtree(project, tree.rootNodeId, (p, nodes) => (
        p.activeTreeId !== treeId
          ? { ...p }
          : { ...p, activeTreeId: pickLandingTreeId(p.trees.filter((t) => t.id !== treeId), nodes) }
      ));
    },
    [deleteSubtree, isTreeStreaming, projects],
  );

  /** Whether it moved the thread. Tells the user why when it did not. */
  const moveTreeToWorkspace = useCallback(
    async (treeId: string, targetProjectId: string): Promise<boolean> => {
      const source = projects.find((p) => p.trees.some((t) => t.id === treeId));
      if (!source) return false;
      if (source.id === targetProjectId) return false;
      const target = projects.find((p) => p.id === targetProjectId);
      if (!target) {
        toast.error('Target workspace not found.');
        return false;
      }
      if (!sameBackendConnection(source, target)) {
        toast.error('Threads cannot be moved between local and remote backends.');
        return false;
      }
      if (isTreeStreaming(source, treeId)) {
        toast.warning('Stop streaming nodes in this thread before moving.');
        return false;
      }
      const tree = source.trees.find((t) => t.id === treeId);
      if (!tree) return false;

      const liveEdges = source.edges.filter(
        (e) => !nodesRef.current[e.source]?.deletedAt && !nodesRef.current[e.target]?.deletedAt,
      );
      const moving = descendants(tree.rootNodeId, liveEdges);
      moving.add(tree.rootNodeId);
      const removedEdges = source.edges.filter((e) => moving.has(e.source) || moving.has(e.target));
      const movingEdges = source.edges.filter((e) => moving.has(e.source) && moving.has(e.target));

      const move = async () => {
        await apiMoveTreeToWorkspace(treeId, source.id, target.id);
        const confirmedAt = Date.now();
        const nextNodes = { ...nodesRef.current };
        const movedNodes: ChatNodeState[] = [];
        moving.forEach((id) => {
          const cur = nextNodes[id];
          if (!cur) return;
          nextNodes[id] = cur.projectId === target.id ? cur : { ...cur, projectId: target.id };
          movedNodes.push(nextNodes[id]);
        });
        // The backend has moved the tree, its threads and their edges: adopt
        // that, as a re-read would, so neither workspace writes it again.
        for (const adoption of treeMoveAdoptions({
          from: source, to: target, tree, nodeIds: moving, removedEdges, addedEdges: movingEdges, movedNodes,
        }, confirmedAt)) adoptBackendStructure?.(adoption);

        setProjects((prev) =>
          prev.map((p) => {
            if (p.id === source.id) {
              const trees = p.trees.filter((t) => t.id !== treeId);
              const chatIds = p.chatIds.filter((id) => !moving.has(id));
              const edges = p.edges.filter(
                (e) => !moving.has(e.source) && !moving.has(e.target),
              );
              const activeTreeId = p.activeTreeId === treeId ? pickLandingTreeId(trees, nodesRef.current) : p.activeTreeId;
              return { ...p, trees, chatIds, edges, activeTreeId };
            }
            if (p.id === target.id) {
              // A re-read may already have brought some of it here.
              const trees = p.trees.some((t) => t.id === treeId) ? p.trees : [...p.trees, tree];
              const chatIds = [...p.chatIds, ...Array.from(moving).filter((id) => !p.chatIds.includes(id))];
              const held = new Set(p.edges.map(serializedEdgeId));
              const edges = [...p.edges, ...movingEdges.filter((e) => !held.has(serializedEdgeId(e)))];
              return { ...p, trees, chatIds, edges };
            }
            return p;
          }),
        );
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        bumpStructureVersion?.();
      };

      try {
        // Writes queued for the source go out first, while the moving threads still belong to it.
        if (runWorkspaceMutation) await runWorkspaceMutation(source.id, move);
        else await move();
      } catch (err) {
        toast.error(`Move failed: ${(err as Error).message}`);
        return false;
      }
      return true;
    },
    [adoptBackendStructure, bumpStructureVersion, isTreeStreaming, nodesRef, projects, runWorkspaceMutation, setNodes, setProjects],
  );

  return {
    createThread,
    archiveTree,
    unarchiveTree,
    pinTree,
    unpinTree,
    pinProject,
    unpinProject,
    renameTree,
    activateTree,
    deleteTree,
    moveTreeToWorkspace,
  };
}

function nextUntitledName(existing: readonly Project[]): string {
  const taken = new Set<number>();
  for (const p of existing) {
    if (p.deletedAt) continue;
    const m = /^Untitled-(\d+)$/.exec(p.name);
    if (m) taken.add(Number(m[1]));
  }
  let n = 1;
  while (taken.has(n)) n++;
  return `Untitled-${n}`;
}
