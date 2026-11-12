import { hydrateBackendWorkspaces } from './chatHydration';
import { projectConnectionId } from '../config/backendConnections';
import type { ChatNodeState, Project, ProjectEdge, Tree } from './chatTypes';
import { isSystemWorkspace } from './assistant/systemWorkspace';
import { isListedThread, pickLandingTreeId } from './conversationVisibility';
import { descendants, isBranchEdge } from './tree';
import { serializedEdgeId } from './edgeIds';
import {
  NODE_ADOPTED_FIELDS,
  TREE_ADOPTED_FIELDS,
  WORKSPACE_ADOPTED_FIELDS,
  type AdoptedNodeField,
  type AdoptedTreeField,
  type NodeGuardField,
  type StructureAdoption,
  type TreeGuardField,
  type WorkspaceGuardField,
} from './structureAdoption';
import type { PendingBackendDeletes } from './workspacePersistence';

/**
 * Reconcile re-read workspaces (after a workspace_structure_changed frame)
 * into the store without clobbering this window's own work:
 *
 * - Additions (workspaces, trees, threads, edges) come in as hydration would
 *   load them, except what this window just removed (pendingDeletes).
 * - Fields (names, trash/archive marks, pins, parents) take the backend's
 *   value unless this window changed them and the backend has not confirmed
 *   that change by the time the read began (guards).
 * - A tree or thread the backend now holds in another re-read workspace has
 *   moved there.
 * - Removals need an explicit record (purged workspace or thread, deleted
 *   tree) and the entity's absence from the re-read workspaces: absence
 *   alone may only mean this window's own new work has not landed yet.
 *   A complete read (everything the connection holds, after a gap) removes
 *   what it lacks only if the backend held it before the read began, as far
 *   as this window knows: what it loaded, adopted or saved itself. Trashed
 *   and archived entities are still read; only purged and deleted ones go.
 * - The active tree and every live field (messages, drafts, streams, queues)
 *   stay as they are; an active tree that is gone falls back.
 *
 * The assistant's system workspace is left to its own flows.
 */

/** Questions only the persistence layer can answer (see useWorkspacePersistence). */
export interface StructureEditGuards {
  /** True when the store's value may be a local edit the backend had not confirmed when the read began. */
  workspaceFieldEdited(project: Project, field: WorkspaceGuardField, readStartedAt: number): boolean;
  treeFieldEdited(project: Project, tree: Tree, field: TreeGuardField, readStartedAt: number): boolean;
  nodeFieldEdited(project: Project, nodes: Record<string, ChatNodeState>, nodeId: string, field: NodeGuardField, readStartedAt: number): boolean;
  pendingDeletes(project: Project, readStartedAt: number): PendingBackendDeletes;
  /** Serialized ids of edges this window added that the backend may not have held when the read began. */
  pendingEdgeUpserts(project: Project, readStartedAt: number): ReadonlySet<string>;
  /**
   * True when this window knows the backend held the entity before the read
   * began (loaded from it, adopted from a read, or saved and confirmed). Only
   * then may a complete read that lacks it remove it: never local-only work.
   */
  heldByBackendBefore(entity: 'workspace' | 'tree' | 'node', id: string, readStartedAt: number): boolean;
}

export interface StructureReadSnapshot {
  /** Renderer id of the workspace read. */
  workspaceId: string;
  /** The workspace as read (structure only), or null: the backend no longer has it. */
  raw: unknown | null;
}

export interface StructureRemovals {
  workspaceIds: ReadonlySet<string>;
  treeIds: ReadonlySet<string>;
  nodeIds: ReadonlySet<string>;
}

export interface StructureMergeInput {
  currentProjects: readonly Project[];
  currentNodes: Record<string, ChatNodeState>;
  snapshots: readonly StructureReadSnapshot[];
  connectionId: string;
  removals: StructureRemovals;
  /** The snapshots are every workspace the connection holds (a full read that succeeded). */
  complete?: boolean;
  readStartedAt: number;
  guards: StructureEditGuards;
}

export interface StructureMergeResult {
  projects: Project[];
  nodes: Record<string, ChatNodeState>;
  adoptions: StructureAdoption[];
  removedProjectIds: string[];
  removedNodeIds: string[];
}

const ALL_TREE_FIELDS: readonly AdoptedTreeField[] = TREE_ADOPTED_FIELDS.map(([field]) => field);
const ALL_NODE_FIELDS: readonly AdoptedNodeField[] = [...NODE_ADOPTED_FIELDS.map(([field]) => field), 'projectId'];

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

class AdoptionBuilder {
  private readonly byProject = new Map<string, StructureAdoption>();
  constructor(private readonly readStartedAt: number) {}

  for(projectId: string): StructureAdoption {
    let adoption = this.byProject.get(projectId);
    if (!adoption) this.byProject.set(projectId, adoption = { projectId, readStartedAt: this.readStartedAt });
    return adoption;
  }

  push<K extends 'trees' | 'removedTreeIds' | 'chatIds' | 'removedChatIds' | 'edges' | 'removedEdgeIds' | 'nodes'>(
    projectId: string, key: K, value: NonNullable<StructureAdoption[K]>[number],
  ): void {
    const adoption = this.for(projectId) as unknown as Record<string, unknown[] | undefined>;
    (adoption[key] ??= []).push(value);
  }

  all(): StructureAdoption[] {
    return [...this.byProject.values()].filter((adoption) => Object.keys(adoption).length > 2);
  }
}

export function reconcileWorkspaceStructure(input: StructureMergeInput): StructureMergeResult | null {
  const { currentProjects, currentNodes, snapshots, connectionId, removals, readStartedAt, guards } = input;
  const present = snapshots.filter((snapshot) => snapshot.raw !== null);
  const hydrated = hydrateBackendWorkspaces(present.map((snapshot) => snapshot.raw), null, connectionId);
  const servers = new Map(hydrated.projects.filter((project) => !isSystemWorkspace(project)).map((project) => [project.id, project] as const));
  // A complete read that returned nothing at all is not taken as every workspace gone.
  const complete = !!input.complete && present.length > 0;
  const returned = new Set([...present.map((snapshot) => snapshot.workspaceId), ...hydrated.projects.map((project) => project.id)]);
  /** Missing from a complete read although the backend held it: removed there during a gap. */
  const goneFromCompleteRead = (entity: 'workspace' | 'tree' | 'node', id: string) =>
    complete && guards.heldByBackendBefore(entity, id, readStartedAt);
  const serverNodes = hydrated.nodes;
  // Where the backend now holds what it was asked about.
  const serverTreeHome = new Map<string, string>();
  const serverNodeHome = new Map<string, string>();
  const serverNodeTree = new Map<string, string>();
  for (const server of servers.values()) {
    for (const tree of server.trees) {
      serverTreeHome.set(tree.id, server.id);
      for (const nodeId of [tree.rootNodeId, ...descendants(tree.rootNodeId, server.edges)]) {
        if (!serverNodeTree.has(nodeId)) serverNodeTree.set(nodeId, tree.id);
      }
    }
    for (const nodeId of server.chatIds) serverNodeHome.set(nodeId, server.id);
  }
  const read = new Set(snapshots.map((snapshot) => snapshot.workspaceId));
  const locals = new Map(currentProjects.map((project) => [project.id, project] as const));
  const builder = new AdoptionBuilder(readStartedAt);
  const removedProjectIds: string[] = [];
  const removedNodeIds = new Set<string>();
  let nodes = currentNodes;
  const writeNode = (node: ChatNodeState) => {
    if (nodes === currentNodes) nodes = { ...currentNodes };
    nodes[node.nodeId] = node;
  };
  const dropNode = (nodeId: string) => {
    if (!(nodeId in nodes)) return;
    if (nodes === currentNodes) nodes = { ...currentNodes };
    delete nodes[nodeId];
    removedNodeIds.add(nodeId);
  };
  const pendingFor = new Map<string, PendingBackendDeletes>();
  const pendingDeletes = (project: Project) => {
    let pending = pendingFor.get(project.id);
    if (!pending) pendingFor.set(project.id, pending = guards.pendingDeletes(project, readStartedAt));
    return pending;
  };
  const isReadWorkspace = (project: Project) => read.has(project.id) && !isSystemWorkspace(project);

  // 1. Moves: a tree or thread the backend now holds in another re-read
  // workspace left the one this window shows it in. Both sides were read, and
  // the destination is not one this window just took it out of.
  const movedTrees = new Map<string, string>(); // tree id → destination
  const movedNodes = new Map<string, string>(); // node id → destination
  for (const local of currentProjects) {
    if (!isReadWorkspace(local) || !servers.has(local.id)) continue;
    for (const tree of local.trees) {
      const home = serverTreeHome.get(tree.id);
      const destination = home ? locals.get(home) : undefined;
      if (!home || home === local.id || !destination || pendingDeletes(destination).treeIds.has(tree.id)) continue;
      movedTrees.set(tree.id, home);
    }
    for (const nodeId of local.chatIds) {
      const home = serverNodeHome.get(nodeId);
      const destination = home ? locals.get(home) : undefined;
      if (!home || home === local.id || !destination) continue;
      const treeId = serverNodeTree.get(nodeId);
      if (treeId && pendingDeletes(destination).treeIds.has(treeId)) continue;
      movedNodes.set(nodeId, home);
    }
  }
  // A thread whose tree moved went with it even if a later read missed it.
  for (const [treeId, home] of movedTrees) {
    const owner = currentProjects.find((project) => project.trees.some((tree) => tree.id === treeId));
    const tree = owner?.trees.find((candidate) => candidate.id === treeId);
    if (!owner || !tree) continue;
    for (const nodeId of [tree.rootNodeId, ...descendants(tree.rootNodeId, owner.edges)]) {
      if (serverNodeHome.get(nodeId) === home) movedNodes.set(nodeId, home);
    }
  }

  const projects: Project[] = [];
  for (const local of currentProjects) {
    // 2. A purged workspace: recorded as purged and no longer readable, or
    // missing from a complete read of its connection that it was held before.
    const recordedGone = read.has(local.id) && removals.workspaceIds.has(local.id)
      && snapshots.some((snapshot) => snapshot.workspaceId === local.id && snapshot.raw === null);
    const missing = complete && !returned.has(local.id) && !isSystemWorkspace(local)
      && projectConnectionId(local) === connectionId
      && goneFromCompleteRead('workspace', local.id);
    if (recordedGone || missing) {
      removedProjectIds.push(local.id);
      for (const nodeId of local.chatIds) dropNode(nodeId);
      continue;
    }
    const server = servers.get(local.id);
    if (!server || !isReadWorkspace(local)) {
      projects.push(local);
      continue;
    }
    projects.push(mergeProject(local, server));
  }

  // 3. Workspaces the store does not hold yet, loaded as hydration would.
  // Not a trashed one: this window may have just purged it from its trash
  // (the store lets go before the backend confirms).
  for (const server of servers.values()) {
    if (locals.has(server.id) || server.deletedAt) continue;
    const heldElsewhere = (nodeId: string) => !!currentNodes[nodeId] && currentNodes[nodeId].projectId !== server.id;
    const trees = server.trees.filter((tree) => !heldElsewhere(tree.rootNodeId));
    const chatIds = server.chatIds.filter((nodeId) => !heldElsewhere(nodeId));
    const keep = new Set(chatIds);
    const fresh: Project = {
      ...server,
      trees,
      chatIds,
      edges: server.edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target)),
      activeTreeId: server.activeTreeId && trees.some((tree) => tree.id === server.activeTreeId)
        ? server.activeTreeId
        : pickLandingTreeId(trees, serverNodes),
    };
    for (const nodeId of chatIds) if (serverNodes[nodeId] && !currentNodes[nodeId]) writeNode(serverNodes[nodeId]);
    builder.for(server.id).newProject = true;
    projects.push(fresh);
  }

  const adoptions = builder.all();
  const projectsChanged = projects.length !== currentProjects.length
    || projects.some((project, index) => project !== currentProjects[index]);
  if (!projectsChanged && nodes === currentNodes) return null;
  return { projects, nodes, adoptions, removedProjectIds, removedNodeIds: [...removedNodeIds] };

  function mergeProject(local: Project, server: Project): Project {
    const pending = pendingDeletes(local);
    let next = local;
    const patchProject = (patch: Partial<Project>) => { next = { ...next, ...patch }; };

    // Workspace fields.
    const workspacePatch: Partial<Project> = {};
    for (const [field, column] of WORKSPACE_ADOPTED_FIELDS) {
      if (sameValue(local[field], server[field]) || guards.workspaceFieldEdited(local, column, readStartedAt)) continue;
      (workspacePatch as Record<string, unknown>)[field] = server[field];
    }
    if (Object.keys(workspacePatch).length > 0) {
      patchProject(workspacePatch);
      builder.for(local.id).workspace = { ...builder.for(local.id).workspace, ...workspacePatch };
    }

    const serverTrees = new Map(server.trees.map((tree) => [tree.id, tree] as const));
    const serverNodeIds = new Set(server.chatIds);

    // Trees: fields, removals, arrivals.
    const removedTrees = new Set<string>();
    const trees: Tree[] = [];
    for (const tree of local.trees) {
      if (movedTrees.has(tree.id)) {
        removedTrees.add(tree.id);
        continue;
      }
      const serverTree = serverTrees.get(tree.id);
      if (!serverTree) {
        const gone = removals.treeIds.has(tree.id) || goneFromCompleteRead('tree', tree.id);
        if (gone && !serverTreeHome.has(tree.id)) removedTrees.add(tree.id);
        else trees.push(tree);
        continue;
      }
      const patch: Partial<Tree> = {};
      const fields: AdoptedTreeField[] = [];
      for (const [field, column] of TREE_ADOPTED_FIELDS) {
        if (sameValue(tree[field], serverTree[field]) || guards.treeFieldEdited(local, tree, column, readStartedAt)) continue;
        (patch as Record<string, unknown>)[field] = serverTree[field];
        fields.push(field);
      }
      if (fields.length === 0) {
        trees.push(tree);
        continue;
      }
      const updated = { ...tree, ...patch };
      trees.push(updated);
      builder.push(local.id, 'trees', { tree: updated, fields });
    }
    const heldTreeIds = new Set(local.trees.map((tree) => tree.id));
    for (const serverTree of server.trees) {
      if (heldTreeIds.has(serverTree.id) || pending.treeIds.has(serverTree.id)) continue;
      // Held in another workspace here: it arrives only as a confirmed move.
      const elsewhere = currentProjects.some((project) => project.id !== local.id && project.trees.some((tree) => tree.id === serverTree.id));
      if (elsewhere && movedTrees.get(serverTree.id) !== local.id) continue;
      const root = currentNodes[serverTree.rootNodeId];
      if (root && root.projectId !== local.id && movedNodes.get(serverTree.rootNodeId) !== local.id) continue;
      trees.push(serverTree);
      builder.push(local.id, 'trees', { tree: serverTree, fields: ALL_TREE_FIELDS, isNew: true });
    }
    for (const treeId of removedTrees) builder.push(local.id, 'removedTreeIds', treeId);

    // Threads in a removed tree that the backend dropped with it.
    const doomedNodes = new Set<string>();
    for (const tree of local.trees) {
      if (!removedTrees.has(tree.id) || movedTrees.has(tree.id)) continue;
      for (const nodeId of [tree.rootNodeId, ...descendants(tree.rootNodeId, local.edges)]) {
        if (!serverNodeHome.has(nodeId)) doomedNodes.add(nodeId);
      }
    }

    // Threads: departures, removals, field updates, arrivals.
    const chatIds: string[] = [];
    const leaving = new Set<string>();
    for (const nodeId of local.chatIds) {
      if (movedNodes.has(nodeId)) {
        leaving.add(nodeId);
        builder.push(local.id, 'removedChatIds', nodeId);
        continue;
      }
      const absent = !serverNodeIds.has(nodeId) && !serverNodeHome.has(nodeId);
      if (absent && (removals.nodeIds.has(nodeId) || doomedNodes.has(nodeId) || goneFromCompleteRead('node', nodeId))) {
        leaving.add(nodeId);
        builder.push(local.id, 'removedChatIds', nodeId);
        dropNode(nodeId);
        continue;
      }
      chatIds.push(nodeId);
      const held = nodes[nodeId];
      const serverNode = serverNodes[nodeId];
      if (!held || !serverNode || !serverNodeIds.has(nodeId)) continue;
      const patch: Partial<ChatNodeState> = {};
      const fields: AdoptedNodeField[] = [];
      for (const [field, column] of NODE_ADOPTED_FIELDS) {
        if (sameValue(held[field], serverNode[field])
          || guards.nodeFieldEdited(local, nodes, nodeId, column, readStartedAt)) continue;
        (patch as Record<string, unknown>)[field] = serverNode[field];
        fields.push(field);
      }
      // Server-owned, never edited here or written back: a Scheduled-only
      // run's thread moved to its workspace (another window) shows at once.
      const serverOwned = (held.scheduledOnlyJobId ?? null) !== (serverNode.scheduledOnlyJobId ?? null);
      if (serverOwned) patch.scheduledOnlyJobId = serverNode.scheduledOnlyJobId ?? null;
      if (fields.length === 0 && !serverOwned) continue;
      // Structural fields only: messages, drafts, streams and queues stay live.
      const updated = { ...held, ...patch };
      if (fields.length === 0) {
        writeNode(updated);
        continue;
      }
      writeNode(updated);
      builder.push(local.id, 'nodes', { node: updated, fields });
    }
    for (const nodeId of server.chatIds) {
      if (chatIds.includes(nodeId)) continue;
      const held = currentNodes[nodeId];
      const serverNode = serverNodes[nodeId];
      if (!serverNode) continue;
      if (held && held.projectId !== local.id) {
        if (movedNodes.get(nodeId) !== local.id) continue;
        // Moved in: its live state comes along, the backend's structure with it.
        const patch: Partial<ChatNodeState> = { projectId: local.id };
        const fields: AdoptedNodeField[] = ['projectId'];
        for (const [field] of NODE_ADOPTED_FIELDS) {
          if (sameValue(held[field], serverNode[field])) continue;
          (patch as Record<string, unknown>)[field] = serverNode[field];
          fields.push(field);
        }
        const moved = { ...held, ...patch };
        writeNode(moved);
        chatIds.push(nodeId);
        builder.push(local.id, 'chatIds', nodeId);
        builder.push(local.id, 'nodes', { node: moved, fields });
        continue;
      }
      if (held) continue; // Still settling locally (e.g. restored from trash before its write landed).
      const treeId = serverNodeTree.get(nodeId);
      if (treeId && (pending.treeIds.has(treeId) || !trees.some((candidate) => candidate.id === treeId))) continue;
      writeNode(serverNode);
      chatIds.push(nodeId);
      builder.push(local.id, 'chatIds', nodeId);
      builder.push(local.id, 'nodes', { node: serverNode, fields: ALL_NODE_FIELDS, isNew: true });
    }
    const members = new Set(chatIds);

    // Edges: drop what lost an endpoint or a branch the backend re-parented;
    // add what the backend holds and this window did not just remove.
    const pendingUpserts = guards.pendingEdgeUpserts(local, readStartedAt);
    const serverEdges = new Map(server.edges.map((edge) => [serializedEdgeId(edge), edge] as const));
    const edges: ProjectEdge[] = [];
    for (const edge of local.edges) {
      const id = serializedEdgeId(edge);
      // An edge cannot outlive an endpoint that left; a pending write of it is dropped with it.
      const endpointLeft = leaving.has(edge.source) || leaving.has(edge.target);
      const target = serverNodes[edge.target];
      const reparented = isBranchEdge(edge)
        && !serverEdges.has(id)
        && !!target && serverNodeIds.has(edge.target)
        && (target.parentNodeId ?? null) !== edge.source
        && (nodes[edge.target]?.parentNodeId ?? null) !== edge.source
        && !pendingUpserts.has(id);
      if (endpointLeft || reparented) {
        builder.push(local.id, 'removedEdgeIds', id);
        continue;
      }
      edges.push(edge);
    }
    const heldEdges = new Set(edges.map(serializedEdgeId));
    for (const [id, edge] of serverEdges) {
      if (heldEdges.has(id) || pending.edgeIds.has(id) || !members.has(edge.source) || !members.has(edge.target)) continue;
      edges.push(edge);
      heldEdges.add(id);
      builder.push(local.id, 'edges', edge);
    }

    const changedLists = removedTrees.size > 0 || trees.length !== local.trees.length || trees.some((tree, index) => tree !== local.trees[index])
      || chatIds.length !== local.chatIds.length || edges.length !== local.edges.length
      || edges.some((edge, index) => edge !== local.edges[index]);
    if (changedLists) patchProject({ trees, chatIds, edges });

    // The active tree stays; one that is gone falls back to the backend's
    // choice (already durable) or the most recent listed tree.
    if (next.activeTreeId && !next.trees.some((tree) => tree.id === next.activeTreeId)) {
      const listed = (id: string | null) => !!id && next.trees.some((tree) => tree.id === id && isListedThread(tree, nodes[tree.rootNodeId]));
      if (listed(server.activeTreeId)) {
        patchProject({ activeTreeId: server.activeTreeId });
        builder.for(local.id).workspace = { ...builder.for(local.id).workspace, activeTreeId: server.activeTreeId };
      } else {
        patchProject({ activeTreeId: pickLandingTreeId(next.trees, nodes) });
      }
    }
    return next;
  }
}
