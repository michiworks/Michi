import { describe, expect, it, vi } from 'vitest';
import type { ChatNodeState, Project } from './chatTypes';
import {
  BackgroundGapRetries,
  backgroundReplayCursor,
  nodePageInstallable,
  nodePageLimit,
  readAndInstallNode,
  reconcileBackgroundWorkspaceSnapshot,
  sameGapTargetNode,
  sameProjectStructure,
  structureNodeRow,
  type NodeInstallReadOptions,
} from './backgroundGapReconcile';
import { hydrateBackendWorkspaces } from './chatHydration';
import { backendEntityId } from '../config/backendIdentity';
import { indexBackendProjects, workspaceBackendApiBase, nodeBackendApiBase } from '../config/backendConnections';
import { quietStructureGuards as quiet, quietStructureRead as read } from '../test/structureGuardsStub';

function node(overrides: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId: 'parent',
    projectId: 'ws-1',
    kind: 'chat',
    chatId: 'chat-parent',
    messages: [{ id: 'stale', role: 'assistant', text: 'stale local', toolCalls: [] }],
    followUps: [],
    status: 'streaming',
    ...overrides,
  };
}

const project: Project = {
  id: 'ws-1',
  name: 'Workspace',
  chatIds: ['parent'],
  edges: [],
  trees: [{ id: 'tree-1', rootNodeId: 'parent', createdAt: 1, lastActiveAt: 1 }],
  activeTreeId: 'tree-1',
  artifacts: [],
  createdAt: 1,
};

function fullWorkspace(status: 'idle' | 'streaming' = 'idle') {
  return {
    workspace: { id: 'ws-1', name: 'Workspace', active_tree_id: 'tree-1', created_at: 1 },
    trees: [{
      id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'parent',
      created_at: 1, last_active_at: 2,
    }],
    nodes: [
      {
        id: 'parent', workspace_id: 'ws-1', tree_id: 'tree-1',
        acp_session_id: 'chat-parent', title: 'Canonical title', status, created_at: 1,
      },
      {
        id: 'child', workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: 'parent',
        acp_session_id: 'chat-child', title: 'Recovered branch', status: 'idle',
        spawned_by_agent: 1, created_at: 2,
      },
    ],
    edges: [{
      id: 'edge-1', workspace_id: 'ws-1', source_node_id: 'parent',
      target_node_id: 'child', kind: 'branch', created_at: 2,
    }],
    messages: [{
      id: 'assistant-durable', node_id: 'parent', role: 'assistant',
      content: 'durable answer', seq: 0, created_at: 3,
    }],
    artifacts: [{
      id: 'ctx-1', workspace_id: 'ws-1', name: 'recovered',
      file_path: '.artifacts/recovered.md', source: 'agent', type: 'doc',
      created_at: 2, updated_at: 3,
    }],
  };
}

describe('background durable-gap workspace reconciliation', () => {
  it('keeps a remote snapshot and all its recovered nodes on their connection alongside a same-ID Local workspace', () => {
    const connectionId = 'remote-gap';
    const remote = hydrateBackendWorkspaces([fullWorkspace()], null, connectionId);
    const remoteNodeId = backendEntityId(connectionId, 'parent');
    const remoteProjectId = backendEntityId(connectionId, 'ws-1');
    const result = reconcileBackgroundWorkspaceSnapshot({
      ...read,
      currentProjects: [project, ...remote.projects],
      currentNodes: { parent: node(), ...remote.nodes },
      rawWorkspace: fullWorkspace(),
      gap: { chatId: remoteNodeId, nodeId: remoteNodeId, turnId: 'durable', seq: 12 },
    });
    expect(result).not.toBeNull();
    expect(result!.projects[0]).toBe(project);
    expect(result!.projects[1].backendConnectionId).toBe(connectionId);
    expect(result!.nodes.parent.projectId).toBe('ws-1');
    expect(result!.nodes[remoteNodeId].projectId).toBe(remoteProjectId);
    // The identity itself owns routing, even if a later caller drops metadata.
    indexBackendProjects(result!.projects.map(({ backendConnectionId: _connection, ...value }) => value));
    expect(workspaceBackendApiBase(remoteProjectId)).toContain(`/backend-connections/${connectionId}/proxy`);
    expect(nodeBackendApiBase(backendEntityId(connectionId, 'child'))).toBe(workspaceBackendApiBase(remoteProjectId));
    expect(workspaceBackendApiBase('ws-1')).not.toContain('/proxy');
  });
  it('atomically restores canonical messages, graph and artifacts while keeping local compose state', () => {
    const local = node({
      composerDraft: { value: 'do not lose this draft', mentions: [] },
      pendingQueued: [{
        id: 'queued-1', value: 'queued', mentions: [], attachments: [], queuedAt: 4,
      }],
      lastAppliedTurnId: 'evicted-turn',
      lastAppliedSeq: 4,
      lastAppliedBackgroundTurnId: 'old-background-turn',
      lastAppliedBackgroundSeq: 3,
    });
    const unrelatedProject: Project = {
      ...project, id: 'ws-2', name: 'Other', chatIds: ['other'],
      trees: [{ id: 'tree-2', rootNodeId: 'other', createdAt: 1, lastActiveAt: 1 }],
      activeTreeId: 'tree-2',
    };
    const result = reconcileBackgroundWorkspaceSnapshot({
      ...read,
      currentProjects: [project, unrelatedProject],
      currentNodes: { parent: local, other: node({ nodeId: 'other', projectId: 'ws-2', chatId: null }) },
      rawWorkspace: fullWorkspace(),
      gap: { chatId: 'parent', nodeId: 'parent', turnId: 'durable-turn', seq: 12 },
    });

    expect(result).not.toBeNull();
    expect(result!.projects.find((candidate) => candidate.id === 'ws-2')).toBe(unrelatedProject);
    const recoveredProject = result!.projects.find((candidate) => candidate.id === 'ws-1')!;
    expect(recoveredProject.chatIds).toEqual(['parent', 'child']);
    expect(recoveredProject.edges).toEqual([
      expect.objectContaining({ source: 'parent', target: 'child', kind: 'branch' }),
    ]);
    expect(recoveredProject.artifacts).toEqual([
      expect.objectContaining({ id: 'ctx-1', name: 'recovered', source: 'agent' }),
    ]);
    expect(result!.nodes.child).toEqual(expect.objectContaining({
      chatId: 'child', spawnedByAgent: true, title: 'Recovered branch',
    }));
    expect(result!.nodes.parent.messages[0].blocks).toEqual([
      expect.objectContaining({ kind: 'answer', rawText: 'durable answer' }),
    ]);
    expect(result!.nodes.parent).toEqual(expect.objectContaining({
      status: 'idle',
      title: 'Canonical title',
      // A foreground turn may complete while the background feed is down.
      // Its durable replay cursor must survive a later background reconcile.
      lastAppliedTurnId: 'evicted-turn',
      lastAppliedSeq: 4,
      lastAppliedBackgroundTurnId: 'durable-turn',
      lastAppliedBackgroundSeq: 12,
      composerDraft: local.composerDraft,
      pendingQueued: local.pendingQueued,
    }));
    expect(result!.nodes.other).toBeDefined();
  });

  it('restores an active durable turn as streaming instead of leaving stale local status', () => {
    const result = reconcileBackgroundWorkspaceSnapshot({
      ...read,
      currentProjects: [project],
      currentNodes: { parent: node({ status: 'idle' }) },
      rawWorkspace: fullWorkspace('streaming'),
      gap: { chatId: 'chat-parent', nodeId: 'parent', turnId: 'active-turn', seq: 7 },
    });

    expect(result!.nodes.parent.status).toBe('streaming');
    expect(result!.nodes.parent.messages.at(-1)?.streaming).toBe(true);
  });

  it('keeps the session\'s commands only while the chat still runs on the runtime they came from', () => {
    const agentCommands = [{ name: 'tools' }, { name: 'usage' }];
    const local = node({ runtimeId: 'kiro', agentCommands, sessionState: { runtimeId: 'kiro', nativeEngine: 'v3' } });
    const reconciled = (runtimeId: string) => reconcileBackgroundWorkspaceSnapshot({
      ...read,
      currentProjects: [project],
      currentNodes: { parent: local },
      rawWorkspace: { ...fullWorkspace(), nodes: fullWorkspace().nodes.map((row) => (row.id === 'parent' ? { ...row, runtime_id: runtimeId } : row)) },
      gap: { chatId: 'chat-parent', nodeId: 'parent', turnId: 'durable-turn', seq: 12 },
    })!.nodes.parent;
    expect(reconciled('kiro')).toMatchObject({ runtimeId: 'kiro', agentCommands, sessionState: local.sessionState });
    const switched = reconciled('claude');
    expect(switched.runtimeId).toBe('claude');
    expect(switched.agentCommands).toBeUndefined();
    expect(switched.sessionState).toBeUndefined();
  });

  it('preserves unsynced local rename and newer context edits during reconciliation', () => {
    const localProject: Project = {
      ...project,
      artifacts: [{
        id: 'ctx-1', name: 'recovered', filePath: '.artifacts/local.md',
        source: 'user', createdAt: 2, updatedAt: 99,
      }],
    };
    const result = reconcileBackgroundWorkspaceSnapshot({
      ...read,
      // As the persistence layer answers for a title not saved yet.
      guards: quiet({ nodeFieldEdited: (_project, nodes, nodeId, field) => field === 'title' && !!nodes[nodeId]?.titleNeedsPersistence }),
      currentProjects: [localProject],
      currentNodes: {
        parent: node({ title: 'Local rename', titleNeedsPersistence: true }),
      },
      rawWorkspace: fullWorkspace(),
      gap: { chatId: 'chat-parent', nodeId: 'parent', turnId: 'durable-turn', seq: 12 },
    });

    expect(result!.nodes.parent).toEqual(expect.objectContaining({
      title: 'Local rename', titleNeedsPersistence: true,
    }));
    expect(result!.projects[0]!.artifacts?.[0]).toEqual(expect.objectContaining({
      id: 'ctx-1', filePath: '.artifacts/local.md', source: 'user', updatedAt: 99,
    }));
  });

  describe("this window's artifacts merge with the backend's by id, never by name", () => {
    const local = (id: string, name: string, updatedAt = 99) => ({
      id, name, filePath: `.contexts/${name}.md`, source: 'agent' as const, createdAt: 2, updatedAt,
    });
    const reconciledWith = (pendingDeletes: string[], ...artifacts: ReturnType<typeof local>[]) => reconcileBackgroundWorkspaceSnapshot({
      ...read,
      currentProjects: [{ ...project, artifacts }],
      currentNodes: { parent: node() },
      rawWorkspace: fullWorkspace(),
      gap: { chatId: 'chat-parent', nodeId: 'parent', turnId: 'durable-turn', seq: 12 },
      guards: quiet({ pendingDeletes: () => ({ treeIds: new Set(), edgeIds: new Set(), contextIds: new Set(pendingDeletes) }) }),
    })!.projects[0]!.artifacts?.map((artifact) => [artifact.id, artifact.name]);
    const reconciled = (...artifacts: ReturnType<typeof local>[]) => reconciledWith([], ...artifacts);

    it("a newer copy of another artifact only this window holds never takes the backend's one's place", () => {
      // The backend holds ctx-1 "recovered" (updated at 3). This window holds
      // it too, and ctx-old "Recovered", reported since (a case variant there).
      expect(reconciled(local('ctx-1', 'recovered', 3), local('ctx-old', 'Recovered')))
        .toEqual([['ctx-1', 'recovered'], ['ctx-old', 'Recovered']]);
    });

    it("one only this window holds stays, even under the exact name of the backend's", () => {
      // A write still on its way, or stale there (deleted or renamed, and
      // ctx-1 took its name): dropping it here would delete it for good in
      // the first case, so it stays beside the backend's.
      expect(reconciled(local('ctx-old', 'recovered'))).toEqual([['ctx-1', 'recovered'], ['ctx-old', 'recovered']]);
      expect(reconciled(local('ctx-new', 'plan'))).toEqual([['ctx-1', 'recovered'], ['ctx-new', 'plan']]);
    });

    it("names the ones kept under the exact name of the backend's, for the window to ask about, and no other", () => {
      const probesOf = (pendingDeletes: string[], ...artifacts: ReturnType<typeof local>[]) => reconcileBackgroundWorkspaceSnapshot({
        ...read,
        currentProjects: [{ ...project, artifacts }],
        currentNodes: { parent: node() },
        rawWorkspace: fullWorkspace(),
        gap: { chatId: 'chat-parent', nodeId: 'parent', turnId: 'durable-turn', seq: 12 },
        guards: quiet({ pendingDeletes: () => ({ treeIds: new Set(), edgeIds: new Set(), contextIds: new Set(pendingDeletes) }) }),
      })!.artifactProbes;
      expect(probesOf([], local('ctx-old', 'recovered'), local('ctx-new', 'plan'))).toEqual({ projectId: 'ws-1', contextIds: ['ctx-old'] });
      // A case variant is another artifact there; one both hold is matched by id.
      expect(probesOf([], local('ctx-old', 'Recovered'), local('ctx-1', 'recovered', 3))).toBeUndefined();
      // The backend's one, removed here and not confirmed yet, holds no name.
      expect(probesOf(['ctx-1'], local('ctx-new', 'recovered', 60))).toBeUndefined();
    });

    it("keeps a new artifact made under the name of one renamed here, the rename not landed yet", () => {
      // ctx-1 renamed "recovered" -> "recovered-old" here, then ctx-new made as "recovered".
      expect(reconciled(local('ctx-1', 'recovered-old', 50), local('ctx-new', 'recovered', 60)))
        .toEqual([['ctx-1', 'recovered-old'], ['ctx-new', 'recovered']]);
    });

    it("never brings back one this window removed before the backend confirmed it, and keeps the new one under its name", () => {
      // ctx-1 deleted here, then ctx-new made as "recovered"; neither landed yet.
      expect(reconciledWith(['ctx-1'], local('ctx-new', 'recovered', 60))).toEqual([['ctx-new', 'recovered']]);
      expect(reconciledWith(['ctx-1'])).toEqual([]);
      // One removed here the backend no longer holds changes nothing.
      expect(reconciledWith(['ctx-gone'])).toEqual([['ctx-1', 'recovered']]);
    });
  });
});

describe('the workspace a gap install reads, against this window\'s unsaved edits', () => {
  const gap = { chatId: 'chat-parent', nodeId: 'parent', turnId: 'durable-turn', seq: 12 };
  const reconcile = (overrides: Partial<Parameters<typeof reconcileBackgroundWorkspaceSnapshot>[0]> = {}) => reconcileBackgroundWorkspaceSnapshot({
    ...read, currentProjects: [project], currentNodes: { parent: node() }, rawWorkspace: fullWorkspace(), gap, ...overrides,
  })!;
  const withTree = (raw: ReturnType<typeof fullWorkspace>, treeId: string, rootId: string) => ({
    ...raw,
    trees: [...raw.trees, { id: treeId, workspace_id: 'ws-1', root_node_id: rootId, created_at: 4, last_active_at: 4 }],
    nodes: [...raw.nodes, { id: rootId, workspace_id: 'ws-1', tree_id: treeId, acp_session_id: rootId, title: 'Other', status: 'idle' as const, created_at: 4 }],
  });

  it('keeps an archive and a rename it has not saved, and takes the backend\'s values otherwise, as adoptions', () => {
    const local: Project = { ...project, name: 'Renamed', trees: [{ ...project.trees[0], archivedAt: 50 }] };
    const guarded = reconcile({
      currentProjects: [local],
      guards: quiet({ workspaceFieldEdited: (_project, field) => field === 'name', treeFieldEdited: (_project, _tree, field) => field === 'archived_at' }),
    });
    expect(guarded.projects[0]).toMatchObject({ name: 'Renamed', trees: [expect.objectContaining({ id: 'tree-1', archivedAt: 50 })] });
    expect(guarded.adoptions.flatMap((adoption) => (adoption.workspace ? [adoption.workspace] : []))).toEqual([]);

    const adopted = reconcile({ currentProjects: [local] });
    expect(adopted.projects[0]).toMatchObject({ name: 'Workspace', trees: [expect.objectContaining({ id: 'tree-1', archivedAt: undefined })] });
    const adoption = adopted.adoptions.find((candidate) => candidate.projectId === 'ws-1')!;
    expect(adoption.workspace).toEqual({ name: 'Workspace' });
    expect(adoption.trees).toEqual([expect.objectContaining({ fields: ['archivedAt'] })]);
    // The new branch and its edge are the backend's; the installed node is what the store now holds.
    expect(adoption.chatIds).toEqual(['child']);
    expect(adoption.edges).toEqual([expect.objectContaining({ source: 'parent', target: 'child' })]);
    expect(adoption.nodes?.find((entry) => entry.node.nodeId === 'parent')?.node).toBe(adopted.nodes.parent);
  });

  it('brings back no tree or edge it just removed, and no tree it holds in another workspace', () => {
    const raw = withTree(withTree(fullWorkspace(), 'tree-2', 'removed-root'), 'tree-3', 'moved-root');
    const elsewhere: Project = {
      ...project, id: 'ws-2', chatIds: ['moved-root'], activeTreeId: 'tree-3',
      trees: [{ id: 'tree-3', rootNodeId: 'moved-root', createdAt: 4, lastActiveAt: 4 }],
    };
    const result = reconcile({
      currentProjects: [project, elsewhere],
      currentNodes: { parent: node(), 'moved-root': node({ nodeId: 'moved-root', projectId: 'ws-2', chatId: 'moved-root' }) },
      rawWorkspace: raw,
      guards: quiet({ pendingDeletes: (candidate) => candidate.id === 'ws-1'
        ? { treeIds: new Set(['tree-2']), edgeIds: new Set(['branch-parent-child']) }
        : { treeIds: new Set(), edgeIds: new Set() } }),
    });
    const installed = result.projects.find((candidate) => candidate.id === 'ws-1')!;
    expect(installed.trees.map((tree) => tree.id)).toEqual(['tree-1']);
    expect(installed.chatIds).toEqual(['parent', 'child']);
    expect(installed.edges).toEqual([]);
    expect(result.nodes['removed-root']).toBeUndefined();
    expect(result.nodes['moved-root'].projectId).toBe('ws-2');
  });

  it('brings back no artifact it just deleted, and takes one an agent saved as already durable', () => {
    const removed = reconcile({
      guards: quiet({ pendingDeletes: () => ({ treeIds: new Set(), edgeIds: new Set(), contextIds: new Set(['ctx-1']) }) }),
    });
    expect(removed.projects[0].artifacts).toEqual([]);
    expect(removed.installed?.contextIds ?? []).toEqual([]);

    const saved = reconcile();
    expect(saved.projects[0].artifacts).toEqual([expect.objectContaining({ id: 'ctx-1', source: 'agent' })]);
    expect(saved.installed).toMatchObject({ projectId: 'ws-1', newProject: false, nodeIds: [], contextIds: ['ctx-1'] });
  });

  it('keeps the node out of the trash it was just restored from, and takes a restore made elsewhere', () => {
    const trashed = { ...fullWorkspace(), nodes: fullWorkspace().nodes.map((row) => (row.id === 'parent' ? { ...row, deleted_at: 7 } : row)) };
    const restoredHere = reconcile({
      rawWorkspace: trashed,
      guards: quiet({ nodeFieldEdited: (_project, _nodes, nodeId, field) => nodeId === 'parent' && field === 'deleted_at' }),
    });
    expect(restoredHere.nodes.parent.deletedAt).toBeUndefined();

    const restoredElsewhere = reconcile({ currentNodes: { parent: node({ deletedAt: 5 }) } });
    expect(restoredElsewhere.nodes.parent.deletedAt).toBeUndefined();
  });

  it('merges the assistant\'s system workspace as its snapshots do, keeping its own fields', () => {
    const system: Project = { ...project, name: 'Assistant', system: 'assistant' };
    const result = reconcile({ currentProjects: [system] });
    expect(result.projects[0]).toMatchObject({ name: 'Assistant', system: 'assistant', chatIds: ['parent', 'child'] });
    expect(result.nodes.parent.messages[0].blocks).toEqual([expect.objectContaining({ kind: 'answer', rawText: 'durable answer' })]);
    expect(result.adoptions).toEqual([]);
    expect(result.installed).toMatchObject({ projectId: 'ws-1', nodeIds: ['child'], edgeIds: ['branch-parent-child'], contextIds: ['ctx-1'] });
  });
});

describe('background gap reconciliation from a structure read and one node page', () => {
  function structure(status: 'idle' | 'streaming' = 'streaming') {
    return {
      workspace: { id: 'ws-1', name: 'Workspace', active_tree_id: 'tree-1', created_at: 1 },
      trees: [{ id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'parent', created_at: 1, last_active_at: 2 }],
      nodes: [
        {
          id: 'parent', workspace_id: 'ws-1', tree_id: 'tree-1', acp_session_id: 'chat-parent',
          title: 'Canonical title', status, created_at: 1,
          last_applied_turn_id: 'turn-a', last_applied_seq: 12, message_count: 6,
        },
        {
          id: 'child', workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: 'parent',
          acp_session_id: 'chat-child', title: 'Sibling', status: 'idle', created_at: 2, message_count: 5,
        },
      ],
      edges: [{ id: 'edge-1', workspace_id: 'ws-1', source_node_id: 'parent', target_node_id: 'child', kind: 'branch', created_at: 2 }],
      messages: [],
      contexts: [],
    };
  }
  const row = (seq: number, content: string, nodeId = 'parent') => ({
    id: `${nodeId}-m${seq}`, node_id: nodeId, role: seq % 2 ? 'assistant' : 'user', content, seq, created_at: seq,
  });
  const turn = (turnId: string, status: string, lastSeq: number) => ({
    node_id: 'parent', turn_id: turnId, status, last_seq: lastSeq, error: null, completed_at: null,
  });
  const local = () => node({
    lastAppliedTurnId: 'evicted-turn', lastAppliedSeq: 4,
    lastAppliedBackgroundTurnId: 'old-turn', lastAppliedBackgroundSeq: 3,
    composerDraft: { value: 'keep me', mentions: [] },
  });

  it('installs the page with its bounds and the cursor of the turn row read with its bodies', () => {
    const result = reconcileBackgroundWorkspaceSnapshot({
      ...read,
      currentProjects: [project],
      currentNodes: { parent: local() },
      rawWorkspace: structure(),
      page: {
        messages: [row(4, 'question'), row(5, 'checkpointed answer')],
        pages: [{ nodeId: 'parent', total: 6, before: { seq: 4, id: 'parent-m4' } }],
        turns: [turn('turn-a', 'active', 20)],
      },
      gap: { chatId: 'parent', nodeId: 'parent', turnId: 'turn-a', seq: 12 },
    })!;
    const installed = result.nodes.parent;
    expect(installed).toMatchObject({
      messagesLoaded: false, historyBefore: { seq: 4, id: 'parent-m4' }, messageCount: 6,
      status: 'streaming', activeTurnId: 'turn-a',
      // Frames up to the checkpoint the bodies hold are not replayed onto them.
      lastAppliedBackgroundTurnId: 'turn-a', lastAppliedBackgroundSeq: 20,
      // The foreground cursor is this window's own authority.
      lastAppliedTurnId: 'evicted-turn', lastAppliedSeq: 4,
      composerDraft: { value: 'keep me', mentions: [] },
    });
    expect(result.cursor).toEqual({ turnId: 'turn-a', seq: 20 });
    expect(installed.messages.map((message) => message.id)).toEqual(['parent-m4', 'parent-m5']);
    expect(installed.messages.at(-1)?.streaming).toBe(true);
    // A node the window did not have arrives as a placeholder that loads when opened.
    expect(result.nodes.child).toMatchObject({ messagesLoaded: false, messageCount: 5, messages: [] });
  });

  it('takes the turn that started while it read, and the end of one that finished', () => {
    const started = reconcileBackgroundWorkspaceSnapshot({
      ...read,
      currentProjects: [project],
      currentNodes: { parent: local() },
      rawWorkspace: structure('idle'),
      page: { messages: [row(5, 'new turn')], pages: [{ nodeId: 'parent', total: 6, before: null }], turns: [turn('turn-b', 'active', 3)] },
      gap: { chatId: 'parent', nodeId: 'parent', turnId: 'turn-a', seq: 12 },
    })!;
    expect(started.cursor).toEqual({ turnId: 'turn-b', seq: 3 });
    expect(started.nodes.parent).toMatchObject({ status: 'streaming', activeTurnId: 'turn-b', messagesLoaded: true });

    const finished = reconcileBackgroundWorkspaceSnapshot({
      ...read,
      currentProjects: [project],
      currentNodes: { parent: local() },
      rawWorkspace: structure('streaming'),
      page: { messages: [row(5, 'final')], pages: [{ nodeId: 'parent', total: 6, before: null }], turns: [turn('turn-a', 'completed', 31)] },
      gap: { chatId: 'parent', nodeId: 'parent', turnId: 'turn-a', seq: 12 },
    })!;
    expect(finished.cursor).toEqual({ turnId: 'turn-a', seq: 31 });
    expect(finished.nodes.parent).toMatchObject({ status: 'idle', activeTurnId: undefined });
    expect(finished.nodes.parent.messages.at(-1)?.streaming).toBe(false);
  });

  it('keeps the gap cursor and the structure status on a gateway without turn rows', () => {
    const result = reconcileBackgroundWorkspaceSnapshot({
      ...read,
      currentProjects: [project],
      currentNodes: { parent: local() },
      rawWorkspace: structure('streaming'),
      page: { messages: [row(5, 'partial')], pages: [{ nodeId: 'parent', total: 1, before: null }] },
      gap: { chatId: 'parent', nodeId: 'parent', turnId: 'turn-a', seq: 12 },
    })!;
    expect(result.cursor).toEqual({ turnId: 'turn-a', seq: 12 });
    expect(result.nodes.parent).toMatchObject({
      status: 'streaming', messagesLoaded: true, messageCount: 1,
      lastAppliedBackgroundTurnId: 'turn-a', lastAppliedBackgroundSeq: 12,
    });
  });

  it('takes only the node from a gateway that answers with the whole thread, as its complete history', () => {
    const result = reconcileBackgroundWorkspaceSnapshot({
      ...read,
      currentProjects: [project],
      currentNodes: { parent: local() },
      rawWorkspace: structure('idle'),
      page: { messages: [row(0, 'first'), row(1, 'answer'), row(0, 'sibling question', 'child')] },
      gap: { chatId: 'parent', nodeId: 'parent', turnId: 'turn-a', seq: 12 },
    })!;
    expect(result.nodes.parent.messages.map((message) => message.id)).toEqual(['parent-m0', 'parent-m1']);
    expect(result.nodes.parent).toMatchObject({ messagesLoaded: true, messageCount: 2, historyBefore: undefined });
    expect(result.nodes.child).toMatchObject({ messagesLoaded: false, messages: [] });
  });
});

describe('reading one node of a workspace structure', () => {
  const rows = { nodes: [{ id: 'parent', tree_id: 'tree-1', message_count: 3 }, { id: 'loose' }] };

  it('names the server-side thread and count of the node, or nothing when it is not listed in one', () => {
    expect(structureNodeRow(rows, 'parent')).toEqual({ treeId: 'tree-1', messageCount: 3 });
    expect(structureNodeRow(rows, 'loose')).toBeNull();
    expect(structureNodeRow(rows, 'gone')).toBeNull();
    expect(structureNodeRow(null, 'parent')).toBeNull();
    const connectionId = 'remote-gap';
    expect(structureNodeRow(rows, backendEntityId(connectionId, 'parent'), connectionId))
      .toEqual({ treeId: backendEntityId(connectionId, 'tree-1'), messageCount: 3 });
  });

  it('installs only a page that agrees with the structure read', () => {
    const page = (messages: unknown[], pages?: Array<{ nodeId: string; total: number; before: null }>) => ({ messages, ...(pages ? { pages } : {}) });
    const message = { id: 'm1', node_id: 'parent' };
    expect(nodePageInstallable(page([message], [{ nodeId: 'parent', total: 1, before: null }]), 'parent', 1)).toBe(true);
    // Moved to another thread between the two reads.
    expect(nodePageInstallable(page([], []), 'parent', 1)).toBe(false);
    // Empty where the structure counts messages.
    expect(nodePageInstallable(page([], [{ nodeId: 'parent', total: 0, before: null }]), 'parent', 2)).toBe(false);
    expect(nodePageInstallable(page([], [{ nodeId: 'parent', total: 2, before: null }]), 'parent', 2)).toBe(false);
    // Genuinely empty.
    expect(nodePageInstallable(page([], [{ nodeId: 'parent', total: 0, before: null }]), 'parent', 0)).toBe(true);
    // A gateway without pages.
    expect(nodePageInstallable(page([message, { id: 'x', node_id: 'other' }]), 'parent', 1)).toBe(true);
    expect(nodePageInstallable(page([{ id: 'x', node_id: 'other' }]), 'parent', 1)).toBe(false);
    expect(nodePageInstallable(page([]), 'parent', 0)).toBe(true);
  });

  it('asks for at least what the window shows, within the server cap', () => {
    expect(nodePageLimit(undefined)).toBe(50);
    expect(nodePageLimit(node({ messages: [] }))).toBe(50);
    const many = Array.from({ length: 120 }, (_, index) => ({ id: `m${index}`, role: 'user' as const, text: '', toolCalls: [] }));
    expect(nodePageLimit(node({ messages: many }))).toBe(120);
    expect(nodePageLimit(node({ messages: [...many, ...many] }))).toBe(200);
  });
});

describe('what a gap read must stay stable across', () => {
  it('is the target node, ignoring what the install keeps from the window at install time', () => {
    const before = node();
    expect(sameGapTargetNode(before, before)).toBe(true);
    expect(sameGapTargetNode(before, { ...before, composerDraft: { value: 'typing', mentions: [] }, viewedAt: 9, seenCompletionSeq: 2 })).toBe(true);
    expect(sameGapTargetNode(before, { ...before, title: 'Renamed' })).toBe(false);
    expect(sameGapTargetNode(before, { ...before, messages: [] })).toBe(false);
    expect(sameGapTargetNode(before, undefined)).toBe(false);
    expect(sameGapTargetNode(undefined, undefined)).toBe(true);
  });

  it('is the project structure, not a thread\'s activity time', () => {
    const touched = { ...project, trees: project.trees.map((tree) => ({ ...tree, lastActiveAt: 99 })) };
    expect(sameProjectStructure(project, touched)).toBe(true);
    expect(sameProjectStructure(project, { ...project, chatIds: ['parent', 'new'] })).toBe(false);
    expect(sameProjectStructure(project, { ...project, trees: project.trees.map((tree) => ({ ...tree, archivedAt: 5 })) })).toBe(false);
    expect(sameProjectStructure(project, { ...project, name: 'Renamed' })).toBe(false);
    expect(sameProjectStructure(project, undefined)).toBe(false);
  });
});

describe('reading a node to install it', () => {
  const structure = (treeId = 'tree-1') => ({ nodes: [{ id: 'parent', tree_id: treeId, message_count: 1 }] });
  const page = (nodeId = 'parent') => ({
    messages: nodeId ? [{ id: 'm', node_id: nodeId, role: 'user', content: 'x', seq: 0 }] : [],
    pages: nodeId ? [{ nodeId, total: 1, before: null }] : [],
  });
  function reader(overrides: Partial<NodeInstallReadOptions<string>> = {}) {
    const store = { project, node: node() as ChatNodeState | undefined };
    const options: NodeInstallReadOptions<string> = {
      workspaceId: 'ws-1', nodeId: 'parent', attempts: 3, signal: new AbortController().signal, readTimeoutMs: 1_000,
      project: () => store.project, node: () => store.node, nodeHeld: true,
      busy: () => false, idle: async () => true,
      fetchStructure: vi.fn(async () => structure()),
      fetchPage: vi.fn(async () => page()),
      install: vi.fn((read) => `installed ${read.connectionId}`),
      ...overrides,
    };
    return { store, options };
  }

  it('reads the structure, then one page of the node, and installs them at once', async () => {
    const { options } = reader();
    await expect(readAndInstallNode(options)).resolves.toEqual({ installed: 'installed local' });
    expect(options.fetchPage).toHaveBeenCalledWith('ws-1', 'tree-1', undefined, options.signal, { nodeId: 'parent', limit: 50 });
    expect(options.install).toHaveBeenCalledWith(expect.objectContaining({ structure: structure(), page: page(), readStartedAt: expect.any(Number) }));
  });

  it('reads again when the page lacks the node, and gives up once the node moved threads', async () => {
    const fetchStructure = vi.fn().mockResolvedValueOnce(structure()).mockResolvedValueOnce(structure('tree-2'));
    const { options } = reader({ fetchStructure, fetchPage: vi.fn(async () => page('')) });
    await expect(readAndInstallNode(options)).resolves.toBe('gone');
    expect(fetchStructure).toHaveBeenCalledTimes(2);
    expect(options.install).not.toHaveBeenCalled();
  });

  it('reads again across a local edit during the reads, and stops after its attempts', async () => {
    const { store, options } = reader();
    let renames = 0;
    options.fetchPage = vi.fn(async () => {
      store.node = { ...store.node!, title: `Renamed ${++renames}` };
      return page();
    });
    await expect(readAndInstallNode(options)).resolves.toBe('exhausted');
    expect(options.fetchStructure).toHaveBeenCalledTimes(3);
    expect(options.install).not.toHaveBeenCalled();
  });

  it('waits while the node is busy, and installs nothing for a node it must already hold', async () => {
    let busy = true;
    const idle = vi.fn(async () => { busy = false; return true; });
    const waited = reader({ busy: () => busy, idle });
    await expect(readAndInstallNode(waited.options)).resolves.toEqual({ installed: 'installed local' });
    expect(idle).toHaveBeenCalledTimes(1);

    const gaveUp = reader({ busy: () => true, idle: async () => false });
    await expect(readAndInstallNode(gaveUp.options)).resolves.toBe('gone');
    expect(gaveUp.options.fetchStructure).not.toHaveBeenCalled();

    const missing = reader();
    missing.store.node = undefined;
    await expect(readAndInstallNode(missing.options)).resolves.toBe('gone');
    await expect(readAndInstallNode({ ...missing.options, nodeHeld: false })).resolves.toEqual({ installed: 'installed local' });
  });

  it('rejects once its signal aborts', async () => {
    const controller = new AbortController();
    const { options } = reader({ signal: controller.signal, fetchStructure: vi.fn(async () => { controller.abort(); return structure(); }) });
    await expect(readAndInstallNode(options)).rejects.toMatchObject({ name: 'AbortError' });
    expect(options.fetchPage).not.toHaveBeenCalled();
  });
});

describe('the cursor the background feed reopens from', () => {
  const running = node({
    status: 'streaming', activeTurnId: 'local-turn',
    lastAppliedTurnId: 'local-turn', lastAppliedSeq: 40,
    lastAppliedBackgroundTurnId: 'older-turn', lastAppliedBackgroundSeq: 7,
  });

  it('is the foreground cursor while this window\'s own stream drives the running turn', () => {
    expect(backgroundReplayCursor(running, true)).toEqual({ turnId: 'local-turn', seq: 40 });
  });

  it('is the background cursor otherwise', () => {
    expect(backgroundReplayCursor(running, false)).toEqual({ turnId: 'older-turn', seq: 7 });
    // The foreground cursor still names an earlier turn before turn_start arrives.
    expect(backgroundReplayCursor({ ...running, lastAppliedTurnId: 'previous', lastAppliedSeq: 3 }, true))
      .toEqual({ turnId: 'older-turn', seq: 7 });
    expect(backgroundReplayCursor({ ...running, status: 'idle', activeTurnId: undefined }, true))
      .toEqual({ turnId: 'older-turn', seq: 7 });
    expect(backgroundReplayCursor(node({ lastAppliedTurnId: 'fg', lastAppliedSeq: 2 }), false)).toEqual({ turnId: 'fg', seq: 2 });
    expect(backgroundReplayCursor(node(), false)).toBeNull();
  });
});

describe('spacing a chat whose replay gap keeps failing', () => {
  it('backs off per chat across reconnects and forgets the chat once it reconciles', () => {
    let now = 1_000;
    const retries = new BackgroundGapRetries(1_000, 4_000, () => now);
    const gap = { chatId: 'c', turnId: 't', seq: 1 };
    expect(retries.delay(gap)).toBe(0);
    retries.failed(gap);
    expect(retries.delay(gap)).toBe(1_000);
    // A running turn's durable seq moves between reconnects: still the same chat.
    expect(retries.delay({ ...gap, seq: 9 })).toBe(1_000);
    expect(retries.delay({ ...gap, chatId: 'other' })).toBe(0);
    now += 1_000;
    retries.failed(gap);
    expect(retries.delay(gap)).toBe(2_000);
    retries.failed(gap);
    retries.failed(gap);
    expect(retries.delay(gap)).toBe(4_000);
    retries.settled(gap);
    expect(retries.delay(gap)).toBe(0);
  });
});
