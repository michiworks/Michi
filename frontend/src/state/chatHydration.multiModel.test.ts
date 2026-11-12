import { describe, expect, it } from 'vitest';
import { hydrateBackendWorkspaces } from './chatHydration';

describe('a multi-model branch\'s markers', () => {
  it('are hydrated from the server-owned node columns', () => {
    const state = hydrateBackendWorkspaces([{
      workspace: { id: 'ws1', name: 'Test', created_at: 1 },
      trees: [{ id: 't1', root_node_id: 'caller', created_at: 1, last_active_at: 1 }],
      nodes: [
        { id: 'caller', created_at: 1, kind: 'chat', multi_model_run_id: null, fresh_context: 0 },
        { id: 'fresh', created_at: 2, kind: 'chat', parent_node_id: 'caller', tree_id: 't1', multi_model_run_id: 'wfr_1', fresh_context: 1 },
        { id: 'fork', created_at: 3, kind: 'chat', parent_node_id: 'caller', tree_id: 't1', multi_model_run_id: 'wfr_1', fresh_context: 0 },
      ],
      edges: [], messages: [], artifacts: [],
    }]);
    expect([state.nodes.caller.multiModelRunId, state.nodes.caller.freshContext]).toEqual([undefined, undefined]);
    expect([state.nodes.fresh.multiModelRunId, state.nodes.fresh.freshContext]).toEqual(['wfr_1', true]);
    expect([state.nodes.fork.multiModelRunId, state.nodes.fork.freshContext]).toEqual(['wfr_1', undefined]);
  });
});
