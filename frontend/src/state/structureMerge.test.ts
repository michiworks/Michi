import { describe, expect, it } from 'vitest';
import { hydrateBackendWorkspaces } from './chatHydration';
import type { ChatNodeState, Project } from './chatTypes';
import { reconcileWorkspaceStructure, type StructureEditGuards, type StructureMergeInput } from './structureMerge';
import { backendEntityId } from '../config/backendIdentity';
import { serializedEdgeId } from './workspacePersistence';

interface RawNode {
  id: string;
  tree_id?: string | null;
  parent_node_id?: string | null;
  title?: string | null;
  deleted_at?: number | null;
  deletion_group_id?: string | null;
  created_at?: number;
  scheduled_only_job_id?: string | null;
}

function raw(id: string, spec: {
  name?: string;
  deleted_at?: number | null;
  archived_at?: number | null;
  active_tree_id?: string | null;
  trees?: Array<{ id: string; root: string; name?: string | null; archived_at?: number | null; last_active_at?: number }>;
  nodes?: RawNode[];
  edges?: Array<[string, string, string?]>;
}) {
  return {
    workspace: {
      id, name: spec.name ?? id, created_at: 1, updated_at: 1, settings: null,
      active_tree_id: spec.active_tree_id ?? spec.trees?.[0]?.id ?? null,
      deleted_at: spec.deleted_at ?? null, archived_at: spec.archived_at ?? null, pinned_at: null,
    },
    trees: (spec.trees ?? []).map((tree) => ({
      id: tree.id, workspace_id: id, root_node_id: tree.root, name: tree.name ?? null,
      archived_at: tree.archived_at ?? null, pinned_at: null, last_active_at: tree.last_active_at ?? 1, created_at: 1,
    })),
    nodes: (spec.nodes ?? []).map((node, index) => ({
      id: node.id, workspace_id: id, tree_id: node.tree_id ?? null, parent_node_id: node.parent_node_id ?? null,
      kind: 'chat', title: node.title ?? null, status: 'idle', minimized: 0, spawned_by_agent: 0,
      deleted_at: node.deleted_at ?? null, deletion_group_id: node.deletion_group_id ?? null,
      created_at: node.created_at ?? index + 1, message_count: 0,
      scheduled_only_job_id: node.scheduled_only_job_id ?? null,
    })),
    edges: (spec.edges ?? []).map(([source, target, kind = 'branch']) => ({
      id: `${kind}-${source}-${target}`, workspace_id: id, source_node_id: source, target_node_id: target, kind,
    })),
    messages: [],
    contexts: [],
  };
}

const quiet = (overrides: Partial<StructureEditGuards> = {}): StructureEditGuards => ({
  workspaceFieldEdited: () => false,
  treeFieldEdited: () => false,
  nodeFieldEdited: () => false,
  pendingDeletes: () => ({ treeIds: new Set(), edgeIds: new Set() }),
  pendingEdgeUpserts: () => new Set(),
  heldByBackendBefore: () => false,
  ...overrides,
});

function store(...workspaces: ReturnType<typeof raw>[]) {
  const hydrated = hydrateBackendWorkspaces(workspaces);
  return { projects: hydrated.projects, nodes: hydrated.nodes };
}

function merge(
  local: { projects: Project[]; nodes: Record<string, ChatNodeState> },
  snapshots: Array<[string, ReturnType<typeof raw> | null]>,
  extra: Partial<StructureMergeInput> = {},
) {
  return reconcileWorkspaceStructure({
    currentProjects: local.projects,
    currentNodes: local.nodes,
    snapshots: snapshots.map(([workspaceId, snapshot]) => ({ workspaceId, raw: snapshot })),
    connectionId: 'local',
    removals: { workspaceIds: new Set(), treeIds: new Set(), nodeIds: new Set() },
    readStartedAt: 1_000,
    guards: quiet(),
    ...extra,
  });
}

const base = () => raw('ws-1', {
  name: 'One',
  trees: [{ id: 't1', root: 'n1', last_active_at: 5 }, { id: 't2', root: 'n3', last_active_at: 4 }],
  nodes: [
    { id: 'n1', tree_id: 't1' },
    { id: 'n2', tree_id: 't1', parent_node_id: 'n1' },
    { id: 'n3', tree_id: 't2' },
  ],
  edges: [['n1', 'n2']],
});

describe('reconcileWorkspaceStructure', () => {
  it('takes renames, trash and archive marks without touching live node state or the active tree', () => {
    const local = store(base());
    local.nodes.n2 = {
      ...local.nodes.n2,
      status: 'streaming',
      composerDraft: { value: 'unsent', mentions: [] },
      messages: [{ id: 'm1', role: 'assistant', text: 'live', toolCalls: [], streaming: true }],
    };
    local.projects[0] = { ...local.projects[0], activeTreeId: 't2' };
    const server = base();
    server.workspace.name = 'Renamed';
    server.trees[0].name = 'Thread name';
    server.trees[0].archived_at = 30;
    server.nodes[1].title = 'Child title';
    server.nodes[1].deleted_at = 40;
    server.nodes[1].deletion_group_id = 'del-1';
    server.workspace.active_tree_id = 't1';

    const result = merge(local, [['ws-1', server]])!;
    const project = result.projects[0];
    expect(project.name).toBe('Renamed');
    expect(project.trees.find((tree) => tree.id === 't1')).toMatchObject({ name: 'Thread name', archivedAt: 30 });
    expect(project.activeTreeId).toBe('t2');
    expect(result.nodes.n2).toMatchObject({
      title: 'Child title', deletedAt: 40, deletionGroupId: 'del-1', status: 'streaming',
      composerDraft: { value: 'unsent', mentions: [] },
    });
    expect(result.nodes.n2.messages).toBe(local.nodes.n2.messages);
    expect(result.adoptions).toEqual([expect.objectContaining({
      projectId: 'ws-1',
      readStartedAt: 1_000,
      workspace: { name: 'Renamed' },
      trees: [expect.objectContaining({ fields: ['name', 'archivedAt'] })],
      nodes: [expect.objectContaining({ fields: ['title', 'deletedAt', 'deletionGroupId'] })],
    })]);
    expect(result.removedNodeIds).toEqual([]);
  });

  it('shows a Scheduled-only run another window moved to the workspace, keeping its live state', () => {
    const hidden = base();
    hidden.nodes[2].scheduled_only_job_id = 'job-hidden';
    const local = store(hidden);
    expect(local.nodes.n3.scheduledOnlyJobId).toBe('job-hidden');
    local.nodes.n3 = { ...local.nodes.n3, status: 'streaming' };
    const result = merge(local, [['ws-1', base()]])!;
    expect(result.nodes.n3.scheduledOnlyJobId).toBeNull();
    expect(result.nodes.n3.status).toBe('streaming');
    expect(result.adoptions).toEqual([]);
  });

  it('keeps what this window changed and has not seen confirmed', () => {
    const local = store(base());
    local.projects[0] = { ...local.projects[0], name: 'Mine' };
    const server = base();
    server.workspace.name = 'Theirs';
    server.workspace.archived_at = 9;
    server.nodes[0].title = 'Their title';
    const result = merge(local, [['ws-1', server]], {
      guards: quiet({
        workspaceFieldEdited: (_project, field) => field === 'name',
        nodeFieldEdited: (_project, _nodes, nodeId, field) => nodeId === 'n1' && field === 'title',
      }),
    })!;
    expect(result.projects[0]).toMatchObject({ name: 'Mine', archivedAt: 9 });
    expect(result.nodes.n1.title).toBeUndefined();
    expect(result.adoptions[0].workspace).toEqual({ archivedAt: 9 });
  });

  it('brings in new trees and threads as placeholders and leaves the active tree', () => {
    const local = store(base());
    const server = base();
    server.trees.push({ ...server.trees[0], id: 't3', root_node_id: 'n4', last_active_at: 99 });
    server.nodes.push({ ...server.nodes[0], id: 'n4', tree_id: 't3', created_at: 9 });
    server.nodes.push({ ...server.nodes[0], id: 'n5', tree_id: 't1', parent_node_id: 'n2', created_at: 10 });
    server.edges.push({ id: 'branch-n2-n5', workspace_id: 'ws-1', source_node_id: 'n2', target_node_id: 'n5', kind: 'branch' });
    server.workspace.active_tree_id = 't3';

    const result = merge(local, [['ws-1', server]])!;
    const project = result.projects[0];
    expect(project.activeTreeId).toBe('t1');
    expect(project.trees.map((tree) => tree.id)).toEqual(['t1', 't2', 't3']);
    expect(project.chatIds).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    expect(project.edges.map((edge) => `${edge.source}>${edge.target}`)).toEqual(['n1>n2', 'n2>n5']);
    expect(result.nodes.n4).toMatchObject({ projectId: 'ws-1', messagesLoaded: false });
    const adoption = result.adoptions[0];
    expect(adoption.chatIds).toEqual(['n4', 'n5']);
    expect(adoption.trees?.map((entry) => [entry.tree.id, entry.isNew])).toEqual([['t3', true]]);
    expect(adoption.edges?.map((edge) => edge.target)).toEqual(['n5']);
  });

  it('does not bring back a tree or edge this window just removed', () => {
    const local = store(base());
    local.projects[0] = { ...local.projects[0], trees: local.projects[0].trees.filter((tree) => tree.id !== 't2'), edges: [] };
    const result = merge(local, [['ws-1', base()]], {
      guards: quiet({ pendingDeletes: () => ({ treeIds: new Set(['t2']), edgeIds: new Set(['branch-n1-n2']) }) }),
    });
    expect(result).toBeNull();
  });

  it('does not bring back an edge this window just removed from a remote workspace', () => {
    const connection = 'remote-a';
    const id = (raw: string) => backendEntityId(connection, raw);
    const hydrated = hydrateBackendWorkspaces([base()], null, connection);
    const local = { projects: [{ ...hydrated.projects[0], edges: [] }], nodes: hydrated.nodes };
    const removed = { source: id('n1'), target: id('n2'), kind: 'branch' as const };
    // The pending delete names the edge by the id its backend stores.
    expect(serializedEdgeId(removed)).toBe('branch-n1-n2');
    const result = merge(local, [[id('ws-1'), base()]], {
      connectionId: connection,
      guards: quiet({ pendingDeletes: () => ({ treeIds: new Set(), edgeIds: new Set([serializedEdgeId(removed)]) }) }),
    });
    expect(result).toBeNull();
  });

  it('moves a tree that the backend now holds in another re-read workspace', () => {
    const local = store(base(), raw('ws-2', { trees: [], nodes: [] }));
    const source = raw('ws-1', { name: 'One', trees: [{ id: 't2', root: 'n3' }], nodes: [{ id: 'n3', tree_id: 't2' }] });
    const destination = raw('ws-2', {
      trees: [{ id: 't1', root: 'n1' }],
      nodes: [{ id: 'n1', tree_id: 't1' }, { id: 'n2', tree_id: 't1', parent_node_id: 'n1' }],
      edges: [['n1', 'n2']],
    });
    local.projects[0] = { ...local.projects[0], activeTreeId: 't1' };
    source.workspace.active_tree_id = 't2';

    const result = merge(local, [['ws-1', source], ['ws-2', destination]])!;
    const [one, two] = result.projects;
    expect(one.trees.map((tree) => tree.id)).toEqual(['t2']);
    expect(one.chatIds).toEqual(['n3']);
    expect(one.edges).toEqual([]);
    // Its active tree left: the backend's choice takes over.
    expect(one.activeTreeId).toBe('t2');
    expect(two.trees.map((tree) => tree.id)).toEqual(['t1']);
    expect(two.chatIds).toEqual(['n1', 'n2']);
    expect(two.edges.map((edge) => `${edge.source}>${edge.target}`)).toEqual(['n1>n2']);
    expect(result.nodes.n1.projectId).toBe('ws-2');
    expect(result.removedNodeIds).toEqual([]);
    const sourceAdoption = result.adoptions.find((adoption) => adoption.projectId === 'ws-1')!;
    expect(sourceAdoption).toMatchObject({
      removedTreeIds: ['t1'], removedChatIds: ['n1', 'n2'], removedEdgeIds: ['branch-n1-n2'], workspace: { activeTreeId: 't2' },
    });
    const destinationAdoption = result.adoptions.find((adoption) => adoption.projectId === 'ws-2')!;
    expect(destinationAdoption.chatIds).toEqual(['n1', 'n2']);
    expect(destinationAdoption.nodes?.map((entry) => entry.node.nodeId)).toEqual(['n1', 'n2']);
  });

  it('falls back past a hidden run and a thread this window trashed when the active tree moves away', () => {
    const local = store(raw('ws-1', {
      trees: [
        { id: 't1', root: 'n1', last_active_at: 5 }, { id: 't2', root: 'n3', last_active_at: 4 },
        { id: 't3', root: 'n4', last_active_at: 3 }, { id: 't-sched', root: 'n-s', last_active_at: 9 },
      ],
      nodes: [{ id: 'n1', tree_id: 't1' }, { id: 'n3', tree_id: 't2' }, { id: 'n4', tree_id: 't3' }, { id: 'n-s', tree_id: 't-sched', scheduled_only_job_id: 'job-hidden' }],
      active_tree_id: 't1',
    }), raw('ws-2', { trees: [], nodes: [] }));
    // Trashed here; the read began before the backend heard of it.
    local.nodes.n3 = { ...local.nodes.n3, deletedAt: 7, deletionGroupId: 'del-n3' };
    const source = raw('ws-1', {
      trees: [{ id: 't2', root: 'n3', last_active_at: 4 }, { id: 't3', root: 'n4', last_active_at: 3 }, { id: 't-sched', root: 'n-s', last_active_at: 9 }],
      nodes: [{ id: 'n3', tree_id: 't2' }, { id: 'n4', tree_id: 't3' }, { id: 'n-s', tree_id: 't-sched', scheduled_only_job_id: 'job-hidden' }],
      active_tree_id: 't2',
    });
    const destination = raw('ws-2', { trees: [{ id: 't1', root: 'n1' }], nodes: [{ id: 'n1', tree_id: 't1' }] });
    const trashedHere = quiet({ nodeFieldEdited: (_project, _nodes, nodeId, field) => nodeId === 'n3' && (field === 'deleted_at' || field === 'deletion_group_id') });

    const result = merge(local, [['ws-1', source], ['ws-2', destination]], { guards: trashedHere })!;
    expect(result.projects[0].activeTreeId).toBe('t3');
  });

  it('does not move a tree back when this window moved it out since the read', () => {
    const local = store(raw('ws-1', { trees: [], nodes: [] }), raw('ws-2', {
      trees: [{ id: 't1', root: 'n1' }], nodes: [{ id: 'n1', tree_id: 't1' }],
    }));
    const staleSource = raw('ws-1', { trees: [{ id: 't1', root: 'n1' }], nodes: [{ id: 'n1', tree_id: 't1' }] });
    const staleDestination = raw('ws-2', { trees: [], nodes: [] });
    const result = merge(local, [['ws-1', staleSource], ['ws-2', staleDestination]], {
      guards: quiet({ pendingDeletes: (project) => ({ treeIds: new Set(project.id === 'ws-1' ? ['t1'] : []), edgeIds: new Set() }) }),
    });
    expect(result).toBeNull();
  });

  it('removes only what a record names and the backend no longer holds', () => {
    const local = store(base(), raw('ws-9', { trees: [], nodes: [] }));
    const server = raw('ws-1', { name: 'One', trees: [{ id: 't1', root: 'n1', last_active_at: 5 }], nodes: [{ id: 'n1', tree_id: 't1' }] });
    // No record: absence alone (a write still on its way) removes nothing.
    expect(merge(local, [['ws-1', server]])).toBeNull();

    const result = merge(local, [['ws-1', server], ['ws-9', null]], {
      removals: { workspaceIds: new Set(['ws-9']), treeIds: new Set(['t2']), nodeIds: new Set(['n2']) },
    })!;
    expect(result.projects.map((project) => project.id)).toEqual(['ws-1']);
    expect(result.removedProjectIds).toEqual(['ws-9']);
    const project = result.projects[0];
    expect(project.trees.map((tree) => tree.id)).toEqual(['t1']);
    expect(project.chatIds).toEqual(['n1']);
    expect(project.edges).toEqual([]);
    expect(result.removedNodeIds.sort()).toEqual(['n2', 'n3']);
    expect(result.nodes.n2).toBeUndefined();
    expect(result.adoptions[0]).toMatchObject({ removedTreeIds: ['t2'], removedChatIds: ['n2', 'n3'], removedEdgeIds: ['branch-n1-n2'] });
  });

  it('follows a trim: children re-parented by the backend lose the stale branch', () => {
    const local = store(base());
    const server = base();
    // n2 trimmed out of t1 earlier; a new child n6 hangs from n1 instead of n2.
    server.nodes.push({ ...server.nodes[1], id: 'n6', parent_node_id: 'n1', created_at: 7 });
    local.nodes.n6 = { ...local.nodes.n2, nodeId: 'n6', parentNodeId: 'n2' };
    local.projects[0] = {
      ...local.projects[0],
      chatIds: [...local.projects[0].chatIds, 'n6'],
      edges: [...local.projects[0].edges, { source: 'n2', target: 'n6' }],
    };
    server.edges.push({ id: 'branch-n1-n6', workspace_id: 'ws-1', source_node_id: 'n1', target_node_id: 'n6', kind: 'branch' });
    const result = merge(local, [['ws-1', server]])!;
    expect(result.projects[0].edges.map((edge) => `${edge.source}>${edge.target}`)).toEqual(['n1>n2', 'n1>n6']);
    expect(result.nodes.n6.parentNodeId).toBe('n1');
    expect(result.adoptions[0].removedEdgeIds).toEqual(['branch-n2-n6']);

    // An edge this window has just drawn stays until its write lands.
    const pending = merge(local, [['ws-1', server]], { guards: quiet({ pendingEdgeUpserts: () => new Set(['branch-n2-n6']) }) })!;
    expect(pending.projects[0].edges.map((edge) => `${edge.source}>${edge.target}`)).toContain('n2>n6');
  });

  it('installs a workspace the store does not hold, without making it active', () => {
    const local = store(base());
    const result = merge(local, [['ws-new', raw('ws-new', {
      name: 'Made elsewhere', trees: [{ id: 'tn', root: 'nn' }], nodes: [{ id: 'nn', tree_id: 'tn' }],
    })]])!;
    expect(result.projects.map((project) => project.id)).toEqual(['ws-1', 'ws-new']);
    expect(result.projects[1]).toMatchObject({ name: 'Made elsewhere', activeTreeId: 'tn', chatIds: ['nn'] });
    expect(result.nodes.nn.projectId).toBe('ws-new');
    expect(result.adoptions).toEqual([expect.objectContaining({ projectId: 'ws-new', newProject: true })]);

    // A trashed workspace the store lacks may be one this window is purging right now.
    expect(merge(local, [['ws-gone', raw('ws-gone', { deleted_at: 5, trees: [], nodes: [] })]])).toBeNull();
  });

  it('removes after a gap what the backend held and a complete read no longer lists', () => {
    const local = store(
      base(),
      raw('ws-9', { trees: [{ id: 't9', root: 'n9' }], nodes: [{ id: 'n9', tree_id: 't9' }] }),
      raw('ws-mine', { trees: [{ id: 'tm', root: 'nm' }], nodes: [{ id: 'nm', tree_id: 'tm' }] }),
    );
    // A branch made here, not saved yet.
    local.nodes.n7 = { ...local.nodes.n2, nodeId: 'n7', parentNodeId: 'n1' };
    local.projects[0] = { ...local.projects[0], chatIds: [...local.projects[0].chatIds, 'n7'], edges: [...local.projects[0].edges, { source: 'n1', target: 'n7' }] };
    // Purged elsewhere during the gap: ws-9, the thread t2 (with n3) and the branch n2.
    const server = raw('ws-1', { name: 'One', trees: [{ id: 't1', root: 'n1', last_active_at: 5 }], nodes: [{ id: 'n1', tree_id: 't1' }] });
    const held = new Set(['workspace:ws-1', 'workspace:ws-9', 'tree:t1', 'tree:t2', 'tree:t9', 'node:n1', 'node:n2', 'node:n3', 'node:n9']);
    const result = merge(local, [['ws-1', server]], {
      complete: true,
      guards: quiet({ heldByBackendBefore: (entity, id, readStartedAt) => readStartedAt === 1_000 && held.has(`${entity}:${id}`) }),
    })!;
    // ws-mine was never saved: absent from the read, it stays.
    expect(result.projects.map((project) => project.id)).toEqual(['ws-1', 'ws-mine']);
    expect(result.removedProjectIds).toEqual(['ws-9']);
    const project = result.projects[0];
    expect(project.trees.map((tree) => tree.id)).toEqual(['t1']);
    expect(project.chatIds).toEqual(['n1', 'n7']);
    expect(project.edges.map((edge) => `${edge.source}>${edge.target}`)).toEqual(['n1>n7']);
    expect(project.activeTreeId).toBe('t1');
    expect(result.removedNodeIds.sort()).toEqual(['n2', 'n3', 'n9']);
    expect(result.nodes.n7).toBeDefined();
    expect(result.adoptions[0]).toMatchObject({ removedTreeIds: ['t2'], removedChatIds: ['n2', 'n3'] });
  });

  it('removes nothing on absence alone: not held before the read, not a complete read, or a read listing nothing', () => {
    const local = store(base(), raw('ws-9', { trees: [], nodes: [] }));
    const server = raw('ws-1', { name: 'One', trees: [{ id: 't1', root: 'n1', last_active_at: 5 }], nodes: [{ id: 'n1', tree_id: 't1' }] });
    const heldEverything = quiet({ heldByBackendBefore: () => true });
    // Held, but only since after this read began (a write that landed meanwhile).
    expect(merge(local, [['ws-1', server]], { complete: true, guards: quiet({ heldByBackendBefore: (_e, _id, at) => at > 1_000 }) })).toBeNull();
    // A targeted read lists only what it names.
    expect(merge(local, [['ws-1', server]], { guards: heldEverything })).toBeNull();
    // A backend that answers with no workspace at all is not taken as having purged them all.
    expect(merge(local, [], { complete: true, guards: heldEverything })).toBeNull();
  });

  it('leaves the assistant\'s system workspace to its own flows', () => {
    const system = raw('ws-sys', { name: 'Assistant', trees: [{ id: 'ts', root: 'ns' }], nodes: [{ id: 'ns', tree_id: 'ts' }] });
    system.workspace.settings = JSON.stringify({ system: 'assistant' }) as never;
    const local = store(base());
    expect(merge(local, [['ws-sys', system]])).toBeNull();
    const held = store(base(), system);
    const renamed = { ...system, workspace: { ...system.workspace, name: 'Elsewhere' } };
    expect(merge(held, [['ws-sys', renamed]])).toBeNull();
    // Nor does a complete read that lacks it remove it.
    expect(merge(held, [['ws-1', base()]], { complete: true, guards: quiet({ heldByBackendBefore: () => true }) })).toBeNull();
  });
});
