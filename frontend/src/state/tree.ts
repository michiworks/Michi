export interface TreeEdge {
  source: string;
  target: string;
  /**
   * Optional edge kind. 'branch' (or undefined) = parent→child tree edge;
   * 'merge' = multi-source merge node reference; 'link' = user-drawn
   * cross-reference; 'digest-source' = digest node references a chat node
   * as a source. Only 'branch'/undefined edges participate in tree walks.
   */
  kind?: 'branch' | 'merge' | 'link' | 'digest-source';
}

export interface TreeNode {
  nodeId: string;
  depth: number;
  children: TreeNode[];
}

/**
 * Predicate signature used by tree walkers to skip soft-deleted nodes. The
 * renderer passes `(id) => !nodes[id]?.deletedAt`; tree walkers drop any
 * edge whose source or target is dead, so deleted subtrees disappear from
 * the structure view without needing a full copy of the edge list.
 */
export type NodeAlive = (nodeId: string) => boolean;

/** A parent→child tree edge: kind 'branch' or none. Merge, link and digest-source edges are not. */
export function isBranchEdge(e: Pick<TreeEdge, 'kind'>): boolean {
  return e.kind === undefined || e.kind === 'branch';
}

/**
 * Each node's children over branch edges, both ends alive, in edge order.
 * Build it once for callers that walk several trees over the same edges.
 */
export function buildBranchChildrenOf(
  edges: readonly TreeEdge[],
  isAlive?: NodeAlive,
): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const e of edges) {
    if (!isBranchEdge(e)) continue;
    if (isAlive && (!isAlive(e.source) || !isAlive(e.target))) continue;
    const arr = map.get(e.source);
    if (arr) arr.push(e.target);
    else map.set(e.source, [e.target]);
  }
  return map;
}

/**
 * Build a tree rooted at `rootId` using a DFS traversal of the edges.
 * Merge edges (kind='merge') are ignored so multi-parent merge nodes don't
 * double up in the structure tree. Orphan edges (source unreachable from
 * the root) are naturally ignored by the DFS.
 */
export function buildTree(
  rootId: string,
  edges: readonly TreeEdge[],
  isAlive?: NodeAlive,
): TreeNode {
  const childrenOf = buildBranchChildrenOf(edges, isAlive);

  const visited = new Set<string>();
  const visit = (nodeId: string, depth: number): TreeNode => {
    visited.add(nodeId);
    const childIds = (childrenOf.get(nodeId) ?? []).filter((cid) => !visited.has(cid));
    return {
      nodeId,
      depth,
      children: childIds.map((cid) => visit(cid, depth + 1)),
    };
  };

  return visit(rootId, 0);
}

/**
 * Collect all nodeIds reachable from `rootId` via outgoing branch edges,
 * excluding `rootId` itself. Merge edges are ignored so deleting a
 * merge node doesn't cascade-delete its sources (and vice versa).
 * Cycle-safe.
 */
export function descendants(
  rootId: string,
  edges: readonly TreeEdge[],
  isAlive?: NodeAlive,
): Set<string> {
  const childrenOf = buildBranchChildrenOf(edges, isAlive);
  const out = new Set<string>();
  const stack = [...(childrenOf.get(rootId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id) || id === rootId) continue;
    out.add(id);
    const kids = childrenOf.get(id);
    if (kids) stack.push(...kids);
  }
  return out;
}

type TreeTopology = { trees: ReadonlyArray<{ id: string; rootNodeId: string }>; edges: readonly TreeEdge[] };

/*
 * Lookups built once per array: a workspace's edges and trees are replaced,
 * never changed in place, so a node's tree costs its depth, not a pass over
 * every edge. Each remembers the length it was built at, so a push into
 * either array still rebuilds it instead of serving it stale.
 */
const branchParents = new WeakMap<readonly TreeEdge[], { length: number; map: ReadonlyMap<string, string> }>();
const treeRoots = new WeakMap<ReadonlyArray<{ id: string; rootNodeId: string }>, { length: number; map: ReadonlyMap<string, string> }>();

/** Each node's parent over branch edges; with two, the last edge's. */
export function branchParentOf(edges: readonly TreeEdge[]): ReadonlyMap<string, string> {
  const cached = branchParents.get(edges);
  if (cached && cached.length === edges.length) return cached.map;
  const map = new Map<string, string>();
  for (const e of edges) if (isBranchEdge(e)) map.set(e.target, e.source);
  branchParents.set(edges, { length: edges.length, map });
  return map;
}

/** Root node id → its tree's id; the first tree wins, as `trees.find` returns. */
function treeIdByRoot(trees: ReadonlyArray<{ id: string; rootNodeId: string }>): ReadonlyMap<string, string> {
  const cached = treeRoots.get(trees);
  if (cached && cached.length === trees.length) return cached.map;
  const map = new Map<string, string>();
  for (const tree of trees) if (!map.has(tree.rootNodeId)) map.set(tree.rootNodeId, tree.id);
  treeRoots.set(trees, { length: trees.length, map });
  return map;
}

interface TreeIndex {
  rootTree: ReadonlyMap<string, string>;
  parentOf: ReadonlyMap<string, string>;
  /** Answers found so far, filled lazily per walked path. */
  resolved: Map<string, string | null>;
}

const treeIndexes = new WeakMap<readonly TreeEdge[], WeakMap<object, TreeIndex>>();

/**
 * The index for this exact `trees` + `edges` pair. Every topology change
 * (branch, move, archive, trash, a new thread) replaces one of the two
 * arrays, or changes its length, which rebuilds the lookups it holds, so a
 * cached answer is never served after the topology it came from has changed.
 * Node fields (deletion, title, messages) are not in it: callers read those
 * fresh from the node map on every call.
 */
function treeIndexFor(project: TreeTopology): TreeIndex {
  const rootTree = treeIdByRoot(project.trees);
  const parentOf = branchParentOf(project.edges);
  let byTrees = treeIndexes.get(project.edges);
  if (!byTrees) {
    byTrees = new WeakMap();
    treeIndexes.set(project.edges, byTrees);
  }
  const cached = byTrees.get(project.trees);
  if (cached && cached.rootTree === rootTree && cached.parentOf === parentOf) return cached;
  const index: TreeIndex = { rootTree, parentOf, resolved: new Map() };
  byTrees.set(project.trees, index);
  return index;
}

/**
 * Locate which tree a node belongs to by walking parent branch edges back
 * to a root that matches one of `project.trees`. Merge / link / digest-source
 * edges are ignored so merge nodes stay attached to their primary-branch
 * tree. Returns null if the node is not reachable from any root.
 *
 * Called per node inside per-tree loops (the @ mention lists), so the walk
 * runs over an index built once per topology rather than rescanning every
 * tree and edge for each node.
 */
export function findTreeIdForNode(nodeId: string, project: TreeTopology): string | null {
  const index = treeIndexFor(project);
  const known = index.resolved.get(nodeId);
  if (known !== undefined) return known;
  const direct = index.rootTree.get(nodeId);
  if (direct !== undefined) {
    index.resolved.set(nodeId, direct);
    return direct;
  }
  // Every node on one walk has the walk's answer: the parent chain from any
  // of them is the rest of the same chain.
  const path: string[] = [];
  const seen = new Set<string>();
  let found: string | null = null;
  let cur: string | undefined = nodeId;
  while (cur && !seen.has(cur)) {
    const memo = index.resolved.get(cur);
    if (memo !== undefined) { found = memo; break; }
    seen.add(cur);
    path.push(cur);
    const matched = index.rootTree.get(cur);
    if (matched !== undefined) { found = matched; break; }
    cur = index.parentOf.get(cur);
  }
  for (const id of path) index.resolved.set(id, found);
  return found;
}

/**
 * The tree a node's row is stored in. Trash and Archive drop a node's branch
 * edges but keep its parent, and the backend keeps that node in its parent's
 * tree (nodePlacement.resolveNodeTree: workspace commands refuse a child outside it).
 * So a node no branch edge reaches takes the tree of its nearest ancestor one
 * does. A node with no such ancestor (a trashed tree root) stays in no tree.
 */
export function storedTreeIdForNode(
  nodeId: string,
  project: { trees: Array<{ id: string; rootNodeId: string }>; edges: readonly TreeEdge[] },
  nodes: Readonly<Record<string, { parentNodeId?: string } | undefined>>,
): string | null {
  const seen = new Set<string>();
  let cur: string | undefined = nodeId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const reached = findTreeIdForNode(cur, project);
    if (reached) return reached;
    cur = nodes[cur]?.parentNodeId;
  }
  return null;
}

/**
 * Where a chat branched from `parentNodeId` hangs. A chat is its own parent.
 * A digest is in no thread, so its branches go under the root of its first
 * live source's thread (else they reach no sidebar row or Map node) and take
 * the digest as their first send's context. Any other node gets no branch.
 */
export function resolveBranchParent(
  parentNodeId: string,
  project: { trees: Array<{ id: string; rootNodeId: string }>; edges: readonly TreeEdge[] } | undefined,
  nodes: Readonly<Record<string, { kind: string; deletedAt?: number; digest?: { sources: readonly string[] } } | undefined>>,
): { branchParentNodeId: string; contextFromNodeId?: string } | null {
  const parent = nodes[parentNodeId];
  if (parent?.kind === 'chat') return { branchParentNodeId: parentNodeId };
  if (parent?.kind !== 'digest' || !parent.digest || !project) return null;
  const liveSourceId = parent.digest.sources.find((id) => {
    const source = nodes[id];
    return !!source && !source.deletedAt;
  });
  const treeId = liveSourceId ? findTreeIdForNode(liveSourceId, project) : null;
  const rootNodeId = project.trees.find((tree) => tree.id === treeId)?.rootNodeId;
  return rootNodeId && nodes[rootNodeId]
    ? { branchParentNodeId: rootNodeId, contextFromNodeId: parentNodeId }
    : null;
}

/**
 * Returns the active tree's root nodeId, or `null` if the workspace has no
 * active tree (e.g. every tree was archived). Callers previously used
 * `project.chatIds[0]`; this is the forest-aware replacement.
 */
export function activeTreeRootNodeId(
  project: { activeTreeId: string | null; trees: Array<{ id: string; rootNodeId: string }> } | null | undefined,
): string | null {
  if (!project || !project.activeTreeId) return null;
  const t = project.trees.find((x) => x.id === project.activeTreeId);
  return t ? t.rootNodeId : null;
}
