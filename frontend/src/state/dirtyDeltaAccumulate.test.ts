import { describe, it, expect } from 'vitest';
import {
  accumulateWorkspaceDirtyDelta,
  buildExplicitWorkspaceCommands,
  emptyWorkspaceDirtyDelta,
  serializeEdgeRow,
  serializedEdgeId,
  type WorkspaceDirtyDelta,
} from './workspacePersistence';
import { backendEntityId, mapBackendPayload } from '../config/backendIdentity';
import type { ChatNodeState, Project, ProjectEdge, Tree, ArtifactEntry } from './chatTypes';

function makeProject(id: string, nodeIds: string[], extras: Partial<Project> = {}): Project {
  return {
    id,
    name: 'Test',
    chatIds: nodeIds,
    edges: [],
    createdAt: 1_716_800_000_000,
    trees: [{ id: 't1', rootNodeId: nodeIds[0] ?? 'n1', createdAt: 1, lastActiveAt: 1 }],
    activeTreeId: 't1',
    artifacts: [],
    ...extras,
  } as Project;
}

function edge(source: string, target: string, kind: ProjectEdge['kind'] = 'branch'): ProjectEdge {
  return { source, target, kind };
}

function tree(id: string): Tree {
  return { id, rootNodeId: 'n1', createdAt: 1, lastActiveAt: 1 };
}

function ctx(id: string): ArtifactEntry {
  return { id, name: id, filePath: `/${id}`, source: 'user', createdAt: 1, updatedAt: 1 };
}

/** Assert the core invariant: no id in both upsert and delete sets. */
function assertNoOverlap(d: WorkspaceDirtyDelta) {
  for (const id of d.edgeUpsertIds) {
    expect(d.edgeDeleteIds.has(id), `edge ${id} in both upsert and delete`).toBe(false);
  }
  for (const id of d.treeUpsertIds) {
    expect(d.treeDeleteIds.has(id), `tree ${id} in both upsert and delete`).toBe(false);
  }
  for (const id of d.contextUpsertIds) {
    expect(d.contextDeleteIds.has(id), `context ${id} in both upsert and delete`).toBe(false);
  }
}

// Convenience: run two accumulate calls in sequence (simulating two ticks).
function accumulate2(
  tick1: { prev: Project | undefined; cur: Project; prevNodes?: Record<string, ChatNodeState>; curNodes?: Record<string, ChatNodeState> },
  tick2: { prev: Project; cur: Project; prevNodes?: Record<string, ChatNodeState>; curNodes?: Record<string, ChatNodeState> },
): WorkspaceDirtyDelta {
  const empty: Record<string, ChatNodeState> = {};
  const d1 = accumulateWorkspaceDirtyDelta(
    tick1.prev, tick1.cur,
    tick1.prevNodes ?? empty, tick1.curNodes ?? empty,
    emptyWorkspaceDirtyDelta(),
  );
  return accumulateWorkspaceDirtyDelta(
    tick2.prev, tick2.cur,
    tick2.prevNodes ?? empty, tick2.curNodes ?? empty,
    d1,
  );
}

// ---------------------------------------------------------------------------
// Invariant: upsert ∩ delete = ∅ after any sequence
// ---------------------------------------------------------------------------

describe('accumulateWorkspaceDirtyDelta — invariant', () => {
  it('no id ever appears in both upsert and delete sets (single tick)', () => {
    const prev = makeProject('ws1', [], { edges: [edge('a', 'b')], trees: [tree('t1')], artifacts: [ctx('c1')] });
    const cur  = makeProject('ws1', [], { edges: [edge('c', 'd')], trees: [tree('t2')], artifacts: [ctx('c2')] });
    const d = accumulateWorkspaceDirtyDelta(prev, cur, {}, {}, emptyWorkspaceDirtyDelta());
    assertNoOverlap(d);
  });
});

// ---------------------------------------------------------------------------
// Edges — delete-then-re-add and add-then-delete
// ---------------------------------------------------------------------------

describe('accumulateWorkspaceDirtyDelta — edges', () => {
  it('add-then-delete: ends in deletes only (regression for the bug)', () => {
    const eId = serializedEdgeId(edge('a', 'b'));
    const base  = makeProject('ws1', [], { edges: [] });
    const after = makeProject('ws1', [], { edges: [edge('a', 'b')] });

    const d = accumulate2(
      { prev: base, cur: after },   // tick 1: add edge
      { prev: after, cur: base },   // tick 2: delete edge
    );

    expect(d.edgeDeleteIds.has(eId)).toBe(true);
    expect(d.edgeUpsertIds.has(eId)).toBe(false);
    assertNoOverlap(d);
  });
});

describe('remote workspace edges', () => {
  // Real id shapes: connections are remote-<uuid>, nodes n-<uuid>.
  const connection = 'remote-6f0c2f0e-5a52-4d0b-9a7e-0b1c2d3e4f50';
  const root = backendEntityId(connection, 'n-1b2c3d4e-0000-4000-8000-000000000001');
  const branch = backendEntityId(connection, 'n-1b2c3d4e-0000-4000-8000-000000000002');
  const removed = edge(root, branch);
  const project = makeProject(backendEntityId(connection, 'ws-r'), [root, branch], { backendConnectionId: connection, edges: [removed] });

  it('deletes a removed edge by the id its backend stores', () => {
    const cur = { ...project, edges: [] };
    const delta = accumulateWorkspaceDirtyDelta(project, cur, {}, {}, emptyWorkspaceDirtyDelta());
    const { commands } = buildExplicitWorkspaceCommands(cur, {}, delta, new Map());
    const stored = serializeEdgeRow(project, removed).id;

    expect(mapBackendPayload(commands, connection, 'server')).toEqual([{ type: 'edge.delete', payload: { id: stored } }]);
    expect(stored).toBe('branch-n-1b2c3d4e-0000-4000-8000-000000000001-n-1b2c3d4e-0000-4000-8000-000000000002');
    // The backend refuses longer entity ids.
    expect(stored.length).toBeLessThanOrEqual(160);
  });

  it('upserts an added edge under the same id', () => {
    const before = { ...project, edges: [] };
    const delta = accumulateWorkspaceDirtyDelta(before, project, {}, {}, emptyWorkspaceDirtyDelta());
    const { commands } = buildExplicitWorkspaceCommands(project, {}, delta, new Map());
    expect(commands.map((command) => [command.type, command.payload.id])).toEqual([['edge.upsert', serializedEdgeId(removed)]]);
    expect([...delta.edgeUpsertIds]).toEqual([serializeEdgeRow(project, removed).id]);
  });
});
