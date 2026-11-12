import { activeTreeRootNodeId, descendants, findTreeIdForNode, resolveBranchParent, storedTreeIdForNode, type TreeEdge } from './tree';

/** The lookup before it was indexed: a full rescan of trees and edges per call. */
function referenceFindTreeIdForNode(nodeId: string, project: { trees: Array<{ id: string; rootNodeId: string }>; edges: readonly TreeEdge[] }): string | null {
  const asRoot = project.trees.find((t) => t.rootNodeId === nodeId);
  if (asRoot) return asRoot.id;
  const parentOf = new Map<string, string>();
  for (const e of project.edges) {
    if (e.kind !== undefined && e.kind !== 'branch') continue;
    parentOf.set(e.target, e.source);
  }
  const seen = new Set<string>();
  let cur: string | undefined = nodeId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const matched = project.trees.find((t) => t.rootNodeId === cur);
    if (matched) return matched.id;
    cur = parentOf.get(cur);
  }
  return null;
}

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe('findTreeIdForNode', () => {
  const trees = [{ id: 't1', rootNodeId: 'r1' }, { id: 't2', rootNodeId: 'r2' }];
  const edges: TreeEdge[] = [
    { source: 'r1', target: 'a' },
    { source: 'a', target: 'b', kind: 'branch' },
    { source: 'r2', target: 'c' },
    // A merge node hangs on its branch parent's tree, not its merge source's.
    { source: 'b', target: 'm', kind: 'merge' },
    { source: 'c', target: 'm' },
    // Merges, links and digest sources alone attach nothing.
    { source: 'b', target: 'merge-only', kind: 'merge' },
    { source: 'r1', target: 'linked', kind: 'link' },
    { source: 'digest', target: 'a', kind: 'digest-source' },
    // A node with two branch parents takes the last edge's.
    { source: 'r1', target: 'twice' },
    { source: 'r2', target: 'twice' },
    // A branch cycle reaching no root.
    { source: 'x', target: 'y' },
    { source: 'y', target: 'x' },
  ];
  const project = { trees, edges };

  it('walks branch edges up to a tree root', () => {
    const ids = ['r1', 'r2', 'a', 'b', 'c', 'm', 'merge-only', 'linked', 'digest', 'twice', 'x', 'y', 'unknown'];
    expect(Object.fromEntries(ids.map((id) => [id, findTreeIdForNode(id, project)]))).toEqual({
      r1: 't1', r2: 't2', a: 't1', b: 't1', c: 't2', m: 't2', 'merge-only': null, linked: null, digest: null, twice: 't2', x: null, y: null, unknown: null,
    });
  });

  it('answers as the full rescan did on random graphs with merges, links, cycles, orphans and shared roots', () => {
    const kinds: Array<TreeEdge['kind']> = [undefined, 'branch', 'branch', 'merge', 'link', 'digest-source'];
    for (let round = 0; round < 200; round += 1) {
      const rand = seeded(round + 1);
      const nodeCount = 2 + Math.floor(rand() * 40);
      const ids = Array.from({ length: nodeCount }, (_, i) => `n${i}`);
      const pick = () => ids[Math.floor(rand() * ids.length)];
      const trees = Array.from({ length: 1 + Math.floor(rand() * 8) }, (_, i) => ({ id: `t${i}`, rootNodeId: pick() }));
      const edges: TreeEdge[] = Array.from({ length: Math.floor(rand() * nodeCount * 1.5) }, () => ({
        source: pick(), target: pick(), kind: kinds[Math.floor(rand() * kinds.length)],
      }));
      const project = { trees, edges };
      // Query in a random order, twice, so answers memoized by one walk are
      // checked when another walk reads them.
      const order = [...ids, 'missing', ''].sort(() => rand() - 0.5);
      for (const id of [...order, ...order]) {
        expect(findTreeIdForNode(id, project), `round ${round}, node ${id}`).toBe(referenceFindTreeIdForNode(id, project));
      }
    }
  });

  it('follows a changed topology, including a push into the same arrays', () => {
    const trees = [{ id: 't1', rootNodeId: 'r1' }];
    const edges: TreeEdge[] = [{ source: 'r1', target: 'a' }];
    expect(findTreeIdForNode('b', { trees, edges })).toBeNull();
    // Replaced arrays, as every reducer writes them.
    const branched = [...edges, { source: 'a', target: 'b' }];
    expect(findTreeIdForNode('b', { trees, edges: branched })).toBe('t1');
    const moved = [{ id: 't2', rootNodeId: 'b' }, ...trees];
    expect(findTreeIdForNode('b', { trees: moved, edges: branched })).toBe('t2');
    // The earlier arrays keep their own answers.
    expect(findTreeIdForNode('b', { trees, edges })).toBeNull();
    // An in-place push must not be answered from the old index either.
    edges.push({ source: 'a', target: 'b' });
    expect(findTreeIdForNode('b', { trees, edges })).toBe('t1');
    trees.unshift({ id: 't3', rootNodeId: 'b' });
    expect(findTreeIdForNode('b', { trees, edges })).toBe('t3');
  });
});

describe('storedTreeIdForNode', () => {
  const project = { trees: [{ id: 't1', rootNodeId: 'r' }], edges: [{ source: 'r', target: 'a' }] };

  it('keeps a node without branch edges in its nearest reachable ancestor\'s tree', () => {
    // x was trashed under a; y was trashed under x before it.
    const nodes = { r: {}, a: { parentNodeId: 'r' }, x: { parentNodeId: 'a' }, y: { parentNodeId: 'x' } };
    expect(storedTreeIdForNode('x', project, nodes)).toBe('t1');
    expect(storedTreeIdForNode('y', project, nodes)).toBe('t1');
    expect(storedTreeIdForNode('a', project, nodes)).toBe('t1');
  });

  it('leaves a node with no reachable ancestor in no tree, also on a parent cycle', () => {
    expect(storedTreeIdForNode('old-root', project, { 'old-root': {} })).toBeNull();
    expect(storedTreeIdForNode('p', project, { p: { parentNodeId: 'q' }, q: { parentNodeId: 'p' } })).toBeNull();
  });
});

describe('descendants', () => {
  it('does not loop forever on cyclic edges', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ];
    const d = descendants('a', edges);
    expect(d).toEqual(new Set(['b']));
  });
});

describe('activeTreeRootNodeId', () => {
  const trees = [{ id: 't1', rootNodeId: 'r1' }, { id: 't2', rootNodeId: 'r2' }];

  it('returns the root of the active tree, not the first tree', () => {
    expect(activeTreeRootNodeId({ activeTreeId: 't2', trees })).toBe('r2');
  });

  it('returns null without a project, an active tree, or a matching tree', () => {
    expect(activeTreeRootNodeId(null)).toBeNull();
    expect(activeTreeRootNodeId(undefined)).toBeNull();
    expect(activeTreeRootNodeId({ activeTreeId: null, trees })).toBeNull();
    expect(activeTreeRootNodeId({ activeTreeId: 'archived', trees })).toBeNull();
  });
});

describe('resolveBranchParent', () => {
  const project = {
    trees: [{ id: 't1', rootNodeId: 'r1' }, { id: 't2', rootNodeId: 'r2' }],
    edges: [{ source: 'r1', target: 'a' }, { source: 'r2', target: 'b' }],
  };
  const nodes = {
    r1: { kind: 'chat' }, a: { kind: 'chat' }, r2: { kind: 'chat' }, b: { kind: 'chat' },
    gone: { kind: 'chat', deletedAt: 1 },
    digest: { kind: 'digest', digest: { sources: ['gone', 'b', 'a'] } },
    orphanDigest: { kind: 'digest', digest: { sources: ['gone'] } },
    file: { kind: 'artifact' },
  };

  it('branches a chat from itself', () => {
    expect(resolveBranchParent('a', project, nodes)).toEqual({ branchParentNodeId: 'a' });
  });

  it('branches a digest from the root of its first live source\'s thread, with the digest as context', () => {
    expect(resolveBranchParent('digest', project, nodes)).toEqual({ branchParentNodeId: 'r2', contextFromNodeId: 'digest' });
  });

  it('refuses a digest without a live source, another kind of node, or an unknown id', () => {
    expect(resolveBranchParent('orphanDigest', project, nodes)).toBeNull();
    expect(resolveBranchParent('file', project, nodes)).toBeNull();
    expect(resolveBranchParent('missing', project, nodes)).toBeNull();
  });
});
