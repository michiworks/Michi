import type { ChatNodeState, Project, ProjectEdge, Tree } from './chatTypes';
import { serializedEdgeId } from './edgeIds';

/**
 * What a structure re-read (structureSync) put into one workspace of the
 * store. The backend already holds all of it, so the dirty tracker must not
 * write it back: once a scan sees it rendered, the tracker's baseline is
 * rebased onto it (rebaseOnAdoption) and only local edits remain to write.
 * Edge ids are serialized ids (serializedEdgeId).
 */

/** Serialized row columns a re-read compares with what this window last confirmed. */
export type WorkspaceGuardField = 'name' | 'deleted_at' | 'archived_at' | 'pinned_at';
export type TreeGuardField = 'name' | 'archived_at' | 'pinned_at' | 'root_node_id';
export type NodeGuardField = 'title' | 'parent_node_id' | 'deleted_at' | 'deletion_group_id' | 'trim_snapshot' | 'pinned_at';

export const WORKSPACE_ADOPTED_FIELDS = [
  ['name', 'name'], ['deletedAt', 'deleted_at'], ['archivedAt', 'archived_at'], ['pinnedAt', 'pinned_at'],
] as const satisfies ReadonlyArray<readonly [keyof Project, WorkspaceGuardField]>;
export const TREE_ADOPTED_FIELDS = [
  ['name', 'name'], ['archivedAt', 'archived_at'], ['pinnedAt', 'pinned_at'], ['rootNodeId', 'root_node_id'],
] as const satisfies ReadonlyArray<readonly [keyof Tree, TreeGuardField]>;
export const NODE_ADOPTED_FIELDS = [
  ['title', 'title'], ['parentNodeId', 'parent_node_id'], ['deletedAt', 'deleted_at'],
  ['deletionGroupId', 'deletion_group_id'], ['trimSnapshot', 'trim_snapshot'], ['pinnedAt', 'pinned_at'],
] as const satisfies ReadonlyArray<readonly [keyof ChatNodeState, NodeGuardField]>;

export type AdoptedTreeField = (typeof TREE_ADOPTED_FIELDS)[number][0];
export type AdoptedNodeField = (typeof NODE_ADOPTED_FIELDS)[number][0] | 'projectId';

/** A tree as put into the store; `fields` came from the backend (a new tree: all of it). */
export interface AdoptedTree {
  tree: Tree;
  fields: readonly AdoptedTreeField[];
  isNew?: boolean;
}

/** A node as put into the store; `fields` came from the backend (a new node: all of it). */
export interface AdoptedNode {
  node: ChatNodeState;
  fields: readonly AdoptedNodeField[];
  isNew?: boolean;
}

export interface StructureAdoption {
  projectId: string;
  /** When the backend read behind it began: what it brings was durable by then. */
  readStartedAt: number;
  /** Workspace fields taken from the backend; a present key with `undefined` clears the field. */
  workspace?: Partial<Pick<Project, 'name' | 'deletedAt' | 'archivedAt' | 'pinnedAt' | 'activeTreeId'>>;
  trees?: readonly AdoptedTree[];
  removedTreeIds?: readonly string[];
  chatIds?: readonly string[];
  removedChatIds?: readonly string[];
  /** Edges added, as put into the store. */
  edges?: readonly ProjectEdge[];
  removedEdgeIds?: readonly string[];
  nodes?: readonly AdoptedNode[];
  /** The whole workspace is new to the store. */
  newProject?: boolean;
}

export type AdoptedWorkspaceField = keyof NonNullable<StructureAdoption['workspace']>;

export interface AdoptionRebase {
  prevProject: Project | undefined;
  prevNodes: Record<string, ChatNodeState>;
  /** What this scan saw rendered: the persistence layer takes it as confirmed. */
  landed: {
    workspaceFields: AdoptedWorkspaceField[];
    trees: AdoptedTree[];
    nodes: AdoptedNode[];
  };
  /** What has not been rendered yet; null when nothing is left. */
  remaining: StructureAdoption | null;
}

/** What one confirmed tree move puts into the store, objects included. */
export interface TreeMoveInStore {
  from: Project;
  to: Project;
  tree: Tree;
  /** Threads that go with the tree (they leave `from`). */
  nodeIds: ReadonlySet<string>;
  /** `from`'s edges that leave with them: every edge touching a moving thread. */
  removedEdges: readonly ProjectEdge[];
  /** The edges `to` gains (both ends move), as put into the store. */
  addedEdges: readonly ProjectEdge[];
  /** The moved threads as put into the store (projectId: `to`). */
  movedNodes: readonly ChatNodeState[];
}

/**
 * Adoptions for a tree move the backend has already made (POST
 * /trees/:id/move): neither workspace writes it again. The workspace left
 * would refuse deletes of rows that now belong to the destination.
 */
export function treeMoveAdoptions(move: TreeMoveInStore, confirmedAt: number): StructureAdoption[] {
  const { from, to, tree, nodeIds } = move;
  const held = new Set(to.chatIds);
  return [
    {
      projectId: from.id,
      readStartedAt: confirmedAt,
      removedTreeIds: [tree.id],
      removedChatIds: from.chatIds.filter((id) => nodeIds.has(id)),
      removedEdgeIds: move.removedEdges.map(serializedEdgeId),
    },
    {
      projectId: to.id,
      readStartedAt: confirmedAt,
      trees: [{ tree, fields: TREE_ADOPTED_FIELDS.map(([field]) => field), isNew: true }],
      chatIds: [...nodeIds].filter((id) => !held.has(id)),
      edges: move.addedEdges,
      nodes: move.movedNodes.map((node) => ({ node, fields: ['projectId'] })),
    },
  ];
}

function sameFields<T extends object>(a: T, b: T, fields: readonly (keyof T)[]): boolean {
  return fields.every((field) => a[field] === b[field]);
}

/** a and b agree on every key outside `fields`. */
function sameOutside<T extends object>(a: T, b: T, fields: readonly (keyof T)[]): boolean {
  const skip = new Set<PropertyKey>(fields);
  const keys = new Set<PropertyKey>([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (skip.has(key)) continue;
    if ((a as Record<PropertyKey, unknown>)[key] !== (b as Record<PropertyKey, unknown>)[key]) return false;
  }
  return true;
}

function pick<T extends object>(source: T, fields: readonly (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const field of fields) out[field] = source[field];
  return out;
}

/**
 * Apply the adopted fields of `adopted` to the baseline's copy. When the
 * baseline differs from it only in those fields, take the adopted object
 * itself, so an untouched entity reads as unchanged; otherwise keep the
 * baseline's other fields, so an edit not yet scanned still reads as one.
 */
function rebased<T extends object>(base: T | undefined, adopted: T, fields: readonly (keyof T)[]): T {
  if (!base || sameOutside(base, adopted, fields)) return adopted;
  return { ...base, ...pick(adopted, fields) };
}

/**
 * Rebase the tracker's last-scanned workspace (`prev`) onto the parts of an
 * adoption the scanned state (`cur`) shows. A part shows when the store holds
 * the adopted value; a part a later local edit changed again stays pending,
 * so that edit is still written. Parts not yet rendered are returned in
 * `remaining` for the next scan.
 */
export function rebaseOnAdoption(
  prev: Project | undefined,
  prevNodes: Record<string, ChatNodeState>,
  cur: Project | undefined,
  curNodes: Record<string, ChatNodeState>,
  adoption: StructureAdoption,
): AdoptionRebase {
  const landed: AdoptionRebase['landed'] = { workspaceFields: [], trees: [], nodes: [] };
  if (!cur) return { prevProject: prev, prevNodes, landed, remaining: adoption };

  if (adoption.newProject) {
    // As hydration does: the rendered workspace is the clean baseline.
    const nodes = { ...prevNodes };
    for (const nodeId of cur.chatIds) if (curNodes[nodeId]) nodes[nodeId] = curNodes[nodeId];
    landed.workspaceFields = ['name', 'deletedAt', 'archivedAt', 'pinnedAt', 'activeTreeId'];
    landed.trees = cur.trees.map((tree) => ({ tree, fields: TREE_ADOPTED_FIELDS.map(([field]) => field), isNew: true }));
    landed.nodes = cur.chatIds.flatMap((nodeId) => (curNodes[nodeId]
      ? [{ node: curNodes[nodeId], fields: [], isNew: true }]
      : []));
    return { prevProject: cur, prevNodes: nodes, landed, remaining: null };
  }
  // A workspace the last scan never held is written whole either way.
  if (!prev) return { prevProject: prev, prevNodes, landed, remaining: null };

  const remaining: StructureAdoption = { projectId: adoption.projectId, readStartedAt: adoption.readStartedAt };
  let next: Project = prev;
  const edit = (patch: Partial<Project>) => { next = { ...next, ...patch }; };

  if (adoption.workspace) {
    const pending: Record<string, unknown> = {};
    const patch: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(adoption.workspace) as Array<[AdoptedWorkspaceField, unknown]>) {
      if (cur[field] === value) {
        patch[field] = value;
        landed.workspaceFields.push(field);
      } else {
        pending[field] = value;
      }
    }
    if (landed.workspaceFields.length > 0) edit(patch as Partial<Project>);
    if (Object.keys(pending).length > 0) remaining.workspace = pending as StructureAdoption['workspace'];
  }

  if (adoption.trees?.length || adoption.removedTreeIds?.length) {
    const curTrees = new Map(cur.trees.map((tree) => [tree.id, tree] as const));
    const shown = (adoption.trees ?? []).filter((entry) => {
      const held = curTrees.get(entry.tree.id);
      return !!held && sameFields(held, entry.tree, entry.fields);
    });
    const gone = (adoption.removedTreeIds ?? []).filter((id) => !curTrees.has(id));
    if (shown.length > 0 || gone.length > 0) {
      const drop = new Set(gone);
      const shownById = new Map(shown.map((entry) => [entry.tree.id, entry] as const));
      const trees = next.trees
        .filter((tree) => !drop.has(tree.id))
        .map((tree) => {
          const entry = shownById.get(tree.id);
          return entry ? rebased(tree, entry.tree, entry.fields) : tree;
        });
      for (const entry of shown) if (!trees.some((tree) => tree.id === entry.tree.id)) trees.push(entry.tree);
      edit({ trees });
      landed.trees.push(...shown);
    }
    const waiting = (adoption.trees ?? []).filter((entry) => !shown.includes(entry));
    const waitingRemovals = (adoption.removedTreeIds ?? []).filter((id) => !gone.includes(id));
    if (waiting.length > 0) remaining.trees = waiting;
    if (waitingRemovals.length > 0) remaining.removedTreeIds = waitingRemovals;
  }

  if (adoption.chatIds?.length || adoption.removedChatIds?.length) {
    const curIds = new Set(cur.chatIds);
    const added = (adoption.chatIds ?? []).filter((id) => curIds.has(id));
    const removed = (adoption.removedChatIds ?? []).filter((id) => !curIds.has(id));
    if (added.length > 0 || removed.length > 0) {
      const drop = new Set(removed);
      const chatIds = next.chatIds.filter((id) => !drop.has(id));
      for (const id of added) if (!chatIds.includes(id)) chatIds.push(id);
      edit({ chatIds });
    }
    const waitingAdds = (adoption.chatIds ?? []).filter((id) => !added.includes(id));
    const waitingRemovals = (adoption.removedChatIds ?? []).filter((id) => !removed.includes(id));
    if (waitingAdds.length > 0) remaining.chatIds = waitingAdds;
    if (waitingRemovals.length > 0) remaining.removedChatIds = waitingRemovals;
  }

  if (adoption.edges?.length || adoption.removedEdgeIds?.length) {
    const curEdges = new Set(cur.edges.map(serializedEdgeId));
    const shown = (adoption.edges ?? []).filter((edge) => curEdges.has(serializedEdgeId(edge)));
    const gone = (adoption.removedEdgeIds ?? []).filter((id) => !curEdges.has(id));
    if (shown.length > 0 || gone.length > 0) {
      const drop = new Set(gone);
      const edges = next.edges.filter((edge) => !drop.has(serializedEdgeId(edge)));
      for (const edge of shown) if (!edges.some((candidate) => serializedEdgeId(candidate) === serializedEdgeId(edge))) edges.push(edge);
      edit({ edges });
    }
    const waiting = (adoption.edges ?? []).filter((edge) => !shown.includes(edge));
    const waitingRemovals = (adoption.removedEdgeIds ?? []).filter((id) => !gone.includes(id));
    if (waiting.length > 0) remaining.edges = waiting;
    if (waitingRemovals.length > 0) remaining.removedEdgeIds = waitingRemovals;
  }

  let nodes = prevNodes;
  if (adoption.nodes?.length) {
    const waiting: AdoptedNode[] = [];
    for (const entry of adoption.nodes) {
      const held = curNodes[entry.node.nodeId];
      if (!held || !sameFields(held, entry.node, entry.fields)) {
        waiting.push(entry);
        continue;
      }
      if (nodes === prevNodes) nodes = { ...prevNodes };
      nodes[entry.node.nodeId] = rebased(prevNodes[entry.node.nodeId], entry.node, entry.fields);
      landed.nodes.push(entry);
    }
    if (waiting.length > 0) remaining.nodes = waiting;
  }

  const left = Object.keys(remaining).length > 2;
  return { prevProject: next, prevNodes: nodes, landed, remaining: left ? remaining : null };
}
