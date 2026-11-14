import { describe, expect, it } from 'vitest';
import { hydrateBackendWorkspaces, mapNodeRowScalars } from './chatHydration';
import { reduceNodes } from './chatReducers';
import { isVisibleConversationNode } from './conversationVisibility';
import { serializeNodeRow } from './workspacePersistence';
import type { ChatNodeState, Project } from './chatTypes';

describe('a temporary chat in the renderer', () => {
  it('is read from the server-owned nodes.memory_mode: only off makes one', () => {
    const state = hydrateBackendWorkspaces([{
      workspace: { id: 'ws1', name: 'Test', created_at: 1 },
      trees: [
        { id: 't1', root_node_id: 'temp', created_at: 1, last_active_at: 1 },
        { id: 't2', root_node_id: 'plain', created_at: 2, last_active_at: 2 },
        { id: 't3', root_node_id: 'legacy', created_at: 3, last_active_at: 3 },
      ],
      nodes: [
        { id: 'temp', created_at: 1, kind: 'chat', memory_mode: 'off' },
        { id: 'plain', created_at: 2, kind: 'chat', memory_mode: null },
        // The retired per-chat Use only is not a temporary chat.
        { id: 'legacy', created_at: 3, kind: 'chat', memory_mode: 'use_only' },
      ],
      edges: [], messages: [], artifacts: [],
    }]);
    expect(state.nodes.temp.temporary).toBe(true);
    expect(state.nodes.plain.temporary).toBeUndefined();
    expect(state.nodes.legacy.temporary).toBeUndefined();
    expect(mapNodeRowScalars({ id: 'older-backend' }).temporary).toBeUndefined();
    // Listed like any chat: the sidebar, history and search show it.
    expect(isVisibleConversationNode(state.nodes.temp)).toBe(true);
  });

  it('never goes back in workspace sync rows', () => {
    const project: Project = { id: 'ws1', name: 'Test', chatIds: ['temp'], trees: [], edges: [], activeTreeId: null, createdAt: 1 };
    const temp = { nodeId: 'temp', projectId: 'ws1', kind: 'chat', chatId: 'temp', messages: [], followUps: [], status: 'idle', temporary: true } as ChatNodeState;
    const row = serializeNodeRow(project, { temp }, 'temp');
    expect(row).not.toHaveProperty('memory_mode');
    expect(row).not.toHaveProperty('temporary');
  });

  it('is marked when Home creates it, and a branch made here takes its parent’s at once', () => {
    let nodes = reduceNodes({}, { type: 'create', nodeId: 'temp', projectId: 'ws1', temporary: true });
    nodes = reduceNodes(nodes, { type: 'create', nodeId: 'plain', projectId: 'ws1' });
    nodes = reduceNodes(nodes, { type: 'create', nodeId: 'temp-branch', projectId: 'ws1', parentNodeId: 'temp' });
    nodes = reduceNodes(nodes, { type: 'create', nodeId: 'plain-branch', projectId: 'ws1', parentNodeId: 'plain' });
    expect(nodes.temp.temporary).toBe(true);
    expect(nodes['temp-branch'].temporary).toBe(true);
    expect(nodes.plain.temporary).toBeUndefined();
    expect(nodes['plain-branch'].temporary).toBeUndefined();
  });
});
